import { expect, test, type Page } from "@playwright/test";
import { mockGemini } from "./mockGemini";
import { createCourseWithItems, drawStroke, inkAt, line, setupGemini, shot, thicknessAt } from "./helpers";

async function openCanvas(page: Page) {
  await mockGemini(page);
  await setupGemini(page);
  await createCourseWithItems(page);
  await page.getByRole("tab", { name: "Übersicht" }).click();
  await page.getByRole("button", { name: "Alles durchgehen" }).click();
  for (let i = 0; i < 8; i++) {
    await expect(page.getByTestId("progress")).toHaveText(`${i + 1} / 8`);
    if ((await page.locator(".study-head .badge.accent").innerText()) === "Rechen-/Freitextaufgabe") break;
    // Andere Typen schnell überspringen
    const t = await page.locator(".study-head .badge.accent").innerText();
    if (t === "Karteikarte") { await page.getByRole("button", { name: "Antwort zeigen" }).click(); await page.getByRole("button", { name: /^Gut/ }).click(); }
    else if (t === "Multiple Choice") { await page.getByTestId("mc-option").first().click(); await page.getByRole("button", { name: "Prüfen" }).click(); await page.getByRole("button", { name: "Weiter" }).click(); }
    else { await page.getByTestId("self-grade").click(); await page.getByRole("button", { name: /Speichern/ }).click(); }
  }
  await expect(page.getByTestId("ink-canvas")).toBeVisible();
}

test("Stift: feste Dicke, Druck egal, Finger zeichnet nicht", async ({ page }) => {
  await openCanvas(page);
  // Dicke 8 wählen
  await page.getByRole("button", { name: "Strichdicke 8" }).click();
  await expect(page.getByTestId("pen-width")).toHaveText("8 px");
  await drawStroke(page, line(40, 60, 300, 60), "pen", 0.05); // sehr leichter Druck
  await drawStroke(page, line(40, 160, 300, 160), "pen", 1.0); // voller Druck
  const light = await thicknessAt(page, 170, 40, 80);
  const hard = await thicknessAt(page, 170, 140, 180);
  expect(light).toBeGreaterThan(6.5);
  expect(light).toBeLessThan(9.5);
  expect(Math.abs(light - hard)).toBeLessThan(0.6);

  // Dünnerer Stift → dünnere Linie
  await page.getByRole("button", { name: "Strichdicke 1.5" }).click();
  await drawStroke(page, line(40, 260, 300, 260), "pen", 1.0);
  const thin = await thicknessAt(page, 170, 240, 280);
  expect(thin).toBeLessThan(3);

  // Finger zeichnet standardmäßig nicht (Palm-Rejection / Scrollen)
  await drawStroke(page, line(40, 330, 300, 330), "touch");
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-strokes", "3");
  await shot(page, "10-stiftdicke");
});

test("Lasso: mehrere Striche auswählen, verschieben, rückgängig, löschen", async ({ page }) => {
  await openCanvas(page);
  await drawStroke(page, line(60, 60, 160, 60));
  await drawStroke(page, line(60, 90, 160, 90));
  await drawStroke(page, line(400, 300, 500, 300)); // soll NICHT ausgewählt werden
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-strokes", "3");

  await page.getByRole("button", { name: "Lasso" }).click();
  // Schleife um die ersten beiden Striche
  const loop: [number, number][] = [];
  for (let a = 0; a <= 360; a += 10) loop.push([110 + 90 * Math.cos((a * Math.PI) / 180), 75 + 45 * Math.sin((a * Math.PI) / 180)]);
  await drawStroke(page, loop);
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-selected", "2");
  await shot(page, "11-lasso-auswahl");

  // Auswahl um (+250, +150) verschieben
  await drawStroke(page, line(110, 75, 360, 225));
  expect(await inkAt(page, 110, 60)).toBe(false);
  expect(await inkAt(page, 360, 210)).toBe(true);
  expect(await inkAt(page, 450, 300)).toBe(true); // dritter Strich unverändert
  await shot(page, "12-lasso-verschoben");

  // Rückgängig → wieder an alter Stelle
  await page.getByRole("button", { name: "Rückgängig" }).click();
  expect(await inkAt(page, 110, 60)).toBe(true);
  expect(await inkAt(page, 360, 210)).toBe(false);
  await page.getByRole("button", { name: "Wiederholen" }).click();
  expect(await inkAt(page, 360, 210)).toBe(true);

  // Erneut auswählen und löschen
  const loop2 = loop.map(([x, y]) => [x + 250, y + 150] as [number, number]);
  await drawStroke(page, loop2);
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-selected", "2");
  await page.getByRole("button", { name: /Auswahl löschen/ }).click();
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-strokes", "1");
});

test("Radierer entfernt ganze Striche", async ({ page }) => {
  await openCanvas(page);
  await drawStroke(page, line(60, 60, 260, 60));
  await drawStroke(page, line(60, 120, 260, 120));
  await page.getByRole("button", { name: "Radierer" }).click();
  await drawStroke(page, line(150, 40, 150, 75));
  await expect(page.getByTestId("ink-canvas")).toHaveAttribute("data-strokes", "1");
  expect(await inkAt(page, 100, 60)).toBe(false);
  expect(await inkAt(page, 100, 120)).toBe(true);
});
