import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createCourse } from "../lib/actions";
import { db } from "../lib/db";
import { hasActiveKey, useSettings } from "../lib/settings";

export function HomePage() {
  const settings = useSettings();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const courses = useLiveQuery(() => db.courses.orderBy("createdAt").reverse().toArray(), []);
  const stats = useLiveQuery(async () => {
    const now = Date.now();
    const items = await db.items.toArray();
    const map = new Map<string, { total: number; due: number; fresh: number }>();
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
      <div className="spread">
        <h1>Meine Kurse</h1>
      </div>
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
        {courses?.map((c) => {
          const s = stats?.get(c.id);
          return (
            <Link key={c.id} to={`/course/${c.id}`} className="card" style={{ textDecoration: "none", color: "inherit" }}>
              <h2>{c.name}</h2>
              {c.subject && c.subject !== c.name && <p className="muted small">{c.subject}</p>}
              <div className="row">
                <span className="badge">{s?.total ?? 0} Aufgaben</span>
                {!!s?.due && <span className="badge warn">{s.due} fällig</span>}
                {!!s?.fresh && <span className="badge accent">{s.fresh} neu</span>}
              </div>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
