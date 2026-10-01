/**
 * Reine Logik des Zeichenfelds (ohne DOM), damit sie testbar ist.
 * Striche werden als Vektordaten gespeichert; die Dicke ist fest pro Strich
 * und hängt bewusst NICHT vom Stiftdruck ab.
 */

export type Point = [number, number];

export interface Stroke {
  id: string;
  points: Point[];
  color: string;
  width: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

let counter = 0;
export const strokeId = () => `s${Date.now().toString(36)}_${(counter++).toString(36)}`;

export function strokeBounds(strokes: Stroke[]): Bounds | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const s of strokes) {
    const r = s.width / 2;
    for (const [x, y] of s.points) {
      minX = Math.min(minX, x - r);
      minY = Math.min(minY, y - r);
      maxX = Math.max(maxX, x + r);
      maxY = Math.max(maxY, y + r);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Ray-Casting Point-in-Polygon. */
export function pointInPolygon([x, y]: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ein Strich gilt als ausgewählt, wenn mindestens `ratio` seiner Punkte im Lasso liegen. */
export function lassoSelect(strokes: Stroke[], lasso: Point[], ratio = 0.5): Set<string> {
  const sel = new Set<string>();
  if (lasso.length < 3) return sel;
  for (const s of strokes) {
    if (!s.points.length) continue;
    const inside = s.points.filter((p) => pointInPolygon(p, lasso)).length;
    if (inside / s.points.length >= ratio) sel.add(s.id);
  }
  return sel;
}

export function translateStrokes(strokes: Stroke[], ids: Set<string>, dx: number, dy: number): Stroke[] {
  if (!dx && !dy) return strokes;
  return strokes.map((s) => (ids.has(s.id) ? { ...s, points: s.points.map(([x, y]) => [x + dx, y + dy] as Point) } : s));
}

function distToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Radierer: entfernt ganze Striche, die der Radierer-Punkt berührt. */
export function eraseAt(strokes: Stroke[], p: Point, radius: number): Stroke[] {
  return strokes.filter((s) => {
    const hit = radius + s.width / 2;
    if (s.points.length === 1) return Math.hypot(p[0] - s.points[0][0], p[1] - s.points[0][1]) > hit;
    for (let i = 1; i < s.points.length; i++) if (distToSegment(p, s.points[i - 1], s.points[i]) <= hit) return false;
    return true;
  });
}

export function pointInBounds([x, y]: Point, b: Bounds, pad = 0): boolean {
  return x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;
}

/** Fügt nur Punkte hinzu, die sich merklich bewegt haben (reduziert Datenmenge). */
export function appendPoint(points: Point[], p: Point, minDist = 0.75): Point[] {
  const last = points[points.length - 1];
  if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < minDist) return points;
  return [...points, p];
}

/** Einfacher Undo/Redo-Verlauf über unveränderliche Snapshots. */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(private present: T, private readonly limit = 200) {}

  get current(): T {
    return this.present;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  push(next: T) {
    if (next === this.present) return;
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = next;
    this.future = [];
  }
  undo(): T {
    if (this.past.length) {
      this.future.push(this.present);
      this.present = this.past.pop()!;
    }
    return this.present;
  }
  redo(): T {
    if (this.future.length) {
      this.past.push(this.present);
      this.present = this.future.pop()!;
    }
    return this.present;
  }
}

/** Optionen für perfect-freehand: konstante Breite, Druck wird ignoriert. */
export function freehandOptions(width: number) {
  return {
    size: width,
    thinning: 0,
    smoothing: 0.5,
    streamline: 0.35,
    simulatePressure: false,
    last: true,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
  };
}
