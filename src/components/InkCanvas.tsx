import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  History,
  appendPoint,
  eraseAt,
  lassoSelect,
  pointInBounds,
  strokeBounds,
  strokeId,
  translateStrokes,
  type Point,
  type Stroke,
} from "../lib/ink";
import { drawStroke, strokePath } from "../lib/inkRender";
import { updateSettings, useSettings } from "../lib/settings";

type Tool = "pen" | "eraser" | "lasso";
type Gesture =
  | { kind: "pen"; stroke: Stroke }
  | { kind: "erase"; working: Stroke[] }
  | { kind: "lasso"; points: Point[] }
  | { kind: "drag"; start: Point; dx: number; dy: number };

const COLORS = ["#1d1d1f", "#2457d6", "#d12d2d", "#1f8a4c"];
const PRESETS = [1.5, 3, 5, 8];

interface Props {
  value: Stroke[];
  onChange: (strokes: Stroke[]) => void;
  minHeight?: number;
}

export function InkCanvas({ value, onChange, minHeight = 480 }: Props) {
  const settings = useSettings();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hist = useRef(new History<Stroke[]>(value));
  const strokesRef = useRef<Stroke[]>(value);
  const gesture = useRef<Gesture | null>(null);
  const pointerId = useRef<number | null>(null);
  const raf = useRef(0);
  const fingerRef = useRef(settings.fingerDraws);
  fingerRef.current = settings.fingerDraws;

  const [strokes, setStrokes] = useState<Stroke[]>(value);
  const [tool, setTool] = useState<Tool>("pen");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [width, setWidth] = useState(600);
  const [height, setHeight] = useState(minHeight);
  const [, setTick] = useState(0);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const g = gesture.current;
    const base = g?.kind === "erase" ? g.working : strokesRef.current;
    const sel = selectionRef.current;
    const off = g?.kind === "drag" ? [g.dx, g.dy] : [0, 0];
    for (const s of base) {
      if (sel.has(s.id)) {
        ctx.save();
        ctx.translate(off[0], off[1]);
        ctx.shadowColor = "rgba(43,92,214,0.85)";
        ctx.shadowBlur = 6;
        drawStroke(ctx, s);
        ctx.restore();
      } else drawStroke(ctx, s);
    }
    if (sel.size) {
      const b = strokeBounds(base.filter((s) => sel.has(s.id)));
      if (b) {
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = "#2b5cd6";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(b.minX - 8 + off[0], b.minY - 8 + off[1], b.maxX - b.minX + 16, b.maxY - b.minY + 16);
        ctx.restore();
      }
    }
    if (g?.kind === "pen") drawStroke(ctx, g.stroke);
    if (g?.kind === "lasso" && g.points.length > 1) {
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "#2b5cd6";
      ctx.lineWidth = 1.5;
      ctx.fillStyle = "rgba(43,92,214,0.07)";
      ctx.beginPath();
      ctx.moveTo(g.points[0][0], g.points[0][1]);
      for (const [x, y] of g.points.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }, []);

  const schedule = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(redraw);
  }, [redraw]);

  // Größe an Container anpassen
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    redraw();
  }, [width, height, redraw]);

  useEffect(() => schedule(), [strokes, selection, schedule]);

  // Apple Pencil soll nicht scrollen; der Finger scrollt weiter (außer „mit Finger zeichnen“ ist an).
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onTouch = (ev: TouchEvent) => {
      const stylus = Array.from(ev.touches).some((t) => (t as Touch & { touchType?: string }).touchType === "stylus");
      if (stylus || (fingerRef.current && ev.touches.length === 1)) ev.preventDefault();
    };
    c.addEventListener("touchstart", onTouch, { passive: false });
    c.addEventListener("touchmove", onTouch, { passive: false });
    return () => {
      c.removeEventListener("touchstart", onTouch);
      c.removeEventListener("touchmove", onTouch);
    };
  }, []);

  const commit = useCallback(
    (next: Stroke[]) => {
      hist.current.push(next);
      strokesRef.current = next;
      setStrokes(next);
      onChange(next);
      const b = strokeBounds(next);
      if (b && b.maxY > height - 100) setHeight((h) => Math.max(h, Math.ceil(b.maxY + 320)));
    },
    [onChange, height],
  );

  const pt = (e: { clientX: number; clientY: number }): Point => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "touch" && !settings.fingerDraws) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (pointerId.current !== null) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* Pointer bereits beendet – Zeichnen funktioniert trotzdem */
    }
    pointerId.current = e.pointerId;
    const p = pt(e);
    if (tool === "pen") {
      if (selection.size) setSelection(new Set());
      gesture.current = { kind: "pen", stroke: { id: strokeId(), points: [p], color: settings.penColor, width: settings.penWidth } };
    } else if (tool === "eraser") {
      gesture.current = { kind: "erase", working: eraseAt(strokesRef.current, p, eraserRadius()) };
    } else {
      const b = selection.size ? strokeBounds(strokesRef.current.filter((s) => selection.has(s.id))) : null;
      if (b && pointInBounds(p, b, 14)) gesture.current = { kind: "drag", start: p, dx: 0, dy: 0 };
      else {
        if (selection.size) setSelection(new Set());
        gesture.current = { kind: "lasso", points: [p] };
      }
    }
    schedule();
  };

  const eraserRadius = () => Math.max(8, settings.penWidth * 2);

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerId !== pointerId.current || !gesture.current) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    const g = gesture.current;
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const p = pt(ev);
      if (g.kind === "pen") g.stroke = { ...g.stroke, points: appendPoint(g.stroke.points, p) };
      else if (g.kind === "erase") g.working = eraseAt(g.working, p, eraserRadius());
      else if (g.kind === "lasso") g.points = appendPoint(g.points, p, 2);
      else {
        g.dx = p[0] - g.start[0];
        g.dy = p[1] - g.start[1];
      }
    }
    schedule();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerId !== pointerId.current) return;
    pointerId.current = null;
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "pen") commit([...strokesRef.current, g.stroke]);
    else if (g.kind === "erase") {
      if (g.working.length !== strokesRef.current.length) commit(g.working);
    } else if (g.kind === "lasso") setSelection(lassoSelect(strokesRef.current, g.points));
    else if (g.dx || g.dy) commit(translateStrokes(strokesRef.current, selection, g.dx, g.dy));
    schedule();
    setTick((t) => t + 1);
  };

  const undo = () => {
    const s = hist.current.undo();
    strokesRef.current = s;
    setStrokes(s);
    onChange(s);
    setSelection(new Set());
  };
  const redo = () => {
    const s = hist.current.redo();
    strokesRef.current = s;
    setStrokes(s);
    onChange(s);
  };
  const deleteSelection = () => {
    commit(strokesRef.current.filter((s) => !selection.has(s.id)));
    setSelection(new Set());
  };
  const clearAll = () => {
    if (!strokesRef.current.length || !confirm("Alles löschen?")) return;
    commit([]);
    setSelection(new Set());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectionRef.current.size) {
        e.preventDefault();
        deleteSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Path-Cache vorwärmen, damit das erste Neuzeichnen nicht ruckelt
  useEffect(() => void strokes.forEach(strokePath), [strokes]);

  const touchAction = settings.fingerDraws ? "none" : "pan-x pan-y pinch-zoom";

  return (
    <div className="ink-wrap">
      <div className="ink-toolbar" role="toolbar" aria-label="Zeichenwerkzeuge">
        <button className={tool === "pen" ? "active" : ""} onClick={() => setTool("pen")} aria-label="Stift" title="Stift">✏️</button>
        <button className={tool === "eraser" ? "active" : ""} onClick={() => setTool("eraser")} aria-label="Radierer" title="Radierer (ganze Striche)">🧽</button>
        <button className={tool === "lasso" ? "active" : ""} onClick={() => setTool("lasso")} aria-label="Lasso" title="Lasso: einkreisen, dann verschieben">➰</button>
        <span className="sep" />
        {COLORS.map((c) => (
          <button
            key={c}
            className={`swatch ${settings.penColor === c ? "active" : ""}`}
            style={{ background: c }}
            aria-label={`Farbe ${c}`}
            onClick={() => {
              updateSettings({ penColor: c });
              setTool("pen");
            }}
          />
        ))}
        <span className="sep" />
        {PRESETS.map((w) => (
          <button
            key={w}
            className={`small ${settings.penWidth === w ? "active" : ""}`}
            aria-label={`Strichdicke ${w}`}
            onClick={() => updateSettings({ penWidth: w })}
          >
            <span className="width-preview" style={{ height: Math.max(2, w) }} />
          </button>
        ))}
        <input
          type="range"
          min={1}
          max={16}
          step={0.5}
          value={settings.penWidth}
          aria-label="Strichdicke"
          onChange={(e) => updateSettings({ penWidth: Number(e.target.value) })}
        />
        <span className="small muted" data-testid="pen-width">{settings.penWidth} px</span>
        <span className="sep" />
        <button onClick={undo} disabled={!hist.current.canUndo} aria-label="Rückgängig" title="Rückgängig">↶</button>
        <button onClick={redo} disabled={!hist.current.canRedo} aria-label="Wiederholen" title="Wiederholen">↷</button>
        {selection.size > 0 && (
          <button className="small danger" onClick={deleteSelection}>Auswahl löschen ({selection.size})</button>
        )}
        <span style={{ flex: 1 }} />
        <button className="small" onClick={() => setHeight((h) => h + 400)}>+ Platz</button>
        <button className="small danger" onClick={clearAll}>Leeren</button>
      </div>
      <div ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="ink-canvas"
          data-testid="ink-canvas"
          data-strokes={strokes.length}
          data-selected={selection.size}
          style={{ height, touchAction, cursor: tool === "lasso" ? "crosshair" : "default" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
    </div>
  );
}
