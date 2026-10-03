import { db } from "../db";
import { formatEur, usdToEur } from "../currency";
import { geminiModelFor, getSettings, providerFor, type Purpose } from "../settings";
import { claudeCostUsd } from "./models";
import type { CallOptions } from "./service";
import { AIError, type LLMBackend, type ProviderId, type Usage } from "./types";

/** Summe der Claude-Kosten (in US-Dollar) im laufenden Kalendermonat (aus dem lokalen Verbrauchsprotokoll). */
export async function claudeCostThisMonth(now = new Date()): Promise<number> {
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const rows = await db.usage.where("at").aboveOrEqual(start).toArray();
  return rows.filter((r) => r.provider === "claude").reduce((a, r) => a + r.costUsd, 0);
}

/** Wirft einen verständlichen Fehler, wenn das Monatsbudget für Claude aufgebraucht ist. */
export async function assertClaudeBudget(): Promise<void> {
  const budgetEur = getSettings().claudeMonthlyBudgetEur;
  if (!budgetEur || budgetEur <= 0) return;
  const spentEur = usdToEur(await claudeCostThisMonth());
  if (spentEur >= budgetEur) {
    throw new AIError(
      "budget",
      `Dein Claude-Budget für diesen Monat (${formatEur(budgetEur)}) ist erreicht (verbraucht ca. ${formatEur(spentEur)}). Erhöhe es in den Einstellungen oder nutze Gemini.`,
    );
  }
}

/** Lädt das SDK des Anbieters erst bei Bedarf (kleinerer Start-Download auf dem iPad). */
export async function getBackendFor(provider: ProviderId, purpose: Purpose = "create"): Promise<LLMBackend> {
  const s = getSettings();
  if (provider === "claude") {
    await assertClaudeBudget();
    const { ClaudeBackend } = await import("./claude");
    return new ClaudeBackend(s.claudeKey, s.claudeModel);
  }
  const { GeminiBackend, pickFallbackModels } = await import("./gemini");
  const model = geminiModelFor(purpose, s);
  return new GeminiBackend(s.geminiKey, model, { fallbackModels: pickFallbackModels(s.geminiModels, model) });
}

/** Backend für einen Zweck: „create“ (Analyse/Aufgaben) oder „grade“ (Bewertung). */
export function getBackend(purpose: Purpose): Promise<LLMBackend> {
  return getBackendFor(providerFor(purpose), purpose);
}

/** Sollen bei der Aufgabenerstellung die PDFs mitgeschickt werden? Bei Gemini (gratis) immer, bei Claude nur auf Wunsch. */
export function includePdfsForCreate(): boolean {
  const s = getSettings();
  return s.createProvider === "gemini" || s.sendPdfsWithClaude;
}

export async function recordUsage(usage: Usage, model: string, purpose: string) {
  const provider: ProviderId = model.startsWith("claude") ? "claude" : "gemini";
  const costUsd = provider === "claude" ? claudeCostUsd(model, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens) : 0;
  await db.usage.add({ at: Date.now(), provider, model, purpose, ...usage, costUsd });
}

export function defaultCallOptions(extra: CallOptions = {}): CallOptions {
  return { ...extra, onUsage: (u, m, p) => void recordUsage(u, m, p) };
}
