import { db } from "../db";
import { getSettings } from "../settings";
import { ClaudeBackend, claudeCostUsd } from "./claude";
import { GeminiBackend } from "./gemini";
import type { CallOptions } from "./service";
import type { LLMBackend, Usage } from "./types";

export function getBackend(): LLMBackend {
  const s = getSettings();
  return s.provider === "claude" ? new ClaudeBackend(s.claudeKey, s.claudeModel) : new GeminiBackend(s.geminiKey, s.geminiModel);
}

export async function recordUsage(usage: Usage, model: string, purpose: string) {
  const provider = getSettings().provider;
  const costUsd = provider === "claude" ? claudeCostUsd(model, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens) : 0;
  await db.usage.add({ at: Date.now(), provider, model, purpose, ...usage, costUsd });
}

export function defaultCallOptions(extra: CallOptions = {}): CallOptions {
  return { ...extra, onUsage: (u, m, p) => void recordUsage(u, m, p) };
}
