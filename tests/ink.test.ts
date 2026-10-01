import { describe, expect, it } from "vitest";
import { History, eraseAt, freehandOptions, lassoSelect, pointInPolygon, strokeBounds, translateStrokes, type Point, type Stroke } from "../src/lib/ink";
import { getStroke } from "perfect-freehand";

const line = (id: string, x0: number, y0: number, x1: number, y1: number, width = 3): Stroke => {
  const pts: Point[] = [];
  for (let i = 0; i <= 10; i++) pts.push([x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10]);
  return { id, points: pts, color: "#000", width };
};
const square: Point[] = [[0, 0], [100, 0], [100, 100], [0, 100]];

describe("Lasso", () => {
  it("Point-in-Polygon", () => {
    expect(pointInPolygon([50, 50], square)).toBe(true);
    expect(pointInPolygon([150, 50], square)).toBe(false);
  });
  it("wählt Striche aus, die mehrheitlich im Lasso liegen", () => {
    const strokes = [line("a", 10, 10, 90, 90), line("b", 200, 200, 300, 300), line("c", 50, 50, 250, 50)];
    const sel = lassoSelect(strokes, square);
    expect([...sel].sort()).toEqual(["a"]); // c liegt nur zu ~27 % innen
    expect(lassoSelect(strokes, square, 0.2).has("c")).toBe(true);
  });
  it("verschiebt nur die Auswahl", () => {
    const strokes = [line("a", 0, 0, 10, 0), line("b", 0, 0, 10, 0)];
    const moved = translateStrokes(strokes, new Set(["a"]), 5, 7);
    expect(moved[0].points[0]).toEqual([5, 7]);
    expect(moved[1].points[0]).toEqual([0, 0]);
    expect(strokes[0].points[0]).toEqual([0, 0]); // unveränderlich
  });
});

describe("Radierer", () => {
  it("entfernt ganze getroffene Striche", () => {
    const strokes = [line("a", 0, 0, 100, 0), line("b", 0, 50, 100, 50)];
    expect(eraseAt(strokes, [50, 2], 4).map((s) => s.id)).toEqual(["b"]);
    expect(eraseAt(strokes, [50, 25], 4)).toHaveLength(2);
  });
});

describe("Verlauf", () => {
  it("Undo/Redo inkl. Verschiebung", () => {
    const s0: Stroke[] = [];
    const h = new History(s0);
    const s1 = [line("a", 0, 0, 10, 0)];
    h.push(s1);
    const s2 = translateStrokes(s1, new Set(["a"]), 10, 0);
    h.push(s2);
    expect(h.undo()).toBe(s1);
    expect(h.undo()).toBe(s0);
    expect(h.canUndo).toBe(false);
    expect(h.redo()).toBe(s1);
    h.push([]);
    expect(h.canRedo).toBe(false);
  });
});

describe("Feste Strichdicke", () => {
  it("Druck hat keinen Einfluss auf die Kontur", () => {
    const pts = [[0, 0], [20, 5], [40, 0], [60, 10]];
    const light = getStroke(pts.map(([x, y]) => [x, y, 0.1]), freehandOptions(6));
    const hard = getStroke(pts.map(([x, y]) => [x, y, 1]), freehandOptions(6));
    expect(light).toEqual(hard);
  });
  it("Dicke skaliert mit der Einstellung", () => {
    const pts = [[0, 0], [100, 0]];
    const w = (size: number) => {
      const o = getStroke(pts, freehandOptions(size));
      const ys = o.map((p) => p[1]);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(w(10)).toBeGreaterThan(w(2) * 3);
  });
  it("Bounding-Box berücksichtigt die Strichbreite", () => {
    expect(strokeBounds([line("a", 10, 10, 20, 10, 4)])).toEqual({ minX: 8, minY: 8, maxX: 22, maxY: 12 });
    expect(strokeBounds([])).toBeNull();
  });
});
