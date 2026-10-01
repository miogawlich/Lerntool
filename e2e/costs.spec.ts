import { expect, test } from "@playwright/test";
import { mockGemini } from "./mockGemini";
import { mockClaude } from "./mockClaude";
import { createCourseWithItems, drawStroke, line, setupGemini, shot } from "./helpers";

test("Erstellen mit Gemini, Bewerten mit Claude, Budgetsperre", async ({ page }) => {
  const gemini = await mockGemini(page);
  const claude = await mockClaude(page, {
    transcription: "$\\frac{2n+1}{n} \\to 2$", score: 1, verdict: "correct", errorType: "none", feedback: "Richtig.", missedConcepts: [],
  });
  await setupGemini(page);
  await page.getByTestId("claude-key").fill("sk-ant-test");
  await page.getByTestId("grade-claude").click();
  await page.getByTestId("claude-budget").fill("1");
  await shot(page, "13-einstellungen-ki-wofuer");

  // Erstellen läuft weiter über Gemini
  await createCourseWithItems(page);
  expect(gemini.generate.length).toBeGreaterThan(0);
  expect(claude.requests).toHaveLength(0);

  // Bewerten über Claude
  await page.getByRole("tab", { name: "Übersicht" }).click();
  await page.getByRole("button", { name: "Alles durchgehen" }).click();
  for (let i = 0; i < 8; i++) {
    await expect(page.getByTestId("progress")).toHaveText(`${i + 1} / 8`);
    if ((await page.locator(".study-head .badge.accent").innerText()) === "Rechen-/Freitextaufgabe") break;
    const t = await page.locator(".study-head .badge.accent").innerText();
    if (t === "Karteikarte") { await page.getByRole("button", { name: "Antwort zeigen" }).click(); await page.getByRole("button", { name: /^Gut/ }).click(); }
    else if (t === "Multiple Choice") { await page.getByTestId("mc-option").first().click(); await page.getByRole("button", { name: "Prüfen" }).click(); await page.getByRole("button", { name: "Weiter" }).click(); }
    else { await page.getByTestId("self-grade").click(); await page.getByRole("button", { name: /Speichern/ }).click(); }
  }
  await drawStroke(page, line(40, 60, 240, 60));
  await page.getByTestId("ai-grade").click();
  await expect(page.getByTestId("ai-result")).toContainText("100 %");
  expect(claude.requests).toHaveLength(1);
  const r = claude.requests[0];
  expect(r.body.model).toBe("claude-sonnet-5-5");
  expect(r.body.output_config.format.type).toBe("json_schema");
  expect(r.body.messages[0].content[0].type).toBe("image");
  expect(r.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  expect(r.headers["x-api-key"]).toBe("sk-ant-test");

  // Verbrauch wird erfasst; mit winzigem Budget sperrt die App weitere Claude-Aufrufe
  await page.goto("/#/settings");
  await expect(page.getByTestId("claude-month")).toContainText("verbraucht: ca. < 0,01 €");
  await expect(page.getByTestId("claude-month")).toContainText("von 1,00 €");
  await expect(page.getByTestId("rate-info")).toContainText("1 $ = 0,9 €");
  await expect(page.getByTestId("rate-info")).toContainText("EZB-Referenzkurs vom 30.9.2026");
});

test("Budget erreicht: verständliche Meldung statt Claude-Aufruf", async ({ page }) => {
  await mockGemini(page);
  const claude = await mockClaude(page, { transcription: "", score: 1, verdict: "correct", errorType: "none", feedback: "ok", missedConcepts: [] });
  await setupGemini(page);
  await page.getByTestId("claude-key").fill("sk-ant-test");
  await page.getByTestId("claude-budget").fill("0.001");
  await expect(page.locator("label", { hasText: "Monatsbudget in €" })).toBeVisible();
  await page.getByTestId("test-claude").click(); // erster Aufruf geht durch und verbraucht > Budget
  await expect(page.getByTestId("settings-msg")).toContainText("Claude antwortet");
  await page.getByTestId("test-claude").click();
  await expect(page.getByRole("alert")).toContainText("Claude-Budget für diesen Monat (< 0,01 €)");
  expect(claude.requests).toHaveLength(1);
});
