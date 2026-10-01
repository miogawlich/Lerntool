import { db } from "../db";
import { getSettings } from "../settings";
import { claudeCostUsd } from "./models";
import type { CallOptions } from "./service";
import type { LLMBackend, Usage } from "./types";

/** Lädt das SDK des gewählten Anbieters erst bei Bedarf (kleinerer Start-Download auf dem iPad). */
export async function getBackend(): Promise<LLMBackend> {
  const s = getSettings();
  if (s.provider === "claude") {
    const { ClaudeBackend } = await import("./claude");
    return new ClaudeBackend(s.claudeKey, s.claudeModel);
  }
  const { GeminiBackend } = await import("./gemini");
  return new GeminiBackend(s.geminiKey, s.geminiModel);
}

export async function recordUsage(usage: Usage, model: string, purpose: string) {
  const provider = getSettings().provider;
  const costUsd = provider === "claude" ? claudeCostUsd(model, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens) : 0;
  await db.usage.add({ at: Date.now(), provider, model, purpose, ...usage, costUsd });
}

export function defaultCallOptions(extra: CallOptions = {}): CallOptions {
  return { ...extra, onUsage: (u, m, p) => void recordUsage(u, m, p) };
}
