import { useLiveQuery } from "dexie-react-hooks";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { createCourse } from "../lib/actions";
import { db, deleteCourse, type Course } from "../lib/db";
import { hasActiveKey, useSettings } from "../lib/settings";

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

interface Stats {
  total: number;
  due: number;
  fresh: number;
}

/** Kurskarte: kurz tippen öffnet, lange drücken (oder Rechtsklick) zeigt „Löschen“. */
function CourseCard({ course, stats, onRequestDelete }: { course: Course; stats?: Stats; onRequestDelete: (c: Course) => void }) {
  const [menu, setMenu] = useState(false);
  const timer = useRef<number | null>(null);
  const start = useRef<[number, number] | null>(null);
  const longPressed = useRef(false);

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  return (
    <div className="course-card-wrap">
      <Link
        to={`/course/${course.id}`}
        className={`card course-card ${menu ? "pressed" : ""}`}
        data-testid="course-card"
        draggable={false}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse" && e.button !== 0) return;
          longPressed.current = false;
          start.current = [e.clientX, e.clientY];
          timer.current = window.setTimeout(() => {
            longPressed.current = true;
            setMenu(true);
            navigator.vibrate?.(15);
          }, LONG_PRESS_MS);
        }}
        onPointerMove={(e) => {
          if (start.current && Math.hypot(e.clientX - start.current[0], e.clientY - start.current[1]) > MOVE_TOLERANCE) cancel();
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
        onClick={(e) => {
          if (longPressed.current || menu) {
            e.preventDefault();
            longPressed.current = false;
          }
        }}
      >
        <h2>{course.name}</h2>
        {course.subject && course.subject !== course.name && <p className="muted small">{course.subject}</p>}
        <div className="row">
          <span className="badge">{stats?.total ?? 0} Aufgaben</span>
          {!!stats?.due && <span className="badge warn">{stats.due} fällig</span>}
          {!!stats?.fresh && <span className="badge accent">{stats.fresh} neu</span>}
        </div>
      </Link>
      {menu && (
        <div className="course-card-menu">
          <button className="danger-solid" onClick={() => { setMenu(false); onRequestDelete(course); }} data-testid="course-delete">
            🗑 Löschen
          </button>
          <button onClick={() => setMenu(false)}>Abbrechen</button>
        </div>
      )}
    </div>
  );
}

export function HomePage() {
  const settings = useSettings();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [toDelete, setToDelete] = useState<Course | null>(null);
  const courses = useLiveQuery(() => db.courses.orderBy("createdAt").reverse().toArray(), []);
  const stats = useLiveQuery(async () => {
    const now = Date.now();
    const items = await db.items.toArray();
    const map = new Map<string, Stats>();
    for (const i of items) {
      const s = map.get(i.courseId) ?? { total: 0, due: 0, fresh: 0 };
      s.total++;
      if (i.card.reps === 0) s.fresh++;
      else if (i.due <= now) s.due++;
      map.set(i.courseId, s);
    }
    return map;
  }, []);

  const add = async () => {
    if (!name.trim()) return;
    const id = await createCourse(name);
    setName("");
    nav(`/course/${id}`);
  };

  return (
    <main className="page stack">
      {!hasActiveKey(settings) && (
        <div className="notice warn">
          Noch kein KI-Anbieter eingerichtet. <Link to="/settings">Jetzt in den Einstellungen einrichten</Link> – mit Gemini geht das kostenlos.
        </div>
      )}
      <h1>Meine Kurse</h1>
      <form
        className="card row"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input type="text" placeholder="Neuer Kurs, z. B. „Analysis I“" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 200 }} aria-label="Kursname" />
        <button className="primary" type="submit" disabled={!name.trim()}>Kurs anlegen</button>
      </form>
      {courses && courses.length === 0 && <p className="muted">Lege einen Kurs an und lade Folien und Altklausuren als PDF hoch.</p>}
      <div className="grid">
        {courses?.map((c) => <CourseCard key={c.id} course={c} stats={stats?.get(c.id)} onRequestDelete={setToDelete} />)}
      </div>
      {!!courses?.length && <p className="muted small">Tipp: Zum Löschen einen Kurs gedrückt halten.</p>}
      {toDelete && (
        <ConfirmDialog
          title={`„${toDelete.name}“ löschen?`}
          confirmLabel="Endgültig löschen"
          danger
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            await deleteCourse(toDelete.id);
            setToDelete(null);
          }}
        >
          <p>Alle PDFs, Themen, Aufgaben und Lernstände dieses Kurses werden von diesem Gerät gelöscht. Das lässt sich nicht rückgängig machen – außer du hast ein Backup.</p>
        </ConfirmDialog>
      )}
    </main>
  );
}
