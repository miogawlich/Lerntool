import { expect, test } from "@playwright/test";
import { mockGemini } from "./mockGemini";
import { createCourseWithItems, drawStroke, line, setupGemini, shot } from "./helpers";

test("Kompletter Ablauf: Einrichten, Upload, Analyse, Generierung, Lernen, Schwächen", async ({ page }) => {
  const log = await mockGemini(page);

  await page.goto("/#/");
  await expect(page.getByText("Noch kein KI-Anbieter eingerichtet")).toBeVisible();
  await shot(page, "01-start");

  await setupGemini(page);
  await page.getByTestId("test-gemini").click();
  await expect(page.getByTestId("settings-msg")).toContainText("Gemini antwortet");
  await shot(page, "02-einstellungen");

  await createCourseWithItems(page);
  // Analyse-Request enthielt beide PDFs inline
  const analyze = log.generate.find((r) => r.system.includes("analysierst"))!;
  expect(analyze.parts.filter((p) => (p as { inlineData?: { mimeType: string } }).inlineData?.mimeType === "application/pdf")).toHaveLength(2);
  expect(analyze.model).toBe("gemini-3.0-flash");
  await expect(page.getByTestId("topic")).toHaveCount(2);
  await page.getByText("Details").first().click();
  await expect(page.locator(".katex").first()).toBeVisible(); // Formeln gerendert
  await shot(page, "03-themen");

  await page.getByRole("tab", { name: "Übersicht" }).click();
  await page.getByTestId("start-due").click();

  // Alle 8 Aufgaben durcharbeiten
  let sawInk = false;
  for (let i = 0; i < 8; i++) {
    await expect(page.getByTestId("progress")).toHaveText(`${i + 1} / 8`);
    const type = await page.locator(".study-head .badge.accent").innerText();
    if (type === "Karteikarte") {
      await page.getByRole("button", { name: "Antwort zeigen" }).click();
      if (i === 0) await shot(page, "04-karteikarte");
      await page.getByRole("button", { name: /^Gut/ }).click();
    } else if (type === "Multiple Choice") {
      // Absichtlich falsch beim ersten Thema → Schwäche
      const wrong = i < 4;
      await page.getByTestId("mc-option").filter({ hasText: wrong ? "Falsche Aussage A" : "Richtige Aussage" }).click();
      await page.getByRole("button", { name: "Prüfen" }).click();
      await expect(page.getByText(wrong ? "Leider falsch." : "Richtig!")).toBeVisible();
      if (wrong) await shot(page, "05-multiple-choice");
      await page.getByRole("button", { name: "Weiter" }).click();
    } else if (type === "Kurzantwort") {
      await page.getByLabel("Antwort").fill("Eine Folge konvergiert, wenn …");
      await page.getByTestId("ai-grade").click();
      await expect(page.getByTestId("ai-result")).toContainText("100 %");
      await page.getByRole("button", { name: "Übernehmen & weiter" }).click();
    } else {
      // Rechenaufgabe mit dem Stift
      await expect(page.getByTestId("ink-canvas")).toBeVisible();
      await drawStroke(page, line(40, 60, 240, 60), "pen");
      await drawStroke(page, line(40, 100, 200, 140), "pen");
      await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-strokes", "2");
      if (!sawInk) await shot(page, "06-handschrift");
      await page.getByTestId("ai-grade").click();
      await expect(page.getByTestId("ai-result")).toContainText("50 %");
      await expect(page.getByTestId("ai-result")).toContainText("Rechenfehler");
      if (!sawInk) await shot(page, "07-ki-bewertung");
      sawInk = true;
      await page.getByRole("button", { name: "Übernehmen & weiter" }).click();
    }
  }
  expect(sawInk).toBe(true);
  // Bewertungs-Request mit Handschrift enthielt ein PNG
  const grade = log.generate.filter((r) => r.system.includes("Korrektor"));
  expect(grade.some((g) => g.parts.some((p) => (p as { inlineData?: { mimeType: string } }).inlineData?.mimeType === "image/png"))).toBe(true);

  await expect(page.getByTestId("session-done")).toContainText("8 Aufgaben bearbeitet");
  await shot(page, "08-fertig");

  // Übersicht zeigt Schwächen
  await page.getByRole("link", { name: "Zur Kursübersicht" }).click();
  await expect(page.getByText("Deine größten Baustellen")).toBeVisible();
  await expect(page.getByText(/(Rechenfehler|Konzeptfehler): \d×/).first()).toBeVisible();
  await shot(page, "09-uebersicht-schwaechen");

  // Schwächen-Aufgaben: Prompt enthält das Feedback aus der KI-Bewertung
  await page.getByRole("tab", { name: "Themen" }).click();
  await page.getByRole("button", { name: "🎯 Schwächen-Aufgaben" }).first().click();
  await expect(page.getByText(/4 neue Aufgaben zu „Folgen und Grenzwerte“ erzeugt/)).toBeVisible();
  const variation = log.generate.at(-1)!;
  const text = variation.parts.map((p) => (p as { text?: string }).text ?? "").join("");
  expect(text).toContain("Schwächen gezeigt");
  expect(text).toContain("Grenzwert ist $2$");

  // Schwächen üben startet eine Session
  await page.getByRole("tab", { name: "Übersicht" }).click();
  await page.getByRole("button", { name: "🎯 Schwächen üben" }).click();
  await expect(page.getByTestId("progress")).toBeVisible();
});

test("Freie Stufe am Limit: verständliche Fehlermeldung statt Absturz", async ({ page }) => {
  await mockGemini(page, { failFirstGenerate: 99 });
  await setupGemini(page);
  await page.getByTestId("test-gemini").click();
  await expect(page.getByRole("alert")).toContainText("Limit der kostenlosen Gemini-Stufe erreicht");
  await expect(page.getByRole("alert")).toContainText("7 s");
});

test("Backup: Export und Import", async ({ page }) => {
  await mockGemini(page);
  await setupGemini(page);
  await createCourseWithItems(page, "Backup-Kurs");
  await page.goto("/#/settings");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Backup exportieren/ }).click()]);
  const path = await download.path();
  // Alles löschen, dann importieren
  await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase("lerntool"); r.onsuccess = r.onerror = r.onblocked = () => res(null); }));
  await page.reload();
  await page.locator('input[type="file"][accept*="json"]').setInputFiles(path!);
  await expect(page.getByTestId("settings-msg")).toContainText("1 Kurse, 8 Aufgaben");
  await page.goto("/#/");
  await expect(page.getByText("Backup-Kurs")).toBeVisible();
});
