/** Modell-Konstanten ohne SDK-Import, damit die SDKs erst bei Bedarf geladen werden. */
export const CLAUDE_MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (empfohlen)", inputPerM: 2, outputPerM: 10 },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (stärker, teurer)", inputPerM: 4, outputPerM: 20 },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (günstig, schwächer)", inputPerM: 1, outputPerM: 5 },
] as const;

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";

// Für die Fallback-Beta laut Anthropic-Doku: Opus 5.5, Sonnet 5.5 (nur "default"-Form), Fable 5.1.
export const FALLBACK_MODELS = new Set(["claude-sonnet-5-5", "claude-opus-5-5"]);

export function claudeCostUsd(model: string, inputTokens: number, outputTokens: number, cachedTokens = 0): number {
  const m = CLAUDE_MODELS.find((x) => x.id === model) ?? CLAUDE_MODELS[0];
  const uncached = Math.max(0, inputTokens);
  return (uncached * m.inputPerM + cachedTokens * m.inputPerM * 0.1 + outputTokens * m.outputPerM) / 1_000_000;
}

