import { ApiError, GoogleGenAI, type Part as GPart } from "@google/genai";
import { AIError, type CompleteRequest, type CompleteResponse, type LLMBackend } from "./types";

// Inline-Daten sind laut Gemini-Doku auf ca. 20 MB pro Request begrenzt (Base64 eingerechnet).
const INLINE_LIMIT = 14 * 1024 * 1024;

export class GeminiBackend implements LLMBackend {
  readonly provider = "gemini" as const;
  readonly maxInlineBytes = INLINE_LIMIT;
  private ai: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    if (!apiKey) throw new AIError("no_key", "Kein Gemini-API-Key hinterlegt. Bitte in den Einstellungen eintragen.");
    if (!model) throw new AIError("other", "Kein Gemini-Modell gewählt. Bitte in den Einstellungen ein Modell auswählen.");
    this.ai = new GoogleGenAI({ apiKey });
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const parts: GPart[] = req.parts.map((p) => {
      if (p.type === "text") return { text: p.text };
      if (p.type === "image") return { inlineData: { mimeType: p.mime, data: p.base64 } };
      return { inlineData: { mimeType: "application/pdf", data: p.base64 } };
    });
    try {
      const res = await this.ai.models.generateContent({
        model: this.model,
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
        model: this.model,
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

export function mapGeminiError(e: unknown): unknown {
  if (e instanceof AIError) return e;
  if (e instanceof ApiError) {
    const msg = e.message ?? "";
    if (e.status === 400 && /api key|API_KEY/i.test(msg))
      return new AIError("auth", "Der Gemini-API-Key ist ungültig.");
    if (e.status === 401 || e.status === 403) return new AIError("auth", "Der Gemini-API-Key ist ungültig oder hat keine Berechtigung.");
    if (e.status === 429) {
      const m = msg.match(/retry in ([\d.]+)s/i) ?? msg.match(/"retryDelay":\s*"(\d+)s"/);
      const secs = m ? Math.ceil(Number(m[1])) : undefined;
      return new AIError(
        "rate_limit",
        `Limit der kostenlosen Gemini-Stufe erreicht${secs ? ` – bitte ca. ${secs} s warten` : " – bitte etwas warten (Minuten- oder Tageslimit)"}.`,
        secs,
      );
    }
    if (e.status === 413 || /too large|exceeds/i.test(msg))
      return new AIError("too_large", "Das Material ist zu groß für eine Anfrage. Bitte PDFs aufteilen.");
    if (e.status >= 500) return new AIError("overloaded", "Gemini ist gerade überlastet. Bitte später erneut versuchen.");
    return new AIError("other", `Gemini-Fehler ${e.status}: ${msg}`);
  }
  if (e instanceof TypeError && /fetch/i.test(e.message)) return new AIError("network", "Keine Verbindung zu Gemini. Bist du online?");
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
  const rank = (id: string) =>
    version(id) * 100 + (stable(id) ? 10 : 0) + (/flash/.test(id) && !/lite/.test(id) ? 5 : /pro/.test(id) ? 2 : 0);
  return [...ids].sort((a, b) => rank(b) - rank(a))[0];
}
