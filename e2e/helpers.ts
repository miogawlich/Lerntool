import { expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdirSync } from "node:fs";

mkdirSync("screenshots", { recursive: true });
export const shot = (page: Page, name: string) => page.screenshot({ path: `screenshots/${name}.png`, fullPage: false });

export async function makePdf(title: string, lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText(title, { x: 50, y: 780, size: 22, font });
  lines.forEach((l, i) => page.drawText(l, { x: 50, y: 740 - i * 22, size: 13, font }));
  return Buffer.from(await doc.save());
}

export async function setupGemini(page: Page) {
  await page.goto("/#/settings");
  await page.getByTestId("gemini-key").fill("test-key-123");
  await page.getByTestId("gemini-connect").click();
  await expect(page.getByTestId("settings-msg")).toContainText("Verbunden");
  await expect(page.getByTestId("gemini-model")).toHaveValue("gemini-3.0-flash");
}

/** Legt einen Kurs mit Material, Themen und Aufgaben über die Oberfläche an. */
export async function createCourseWithItems(page: Page, name = "Analysis I") {
  await page.goto("/#/");
  await page.getByLabel("Kursname").fill(name);
  await page.getByRole("button", { name: "Kurs anlegen" }).click();
  await page.getByRole("tab", { name: "Material" }).click();
  await page.getByTestId("file-input").setInputFiles({ name: "folien.pdf", mimeType: "application/pdf", buffer: await makePdf("Folgen", ["Definition Konvergenz", "Beispiel 1/n"]) });
  await page.getByRole("button", { name: /Altklausur/ }).first().click();
  await page.getByTestId("file-input").setInputFiles({ name: "klausur-2024.pdf", mimeType: "application/pdf", buffer: await makePdf("Klausur WS 24", ["Aufgabe 1: Grenzwert (10 P.)"]) });
  await page.getByTestId("analyze").click();
  await expect(page.getByText("Analyse fertig: 2 neue Themen")).toBeVisible();
  await page.getByRole("tab", { name: "Themen" }).click();
  await page.getByLabel("Alle").check();
  await page.getByTestId("generate").click();
  await expect(page.getByText("8 neue Aufgaben erzeugt.")).toBeVisible();
}

/** Zeichnet einen Strich auf das Canvas mit echtem PointerEvent (Typ wählbar, Druck wählbar). */
export async function drawStroke(page: Page, points: [number, number][], pointerType: "pen" | "touch" | "mouse" = "pen", pressure = 0.5) {
  await page.getByTestId("ink-canvas").evaluate(
    (canvas, { points, pointerType, pressure }) => {
      const r = canvas.getBoundingClientRect();
      const ev = (type: string, [x, y]: [number, number]) =>
        canvas.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType, pressure, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, isPrimary: true, button: 0, buttons: 1 }));
      ev("pointerdown", points[0]);
      for (const p of points.slice(1)) ev("pointermove", p);
      ev("pointerup", points[points.length - 1]);
    },
    { points, pointerType, pressure },
  );
}

export const line = (x0: number, y0: number, x1: number, y1: number, n = 20): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);

/** Liest, ob an einer Canvas-Position (CSS-Pixel) Tinte ist. */
export async function inkAt(page: Page, x: number, y: number): Promise<boolean> {
  return page.getByTestId("ink-canvas").evaluate(async (c: HTMLCanvasElement, [x, y]) => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const dpr = c.width / c.getBoundingClientRect().width;
    const d = c.getContext("2d")!.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
    return d[3] > 100;
  }, [x, y]);
}

/** Misst die Strichdicke (CSS-Pixel) entlang einer senkrechten Linie bei x. */
export async function thicknessAt(page: Page, x: number, y0: number, y1: number): Promise<number> {
  return page.getByTestId("ink-canvas").evaluate(async (c: HTMLCanvasElement, [x, y0, y1]) => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const dpr = c.width / c.getBoundingClientRect().width;
    const ctx = c.getContext("2d")!;
    const col = ctx.getImageData(Math.round(x * dpr), Math.round(y0 * dpr), 1, Math.round((y1 - y0) * dpr)).data;
    let n = 0;
    for (let i = 3; i < col.length; i += 4) if (col[i] > 128) n++;
    return n / dpr;
  }, [x, y0, y1]);
}
