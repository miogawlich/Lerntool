import { claudeCostUsd } from "./models";

/**
 * Grobe Seitenzahl einer PDF ohne PDF-Bibliothek: zählt Seitenobjekte.
 * Bei komprimierten Objekt-Streams findet das nichts – dann Schätzung über die Dateigröße.
 */
export function estimatePdfPages(bytes: Uint8Array): number {
  let text = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) text += String.fromCharCode(...bytes.subarray(i, i + chunk));
  const count = (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  if (count > 0) return count;
  return Math.max(1, Math.round(bytes.length / 60_000));
}

/** Laut Anthropic-Doku kostet eine PDF-Seite grob 1.500–3.000 Tokens (Text + Seitenbild). */
const TOKENS_PER_PAGE = 2_500;

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export function estimateClaudeCost(model: string, pages: number, outputTokens: number, extraInputTokens = 2_000): CostEstimate {
  const inputTokens = pages * TOKENS_PER_PAGE + extraInputTokens;
  return { inputTokens, outputTokens, usd: claudeCostUsd(model, inputTokens, outputTokens) };
}
