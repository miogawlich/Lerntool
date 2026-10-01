import { getStroke } from "perfect-freehand";
import { freehandOptions, strokeBounds, type Stroke } from "./ink";

const cache = new WeakMap<Stroke, Path2D>();

/** Umriss eines Strichs als Path2D (konstante Breite, siehe freehandOptions). */
export function strokePath(s: Stroke): Path2D {
  let p = cache.get(s);
  if (p) return p;
  const outline = getStroke(s.points, freehandOptions(s.width));
  p = new Path2D();
  if (outline.length) {
    p.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      const [x0, y0] = outline[i];
      const [x1, y1] = outline[(i + 1) % outline.length];
      p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    p.closePath();
  }
  cache.set(s, p);
  return p;
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  ctx.fillStyle = s.color;
  ctx.fill(strokePath(s));
}

/** Rendert die Striche als PNG (weißer Hintergrund, auf den Inhalt zugeschnitten). */
export async function exportStrokesPng(strokes: Stroke[], maxSide = 1600): Promise<{ base64: string; blob: Blob } | null> {
  const b = strokeBounds(strokes);
  if (!b) return null;
  const margin = 24;
  const w = b.maxX - b.minX + margin * 2;
  const h = b.maxY - b.minY + margin * 2;
  const scale = Math.min(2, maxSide / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, (margin - b.minX) * scale, (margin - b.minY) * scale);
  for (const s of strokes) drawStroke(ctx, s);
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((bl) => (bl ? res(bl) : rej(new Error("PNG-Export fehlgeschlagen"))), "image/png"));
  const base64 = canvas.toDataURL("image/png").split(",")[1];
  return { base64, blob };
}
