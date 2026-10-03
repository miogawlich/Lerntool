import { ApiError, GoogleGenAI, type Part as GPart } from "@google/genai";
import { AIError, type CompleteRequest, type CompleteResponse, type LLMBackend } from "./types";

// Inline-Daten sind laut Gemini-Doku auf ca. 20 MB pro Request begrenzt (Base64 eingerechnet).
const INLINE_LIMIT = 14 * 1024 * 1024;

/** Minimale Schnittstelle des SDK-Clients (für Tests austauschbar). */
interface GenerateClient {
  models: { generateContent: GoogleGenAI["models"]["generateContent"] };
}

export interface GeminiOptions {
  /** Ausweichmodelle, falls das gewählte Modell überlastet, limitiert oder nicht verfügbar ist. */
  fallbackModels?: string[];
  client?: GenerateClient;
  /** Wartezeiten in ms zwischen zwei Runden über alle Modelle. */
  retryDelaysMs?: number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** Fehler, bei denen ein anderes Modell (oder ein späterer Versuch) helfen kann. */
const RETRYABLE = new Set(["overloaded", "server", "rate_limit", "model_unavailable"]);
/** Wie lange ein Ausweichmodell, das funktioniert hat, bevorzugt wird. */
const STICKY_MS = 15 * 60_000;

// Gilt für alle Backend-Instanzen der Sitzung (die App erzeugt pro Aufruf ein neues Backend).
let preferred: { primary: string; model: string; until: number } | undefined;
const unavailable = new Set<string>();

/** Nur für Tests. */
export function resetGeminiState() {
  preferred = undefined;
  unavailable.clear();
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Abgebrochen", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Abgebrochen", "AbortError"));
    });
  });
}

export class GeminiBackend implements LLMBackend {
  readonly provider = "gemini" as const;
  readonly maxInlineBytes = INLINE_LIMIT;
  // Gemini antwortet erst, wenn alles fertig ist. Live gemessen (8 PDFs, 1,7 MB): erstes Byte nach 113 s.
  // Kleine Requests bleiben unter Safaris ca. 60 s Wartezeit.
  readonly batchBytes = 1024 * 1024;
  readonly maxItemsPerRequest = 8;
  private ai: GenerateClient;
  private fallbacks: string[];
  private delays: number[];
  private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private now: () => number;

  constructor(
    apiKey: string,
    readonly model: string,
    opts: GeminiOptions = {},
  ) {
    if (!apiKey) throw new AIError("no_key", "Kein Gemini-API-Key hinterlegt. Bitte in den Einstellungen eintragen.");
    if (!model) throw new AIError("other", "Kein Gemini-Modell gewählt. Bitte in den Einstellungen ein Modell auswählen.");
    // Wiederholversuche steuern wir selbst (sichtbar im Fortschritt, mit Ausweichmodell).
    this.ai = opts.client ?? new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
    this.fallbacks = [...new Set(opts.fallbackModels ?? [])].filter((m) => m !== model);
    this.delays = opts.retryDelaysMs ?? [5_000, 15_000];
    this.sleep = opts.sleep ?? sleepFor;
    this.now = opts.now ?? Date.now;
  }

  /** Reihenfolge der Modelle: zuletzt bewährtes Ausweichmodell zuerst, nicht verfügbare raus. */
  private chain(): string[] {
    const all = [this.model, ...this.fallbacks];
    const p = preferred;
    if (p && p.primary === this.model && p.until > this.now() && all.includes(p.model)) {
      all.splice(all.indexOf(p.model), 1);
      all.unshift(p.model);
    }
    return all.filter((m) => !unavailable.has(m));
  }

  /**
   * Google meldet bei Überlastung 503, oft nur für einzelne Modelle und nur kurz.
   * Deshalb pro Runde jedes Modell einmal versuchen (gewähltes zuerst) und erst
   * zwischen den Runden warten, statt lange am selben Modell zu hängen.
   */
  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    let lastErr: unknown;
    let rateLimited: unknown;
    let serverErrors = 0;
    for (let round = 0; round <= this.delays.length; round++) {
      const models = this.chain();
      if (!models.length) break;
      let overloadedThisRound = false;
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        try {
          const res = await this.once(model, req);
          if (model !== this.model) preferred = { primary: this.model, model, until: this.now() + STICKY_MS };
          else if (preferred?.primary === this.model) preferred = undefined;
          return res;
        } catch (e) {
          const kind = e instanceof AIError ? e.kind : "";
          if (!RETRYABLE.has(kind) || req.signal?.aborted) throw e;
          if (kind === "model_unavailable") unavailable.add(model);
          else if (kind === "rate_limit") rateLimited = e;
          else {
            lastErr = e;
            overloadedThisRound = true;
            // Interne Fehler (500) kommen meist von zu großem Material: nur einmal wiederholen,
            // danach teilt die Analyse das Material auf.
            if (kind === "server" && ++serverErrors >= 2) throw e;
          }
          const next = models[i + 1];
          if (next) req.onStatus?.(`${model}: ${shortReason(e as AIError)} – weiche auf ${next} aus …`);
        }
      }
      // Nur Limits/nicht verfügbare Modelle: Warten hilft hier nicht.
      if (!overloadedThisRound) break;
      if (round < this.delays.length) {
        const wait = this.delays[round];
        req.onStatus?.(`Gemini ist gerade überlastet – neuer Versuch in ${Math.round(wait / 1000)} s (${round + 2}/${this.delays.length + 1}) …`);
        await this.sleep(wait, req.signal);
      }
    }
    // Waren alle Modelle nur limitiert, ist das die hilfreichere Meldung.
    throw lastErr ?? rateLimited ?? new AIError("model_unavailable", `Keines der Gemini-Modelle ist verfügbar. Bitte in den Einstellungen neu verbinden.`);
  }

  private async once(model: string, req: CompleteRequest): Promise<CompleteResponse> {
    const parts: GPart[] = req.parts.map((p) => {
      if (p.type === "text") return { text: p.text };
      if (p.type === "image") return { inlineData: { mimeType: p.mime, data: p.base64 } };
      return { inlineData: { mimeType: "application/pdf", data: p.base64 } };
    });
    try {
      const res = await this.ai.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          responseJsonSchema: req.schema,
          maxOutputTokens: req.maxTokens,
          abortSignal: req.signal,
        },
      });
      const cand = res.candidates?.[0];
      const reason = cand?.finishReason ?? "";
      if (res.promptFeedback?.blockReason || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION"].includes(reason)) {
        throw new AIError("refusal", "Gemini hat die Anfrage blockiert. Versuche es mit anderem Material.");
      }
      if (reason === "MAX_TOKENS") {
        throw new AIError("truncated", "Die Antwort war zu lang und wurde abgeschnitten. Bitte weniger Themen oder Aufgaben auf einmal erzeugen.");
      }
      const text = res.text ?? "";
      req.onProgress?.(text.length);
      const u = res.usageMetadata;
      return {
        text,
        model,
        usage: {
          inputTokens: u?.promptTokenCount ?? 0,
          outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
          cachedInputTokens: u?.cachedContentTokenCount ?? 0,
        },
      };
    } catch (e) {
      throw mapGeminiError(e);
    }
  }
}

function shortReason(e: AIError): string {
  if (e.kind === "rate_limit") return "Limit erreicht";
  if (e.kind === "model_unavailable") return "nicht verfügbar";
  if (e.kind === "server") return "interner Fehler";
  return "überlastet";
}

/** Kurzfassung der Google-Fehlermeldung (die oft als JSON-String kommt). */
function googleMessage(e: { message?: string }): string {
  const raw = e.message ?? "";
  try {
    const j = JSON.parse(raw.slice(raw.indexOf("{")));
    return (j.error?.message ?? raw).slice(0, 400);
  } catch {
    return raw.slice(0, 400);
  }
}

export function mapGeminiError(e: unknown): unknown {
  if (e instanceof AIError) return e;
  if (e instanceof ApiError) {
    const msg = e.message ?? "";
    const detail = `HTTP ${e.status}: ${googleMessage(e)}`;
    if (e.status === 400 && /api key|API_KEY/i.test(msg))
      return new AIError("auth", "Der Gemini-API-Key ist ungültig.", undefined, detail);
    if (e.status === 401 || e.status === 403) return new AIError("auth", "Der Gemini-API-Key ist ungültig oder hat keine Berechtigung.", undefined, detail);
    if (e.status === 429) {
      if (/PerDay/i.test(msg))
        return new AIError(
          "rate_limit",
          `Tageslimit der kostenlosen Gemini-Stufe erreicht (auch bei den Ausweichmodellen). Das Kontingent wird ${formatQuotaReset(nextQuotaReset())} zurückgesetzt. Bis dahin: selbst bewerten, in den Einstellungen ein „Flash-Lite“-Modell wählen (größeres Kontingent) oder Claude nutzen.`,
          undefined,
          detail,
        );
      const m = msg.match(/retry in ([\d.]+)s/i) ?? msg.match(/"retryDelay":\s*"(\d+)s"/);
      const secs = m ? Math.ceil(Number(m[1])) : undefined;
      return new AIError(
        "rate_limit",
        `Limit der kostenlosen Gemini-Stufe erreicht${secs ? ` – bitte ca. ${secs} s warten` : " – bitte etwas warten (Minuten- oder Tageslimit)"}.`,
        secs,
        detail,
      );
    }
    if (e.status === 404)
      return new AIError("model_unavailable", "Das gewählte Gemini-Modell ist nicht (mehr) verfügbar. Bitte in den Einstellungen neu verbinden und ein anderes Modell wählen.", undefined, detail);
    if (e.status === 413 || /too large|exceeds|payload size/i.test(msg))
      return new AIError("too_large", "Das Material ist zu groß für eine Anfrage. Bitte PDFs aufteilen.", undefined, detail);
    if (e.status === 503 || e.status === 504)
      return new AIError("overloaded", "Gemini ist gerade überlastet (auch nach mehreren Versuchen und mit Ausweichmodell). Bitte in ein paar Minuten erneut versuchen oder in den Einstellungen ein anderes Modell wählen.", undefined, detail);
    if (e.status >= 500)
      return new AIError("server", "Bei Google ist ein interner Fehler aufgetreten. Das passiert oft bei sehr großen PDFs – versuche es mit weniger oder kleineren Dateien.", undefined, detail);
    return new AIError("other", `Gemini-Fehler ${e.status}: ${googleMessage(e)}`, undefined, detail);
  }
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) return new AIError(
      "network",
      "Die Verbindung zu Gemini ist abgebrochen. Entweder bist du offline, die App war zwischendurch im Hintergrund, oder Gemini hat zu lange (über ca. 60 s) nicht geantwortet.",
      undefined,
      e.message,
    );
  return e;
}

/**
 * Die Tageskontingente der Gemini-API werden um Mitternacht pazifischer Zeit zurückgesetzt
 * (in Deutschland 9:00 Uhr, bei abweichender Sommerzeit-Umstellung kurzzeitig 8:00 Uhr).
 */
export function nextQuotaReset(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // Manche Engines liefern um Mitternacht „24“ statt „00“.
  const elapsed = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() + 86_400_000 - elapsed);
}

export function formatQuotaReset(at: Date, now = new Date()): string {
  const time = at.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const sameDay = at.toDateString() === now.toDateString();
  return `${sameDay ? "heute" : "morgen"} um ${time} Uhr`;
}

export interface GeminiModelInfo {
  id: string;
  label: string;
}

/** Listet Modelle, die generateContent unterstützen – damit keine veralteten Namen fest im Code stehen. */
export async function listGeminiModels(apiKey: string): Promise<GeminiModelInfo[]> {
  const ai = new GoogleGenAI({ apiKey });
  const out: GeminiModelInfo[] = [];
  try {
    const pager = await ai.models.list({ config: { pageSize: 100 } });
    for await (const m of pager) {
      const id = (m.name ?? "").replace(/^models\//, "");
      const actions = m.supportedActions ?? [];
      if (!id.startsWith("gemini") || !actions.includes("generateContent")) continue;
      if (/(image|tts|audio|live|embedding|vision|robotics|computer-use|native)/i.test(id)) continue;
      out.push({ id, label: m.displayName ? `${m.displayName} (${id})` : id });
    }
  } catch (e) {
    throw mapGeminiError(e);
  }
  return out;
}

export { pickDefaultGeminiGradeModel, pickDefaultGeminiModel, pickFallbackModels } from "./geminiModels";
