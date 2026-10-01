import { beforeEach, describe, expect, it } from "vitest";
import { estimateClaudeCost, estimatePdfPages } from "../src/lib/ai/estimate";
import { fetchUsdEurRate, formatEur, formatUsdAsEur, refreshRateIfStale } from "../src/lib/currency";
import { claudeCostThisMonth, getBackendFor, includePdfsForCreate, recordUsage } from "../src/lib/ai";
import { generateItems } from "../src/lib/ai/service";
import { AIError } from "../src/lib/ai/types";
import { db } from "../src/lib/db";
import { DEFAULT_SETTINGS, getSettings, hasActiveKey, providerFor, updateSettings } from "../src/lib/settings";
import { FakeBackend, item, sampleAnalysis } from "./helpers";

beforeEach(async () => {
  updateSettings({ ...DEFAULT_SETTINGS });
  await db.usage.clear();
});

describe("Anbieter pro Zweck", () => {
  it("wählt getrennt für Erstellen und Bewerten", () => {
    updateSettings({ createProvider: "gemini", gradeProvider: "claude", geminiKey: "g", geminiModel: "gemini-x", claudeKey: "" });
    expect(providerFor("create")).toBe("gemini");
    expect(providerFor("grade")).toBe("claude");
    expect(hasActiveKey(getSettings(), "create")).toBe(true);
    expect(hasActiveKey(getSettings(), "grade")).toBe(false);
  });
  it("PDFs werden bei Gemini immer, bei Claude nur auf Wunsch mitgeschickt", () => {
    updateSettings({ createProvider: "gemini" });
    expect(includePdfsForCreate()).toBe(true);
    updateSettings({ createProvider: "claude", sendPdfsWithClaude: false });
    expect(includePdfsForCreate()).toBe(false);
    updateSettings({ sendPdfsWithClaude: true });
    expect(includePdfsForCreate()).toBe(true);
  });
});

describe("Monatsbudget", () => {
  it("summiert nur Claude-Kosten des laufenden Monats", async () => {
    await recordUsage({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 }, "claude-sonnet-5-5", "test"); // 2 $
    await recordUsage({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 }, "gemini-3.0-flash", "test"); // 0 $
    await db.usage.add({ at: new Date(2020, 0, 1).getTime(), provider: "claude", model: "x", purpose: "x", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 50 });
    expect(await claudeCostThisMonth()).toBeCloseTo(2, 5);
  });
  it("sperrt Claude, wenn das Budget erreicht ist – Gemini bleibt nutzbar", async () => {
    updateSettings({ claudeKey: "sk-ant-test", claudeMonthlyBudgetEur: 1, usdToEur: 0.9, geminiKey: "g", geminiModel: "gemini-x" });
    await recordUsage({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 }, "claude-sonnet-5-5", "test");
    const err = await getBackendFor("claude").catch((e) => e);
    expect(err).toBeInstanceOf(AIError);
    expect((err as AIError).kind).toBe("budget");
    expect((err as AIError).message).toContain("Budget");
    await expect(getBackendFor("gemini")).resolves.toBeTruthy();
    updateSettings({ claudeMonthlyBudgetEur: 0 }); // 0 = keine Sperre
    await expect(getBackendFor("claude")).resolves.toBeTruthy();
  });
});

describe("Sparmodus", () => {
  it("ohne Dokumente: keine PDFs, dafür Hinweis an das Modell", async () => {
    const be = new FakeBackend([JSON.stringify({ items: [item("Ableitungen", "flashcard", "F")] })]);
    await generateItems(be, "Ana", [{ topic: sampleAnalysis.topics[1] as any, count: 1, existingPrompts: [] }], sampleAnalysis.recommendedMix, []);
    const parts = be.requests[0].parts;
    expect(parts.some((p) => p.type === "pdf")).toBe(false);
    expect((parts[0] as { text: string }).text).toContain("Sparmodus");
  });
});

describe("Kostenschätzung", () => {
  it("zählt Seitenobjekte in unkomprimierten PDFs", () => {
    const fake = "%PDF-1.4 1 0 obj<</Type /Pages /Count 3>> 2 0 obj<</Type /Page>> 3 0 obj<</Type/Page >> 4 0 obj<</Type /Page/Parent 1 0 R>>";
    expect(estimatePdfPages(new TextEncoder().encode(fake))).toBe(3);
    expect(estimatePdfPages(new Uint8Array(600_000))).toBe(10); // Fallback über Größe
  });
  it("rechnet mit Sonnet-Preisen", () => {
    const e = estimateClaudeCost("claude-sonnet-5-5", 100, 10_000, 0);
    expect(e.inputTokens).toBe(250_000);
    expect(e.usd).toBeCloseTo(0.5 + 0.1, 5);
    expect(formatEur(0.6)).toBe("0,60 €");
    expect(formatEur(0.001)).toBe("< 0,01 €");
    expect(formatUsdAsEur(2, 0.9)).toBe("1,80 €");
  });
});

describe("Euro-Umrechnung", () => {
  const okFetch = (async () => new Response(JSON.stringify({ base: "USD", date: "2026-09-30", rates: { EUR: 0.912 } }))) as unknown as typeof fetch;
  it("Budget gilt in Euro: 1 € Budget ist bei 0,90 €/$ nach ~1,11 $ erreicht", async () => {
    updateSettings({ claudeKey: "sk-ant-test", claudeMonthlyBudgetEur: 1, usdToEur: 0.9 });
    await db.usage.add({ at: Date.now(), provider: "claude", model: "claude-sonnet-5-5", purpose: "t", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 1.05 });
    await expect(getBackendFor("claude")).resolves.toBeTruthy(); // 0,945 € < 1 €
    await db.usage.add({ at: Date.now(), provider: "claude", model: "claude-sonnet-5-5", purpose: "t", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.1 });
    const err = await getBackendFor("claude").catch((e) => e);
    expect((err as AIError).kind).toBe("budget");
    expect((err as AIError).message).toContain("1,00 €");
  });
  it("lädt den EZB-Kurs und speichert Datum + Quelle", async () => {
    expect(await fetchUsdEurRate(okFetch)).toEqual({ rate: 0.912, date: "2026-09-30" });
    expect(await refreshRateIfStale(false, okFetch)).toBe(true);
    expect(getSettings()).toMatchObject({ usdToEur: 0.912, usdToEurDate: "2026-09-30", usdToEurSource: "ecb" });
    // Innerhalb eines Tages kein erneuter Abruf
    expect(await refreshRateIfStale(false, okFetch)).toBe(false);
  });
  it("manueller Kurs wird nicht überschrieben, offline bleibt der alte Kurs", async () => {
    updateSettings({ usdToEur: 0.8, usdToEurSource: "manual", usdToEurFetchedAt: 0 });
    expect(await refreshRateIfStale(false, okFetch)).toBe(false);
    expect(getSettings().usdToEur).toBe(0.8);
    updateSettings({ usdToEurSource: "ecb" });
    const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await refreshRateIfStale(true, offline)).toBe(false);
    expect(getSettings().usdToEur).toBe(0.8);
    const absurd = (async () => new Response(JSON.stringify({ rates: { EUR: 42 } }))) as unknown as typeof fetch;
    await expect(fetchUsdEurRate(absurd)).rejects.toThrow(/Ungültiger/);
  });
});
