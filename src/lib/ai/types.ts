export type ProviderId = "gemini" | "claude";
export type Effort = "low" | "medium" | "high";

export type Part =
  | { type: "text"; text: string }
  | { type: "pdf"; name: string; base64: string; bytes: number }
  | { type: "image"; mime: "image/png" | "image/jpeg"; base64: string };

export interface CompleteRequest {
  system: string;
  parts: Part[];
  schema: Record<string, unknown>;
  effort: Effort;
  maxTokens: number;
  /** Markiert die PDF-Teile als cachebar (nur Claude nutzt das). */
  cacheDocuments?: boolean;
  signal?: AbortSignal;
  onProgress?: (receivedChars: number) => void;
  /** Statusmeldungen wie „Gemini überlastet – neuer Versuch …“. */
  onStatus?: (message: string) => void;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface CompleteResponse {
  text: string;
  usage: Usage;
  model: string;
}

export interface LLMBackend {
  readonly provider: ProviderId;
  readonly model: string;
  /** Größte Summe an PDF-Rohdaten (Bytes), die in einen Request passt. */
  readonly maxInlineBytes: number;
  complete(req: CompleteRequest): Promise<CompleteResponse>;
}

export type AIErrorKind =
  | "no_key"
  | "budget"
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "refusal"
  | "truncated"
  | "too_large"
  | "invalid_output"
  | "network"
  | "other";

export class AIError extends Error {
  constructor(
    public readonly kind: AIErrorKind,
    message: string,
    public readonly retryAfterSeconds?: number,
    /** Original-Fehlermeldung des Anbieters (für die Fehlersuche). */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "AIError";
  }
}
