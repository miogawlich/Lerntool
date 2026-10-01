import { ApiError, GoogleGenAI, type Part as GPart } from "@google/genai";
import { AIError, type CompleteRequest, type CompleteResponse, type LLMBackend } from "./types";

// Inline-Daten sind laut Gemini-Doku auf ca. 20 MB pro Request begrenzt (Base64 eingerechnet).
const INLINE_LIMIT = 14 * 1024 * 1024;

/** Minimale Schnittstelle des SDK-Clients (für Tests austauschbar). */
interface GenerateClient {
  models: { generateContent: GoogleGenAI["models"]["generateContent"] };
}

export interface GeminiOptions {
  /** Ausweichmodelle, falls das gewählte Modell dauerhaft überlastet ist. */
  fallbackModels?: string[];
  client?: GenerateClient;
  /** Wartezeiten vor Wiederholversuchen in ms (bei Überlastung). */
  retryDelaysMs?: number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const RETRYABLE = new Set(["overloaded", "server"]);

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
  private ai: GenerateClient;
  private fallbacks: string[];
  private delays: number[];
  private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    apiKey: string,
    readonly model: string,
    opts: GeminiOptions = {},
  ) {
    if (!apiKey) throw new AIError("no_key", "Kein Gemini-API-Key hinterlegt. Bitte in den Einstellungen eintragen.");
    if (!model) throw new AIError("other", "Kein Gemini-Modell gewählt. Bitte in den Einstellungen ein Modell auswählen.");
    // Wiederholversuche steuern wir selbst (sichtbar im Fortschritt, mit Ausweichmodell).
    this.ai = opts.client ?? new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
    this.fallbacks = (opts.fallbackModels ?? []).filter((m) => m !== model).slice(0, 2);
    this.delays = opts.retryDelaysMs ?? [2_000, 6_000];
    this.sleep = opts.sleep ?? sleepFor;
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const models = [this.model, ...this.fallbacks];
    let lastErr: unknown;
    for (let m = 0; m < models.length; m++) {
      const model = models[m];
      if (m > 0) req.onStatus?.(`${models[m - 1]} ist überlastet – weiche auf ${model} aus …`);
      for (let attempt = 0; attempt <= this.delays.length; attempt++) {
        try {
          return await this.once(model, req);
        } catch (e) {
          lastErr = e;
          const kind = e instanceof AIError ? e.kind : "";
          if (!RETRYABLE.has(kind) || req.signal?.aborted) throw e;
          if (attempt < this.delays.length) {
            const wait = this.delays[attempt];
            req.onStatus?.(`Gemini antwortet gerade nicht (${(e as AIError).detail?.slice(0, 60) ?? kind}) – neuer Versuch in ${Math.round(wait / 1000)} s …`);
            await this.sleep(wait, req.signal);
          }
        }
      }
    }
    throw lastErr;
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
      const m = msg.match(/retry in ([\d.]+)s/i) ?? msg.match(/"retryDelay":\s*"(\d+)s"/);
      const secs = m ? Math.ceil(Number(m[1])) : undefined;
      return new AIError(
        "rate_limit",
        `Limit der kostenlosen Gemini-Stufe erreicht${secs ? ` – bitte ca. ${secs} s warten` : " – bitte etwas warten (Minuten- oder Tageslimit)"}.`,
        secs,
        detail,
      );
    }
    if (e.status === 413 || /too large|exceeds|payload size/i.test(msg))
      return new AIError("too_large", "Das Material ist zu groß für eine Anfrage. Bitte PDFs aufteilen.", undefined, detail);
    if (e.status === 503 || e.status === 504)
      return new AIError("overloaded", "Gemini ist gerade überlastet (auch nach mehreren Versuchen und mit Ausweichmodell). Bitte in ein paar Minuten erneut versuchen oder in den Einstellungen ein anderes Modell wählen.", undefined, detail);
    if (e.status >= 500)
      return new AIError("server", "Bei Google ist ein interner Fehler aufgetreten. Das passiert oft bei sehr großen PDFs – versuche es mit weniger oder kleineren Dateien.", undefined, detail);
    return new AIError("other", `Gemini-Fehler ${e.status}: ${googleMessage(e)}`, undefined, detail);
  }
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) return new AIError("network", "Keine Verbindung zu Gemini. Bist du online?", undefined, e.message);
  return e;
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

/** Wählt ein sinnvolles Standardmodell: neueste „flash“-Version (gutes Free-Tier-Kontingent), sonst neuestes „pro“. */
export function pickDefaultGeminiModel(ids: string[]): string | undefined {
  const version = (id: string) => {
    const m = id.match(/gemini-(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : 0;
  };
  const stable = (id: string) => !/(preview|exp|latest)/.test(id);
  // Stabile Modelle zuerst (Previews sind im Free Tier oft überlastet), dann neueste Version, dann Flash vor Pro.
  const rank = (id: string) =>
    (stable(id) ? 100_000 : 0) + version(id) * 100 + (/flash/.test(id) && !/lite/.test(id) ? 5 : /pro/.test(id) ? 2 : /lite/.test(id) ? 1 : 0);
  return [...ids].sort((a, b) => rank(b) - rank(a))[0];
}

/** Ausweichmodelle: andere stabile Flash-Modelle, neueste zuerst. */
export function pickFallbackModels(ids: string[], current: string): string[] {
  const stable = ids.filter((id) => id !== current && /flash/.test(id) && !/(preview|exp|latest)/.test(id));
  const out: string[] = [];
  let rest = stable;
  while (rest.length && out.length < 2) {
    const best = pickDefaultGeminiModel(rest)!;
    out.push(best);
    rest = rest.filter((x) => x !== best);
  }
  return out;
}
