import { expect, test, type Page } from "@playwright/test";
import { mockGemini } from "./mockGemini";
import { createCourseWithItems, drawStroke, line, setupGemini, shot } from "./helpers";

async function startSession(page: Page) {
  await mockGemini(page);
  await setupGemini(page);
  await createCourseWithItems(page);
  await page.getByRole("tab", { name: "Übersicht" }).click();
  await page.getByRole("button", { name: "Alles durchgehen" }).click();
  await expect(page.getByTestId("progress")).toHaveText("1 / 8");
}

const typeBadge = (page: Page) => page.locator(".study-head .badge.accent");

test("Vor/Zurück blättern: Entwürfe bleiben erhalten, bewertete Aufgaben zählen nicht doppelt", async ({ page }) => {
  await startSession(page);
  await expect(page.getByTestId("prev")).toBeDisabled();

  // Bis zu einer offenen Aufgabe blättern und einen Entwurf anfangen
  let i = 0;
  while ((await typeBadge(page).innerText()) === "Multiple Choice") {
    await page.getByTestId("next").click();
    i++;
  }
  await expect(page.getByTestId("progress")).toHaveText(`${i + 1} / 8`);
  if ((await typeBadge(page).innerText()) === "Kurzantwort") {
    await page.getByLabel("Antwort").fill("Mein Entwurf");
  } else {
    await drawStroke(page, line(40, 60, 240, 60));
  }
  await page.getByTestId("next").click();
  await expect(page.getByTestId("progress")).toHaveText(`${i + 2} / 8`);
  await page.getByTestId("prev").click();
  await expect(page.getByTestId("progress")).toHaveText(`${i + 1} / 8`);
  if ((await typeBadge(page).innerText()) === "Kurzantwort") await expect(page.getByLabel("Antwort")).toHaveValue("Mein Entwurf");
  else await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-strokes", "1");

  // Selbst bewerten → weiter → zurück: Ergebnis wird angezeigt, keine zweite Abgabe
  await page.getByTestId("self-grade").click();
  await page.getByRole("button", { name: /Speichern/ }).click();
  await expect(page.getByTestId("progress")).toHaveText(`${i + 2} / 8`);
  await page.getByTestId("prev").click();
  await expect(page.getByTestId("saved-result")).toContainText("Bereits bewertet");
  await expect(page.getByTestId("self-grade")).toHaveCount(0);

  // Letzte Aufgabe → Beenden zeigt offene Aufgaben
  await page.getByTestId("question-menu").click();
  await page.getByRole("menuitem", { name: /^Aufgabe 8/ }).click();
  await expect(page.getByTestId("next")).toHaveText("Beenden →");
  await page.getByTestId("next").click();
  await expect(page.getByTestId("session-done")).toContainText("1 Aufgaben bearbeitet");
  await expect(page.getByTestId("session-done")).toContainText("7 noch offen");
  await page.getByRole("button", { name: "Offene Aufgaben bearbeiten" }).click();
  await expect(page.getByTestId("progress")).toHaveText(i === 0 ? "2 / 8" : "1 / 8");
});

test("Flagge: markieren, im Menü anspringen, bleibt gespeichert", async ({ page }) => {
  await startSession(page);
  await page.getByTestId("next").click();
  await page.getByTestId("next").click();
  await expect(page.getByTestId("progress")).toHaveText("3 / 8");
  const prompt3 = (await page.locator(".prompt-card .prompt").textContent())!;
  await page.getByTestId("flag").click();
  await expect(page.getByTestId("flag")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("next").click();

  await page.getByTestId("question-menu").click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Aufgabe 3, markiert" })).toBeVisible();
  await shot(page, "16-aufgabenmenue");
  // Escape schließt das Menü
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  await page.getByTestId("question-menu").click();
  await page.locator(".qmenu-flagged-item").click();
  await expect(page.getByTestId("progress")).toHaveText("3 / 8");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator(".prompt-card .prompt")).toHaveText(prompt3);

  // Markierung ist gespeichert: neue Sitzung zeigt sie wieder
  await page.reload();
  await expect(page.getByTestId("progress")).toHaveText("1 / 8");
  await page.getByTestId("question-menu").click();
  await page.locator(".qmenu-flagged-item").click();
  await expect(page.locator(".prompt-card .prompt")).toHaveText(prompt3);
  await expect(page.getByTestId("flag")).toHaveAttribute("aria-pressed", "true");
  // Entfernen
  await page.getByTestId("flag").click();
  await page.getByTestId("question-menu").click();
  await expect(page.locator(".qmenu-flagged-item")).toHaveCount(0);
});
