import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_CLAUDE_MODEL, FALLBACK_MODELS } from "./models";
import { AIError, type CompleteRequest, type CompleteResponse, type LLMBackend } from "./types";

export class ClaudeBackend implements LLMBackend {
  readonly provider = "claude" as const;
  // 32 MB Request-Limit; Base64 bläht um ~33 % auf → ca. 22 MB Roh-PDF.
  readonly maxInlineBytes = 22 * 1024 * 1024;
  private client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string = DEFAULT_CLAUDE_MODEL,
    opts: { baseURL?: string } = {},
  ) {
    if (!apiKey) throw new AIError("no_key", "Kein Claude-API-Key hinterlegt. Bitte in den Einstellungen eintragen.");
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, baseURL: opts.baseURL });
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const pdfIdx = req.parts.map((p) => p.type).lastIndexOf("pdf");
    const content: Anthropic.Beta.BetaContentBlockParam[] = req.parts.map((p, i) => {
      if (p.type === "text") return { type: "text", text: p.text };
      if (p.type === "image")
        return { type: "image", source: { type: "base64", media_type: p.mime, data: p.base64 } };
      return {
        type: "document",
        title: p.name,
        source: { type: "base64", media_type: "application/pdf", data: p.base64 },
        // Cache-Breakpoint hinter dem letzten Dokument: Folge-Requests mit denselben PDFs werden günstiger.
        ...(req.cacheDocuments && i === pdfIdx ? { cache_control: { type: "ephemeral" as const } } : {}),
      };
    });

    const useFallback = FALLBACK_MODELS.has(this.model);
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content }],
          output_config: {
            effort: req.effort,
            format: { type: "json_schema", schema: req.schema },
          },
          ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: req.signal },
      );
      let chars = 0;
      stream.on("text", (delta) => {
        chars += delta.length;
        req.onProgress?.(chars);
      });
      const msg = await stream.finalMessage();

      if (msg.stop_reason === "refusal") {
        throw new AIError("refusal", "Claude hat die Anfrage abgelehnt. Versuche es mit anderem Material oder einer anderen Formulierung.");
      }
      if (msg.stop_reason === "max_tokens") {
        throw new AIError("truncated", "Die Antwort war zu lang und wurde abgeschnitten. Bitte weniger Themen oder Aufgaben auf einmal erzeugen.");
      }
      const text = msg.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return {
        text,
        model: msg.model,
        usage: {
          inputTokens: (msg.usage.input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
          outputTokens: msg.usage.output_tokens ?? 0,
          cachedInputTokens: msg.usage.cache_read_input_tokens ?? 0,
        },
      };
    } catch (e) {
      throw mapClaudeError(e);
    }
  }
}

export function mapClaudeError(e: unknown): unknown {
  if (e instanceof AIError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    return new AIError("auth", "Der Claude-API-Key ist ungültig oder hat keine Berechtigung.");
  if (e instanceof Anthropic.RateLimitError) {
    const ra = Number(e.headers?.get?.("retry-after"));
    return new AIError("rate_limit", "Claude-Ratenlimit erreicht. Bitte kurz warten.", Number.isFinite(ra) ? ra : undefined);
  }
  if (e instanceof Anthropic.BadRequestError) {
    const msg = e.message ?? "";
    if (/too large|too long|exceed/i.test(msg))
      return new AIError("too_large", "Das Material ist zu groß für eine Anfrage. Bitte PDFs aufteilen.");
    if (/credit|billing|balance/i.test(msg))
      return new AIError("auth", "Dein Anthropic-Konto hat kein Guthaben. Bitte in der Console aufladen.");
    return new AIError("other", `Claude hat die Anfrage abgelehnt (400): ${msg}`);
  }
  if (e instanceof Anthropic.APIConnectionError)
    return new AIError("network", "Keine Verbindung zu Claude. Bist du online?");
  if (e instanceof Anthropic.APIError) {
    if (e.status === 529 || (e.status ?? 0) >= 500)
      return new AIError("overloaded", "Claude ist gerade überlastet. Bitte später erneut versuchen.");
    return new AIError("other", `Claude-Fehler ${e.status}: ${e.message}`);
  }
  return e;
}
