import { expect, test } from "@playwright/test";
import { mockGemini } from "./mockGemini";
import { makePdf, setupGemini, shot } from "./helpers";

async function courseWithPdf(page: import("@playwright/test").Page) {
  await page.goto("/#/");
  await page.getByLabel("Kursname").fill("Stresstest");
  await page.getByRole("button", { name: "Kurs anlegen" }).click();
  await page.getByRole("tab", { name: "Material" }).click();
  await page.getByTestId("file-input").setInputFiles({ name: "folien.pdf", mimeType: "application/pdf", buffer: await makePdf("Folien", ["Inhalt"]) });
}

test("Gemini überlastet: zwei Wiederholversuche, dann klappt die Analyse", async ({ page }) => {
  test.setTimeout(60_000);
  const log = await mockGemini(page);
  await setupGemini(page);
  await courseWithPdf(page);
  // Ab jetzt die nächsten 2 Anfragen mit 503 beantworten
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const log2 = await mockGemini(page, { failFirstGenerate: 2, failStatus: 503 });
  await page.getByTestId("analyze").click();
  await expect(page.getByTestId("busy-step")).toContainText("neuer Versuch");
  await expect(page.getByText("Analyse fertig: 2 neue Themen")).toBeVisible({ timeout: 30_000 });
  expect(log2.generate).toHaveLength(3);
  expect(log.generate).toHaveLength(0);
});

test("Gemini dauerhaft überlastet: Ausweichmodell und am Ende Fehler mit Google-Text", async ({ page }) => {
  test.setTimeout(90_000);
  await mockGemini(page);
  await setupGemini(page);
  await courseWithPdf(page);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const log = await mockGemini(page, { failFirstGenerate: 99, failStatus: 503 });
  await page.getByTestId("analyze").click();
  await expect(page.getByRole("alert")).toContainText("überlastet", { timeout: 80_000 });
  // gewähltes Modell + Ausweichmodell, reihum in 4 Runden
  expect(log.generate.map((g) => g.model).slice(0, 4)).toEqual(["gemini-3.0-flash", "gemini-2.5-flash", "gemini-3.0-flash", "gemini-2.5-flash"]);
  expect(log.generate).toHaveLength(8); // 2 Modelle × 4 Runden
  await page.getByText("Technische Details").click();
  await expect(page.getByTestId("error-detail")).toHaveText("HTTP 503: The model is overloaded. Please try again later.");
  await shot(page, "14-fehler-details");
});

test("Preview-Modell wird beim Verbinden durch stabiles ersetzt", async ({ page }) => {
  await mockGemini(page);
  await setupGemini(page); // prüft gemini-3.0-flash statt gemini-3.5-flash-preview
  await page.getByTestId("gemini-model").selectOption("gemini-3.5-flash-preview");
  await expect(page.getByTestId("preview-warning")).toBeVisible();
});

test("Kurs löschen per langem Drücken, kurzes Tippen öffnet weiterhin", async ({ page }) => {
  await page.goto("/#/");
  for (const n of ["Behalten", "Wegwerfen"]) {
    await page.getByLabel("Kursname").fill(n);
    await page.getByRole("button", { name: "Kurs anlegen" }).click();
    await page.getByTestId("back").click();
  }
  const card = page.getByTestId("course-card").filter({ hasText: "Wegwerfen" });
  // kurzes Tippen → öffnet
  await card.click();
  await expect(page.getByRole("heading", { name: "Wegwerfen" })).toBeVisible();
  await page.getByTestId("back").click();
  // lange drücken
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 30);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(page).toHaveURL(/#\/$/); // nicht navigiert
  await shot(page, "15-lange-gedrueckt");
  await page.getByTestId("course-delete").click();
  await expect(page.getByRole("dialog")).toContainText("„Wegwerfen“ löschen?");
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("course-card")).toHaveCount(1);
  await expect(page.getByTestId("course-card")).toContainText("Behalten");
});

test("Zurück-Button bleibt beim Scrollen sichtbar", async ({ page }) => {
  await mockGemini(page);
  await setupGemini(page);
  await page.mouse.wheel(0, 3000);
  await page.waitForTimeout(300);
  await expect(page.getByTestId("back")).toBeInViewport();
  const h = await page.getByTestId("back").boundingBox();
  expect(h!.height).toBeGreaterThanOrEqual(44);
  await shot(page, "16-zurueck-button");
  await page.getByTestId("back").click();
  await expect(page.getByRole("heading", { name: "Meine Kurse" })).toBeVisible();
});
