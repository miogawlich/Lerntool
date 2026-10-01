import { useLiveQuery } from "dexie-react-hooks";
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ErrorBanner, useBusy } from "../components/Busy";
import { Difficulty, MasteryBar, RelevanceBadge, formatBytes } from "../components/Bits";
import { MathText } from "../components/MathText";
import { addDocuments, analyzeCourse, generateForTopics, generateWeaknessVariations } from "../lib/actions";
import { claudeCostThisMonth, defaultCallOptions, getBackend, includePdfsForCreate } from "../lib/ai";
import { estimateClaudeCost, formatUsd } from "../lib/ai/estimate";
import { db, deleteCourse, type Course, type DocKind, type Item, type Topic } from "../lib/db";
import { ERROR_TYPE_LABELS, ITEM_TYPE_LABELS, ITEM_TYPES, normalizeMix, type ErrorType, type FormatMix } from "../lib/schemas";
import { computeMastery, errorTypeStats, weakestTopics, type TopicMastery } from "../lib/scheduler";
import { getSettings, hasActiveKey, useSettings } from "../lib/settings";

/**
 * Fragt vor teuren Claude-Aktionen mit grober Kostenschätzung nach. Bei Gemini (kostenlos) wird nicht gefragt.
 * Gibt false zurück, wenn abgebrochen wurde.
 */
async function confirmClaudeCost(what: string, pages: number, outputTokens: number, requests = 1): Promise<boolean> {
  const s = getSettings();
  if (s.createProvider !== "claude") return true;
  const one = estimateClaudeCost(s.claudeModel, pages, outputTokens / requests);
  const usd = one.usd * requests;
  const spent = await claudeCostThisMonth();
  const budget = s.claudeMonthlyBudget > 0 ? ` von ${formatUsd(s.claudeMonthlyBudget)} Budget` : "";
  return confirm(
    `${what} mit Claude kostet grob ${formatUsd(usd)}` +
      (pages ? ` (ca. ${pages} PDF-Seiten${requests > 1 ? `, ${requests} Anfragen` : ""})` : " (ohne PDFs, Sparmodus)") +
      `.\nDiesen Monat bisher: ${formatUsd(spent)}${budget}.\n\nFortfahren?`,
  );
}

type Tab = "overview" | "material" | "topics" | "items";
const TABS: [Tab, string][] = [
  ["overview", "Übersicht"],
  ["material", "Material"],
  ["topics", "Themen"],
  ["items", "Aufgaben"],
];

export function CoursePage() {
  const { courseId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const course = useLiveQuery(() => db.courses.get(courseId), [courseId]);
  const topics = useLiveQuery(() => db.topics.where("courseId").equals(courseId).sortBy("order"), [courseId]) ?? [];
  const items = useLiveQuery(() => db.items.where("courseId").equals(courseId).toArray(), [courseId]) ?? [];
  const attempts = useLiveQuery(() => db.attempts.where("courseId").equals(courseId).toArray(), [courseId]) ?? [];
  const docs = useLiveQuery(() => db.documents.where("courseId").equals(courseId).toArray(), [courseId]) ?? [];
  const mastery = useMemo(() => computeMastery(topics, attempts), [topics, attempts]);

  if (course === undefined) return <main className="page">Lädt …</main>;
  if (course === null || !course) return <main className="page">Kurs nicht gefunden. <Link to="/">Zurück</Link></main>;

  return (
    <main className="page">
      <div className="spread">
        <div>
          <Link to="/" className="crumb small">← Kurse</Link>
          <h1>{course.name}</h1>
        </div>
      </div>
      <ErrorBanner />
      <nav className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setParams({ tab: id }, { replace: true })}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "overview" && <Overview course={course} topics={topics} items={items} attempts={attempts} mastery={mastery} docsCount={docs.length} />}
      {tab === "material" && <Material course={course} docs={docs} />}
      {tab === "topics" && <Topics course={course} topics={topics} items={items} mastery={mastery} />}
      {tab === "items" && <Items topics={topics} items={items} />}
    </main>
  );
}

function Overview({ course, topics, items, attempts, mastery, docsCount }: { course: Course; topics: Topic[]; items: Item[]; attempts: { errorType?: ErrorType }[]; mastery: Map<string, TopicMastery>; docsCount: number }) {
  const nav = useNavigate();
  const settings = useSettings();
  const now = Date.now();
  const due = items.filter((i) => i.card.reps > 0 && i.due <= now && !i.suspended).length;
  const fresh = items.filter((i) => i.card.reps === 0 && !i.suspended).length;
  const practiced = topics.filter((t) => (mastery.get(t.id)?.attempts ?? 0) > 0);
  const avg = practiced.length ? practiced.reduce((s, t) => s + mastery.get(t.id)!.mastery, 0) / practiced.length : 0;
  const weak = weakestTopics(topics, mastery).filter((t) => (mastery.get(t.id)?.attempts ?? 0) > 0).slice(0, 5);
  const errors = [...errorTypeStats(attempts as never).entries()].sort((a, b) => b[1] - a[1]);
  const go = (q: string) => nav(`/course/${course.id}/study?${q}`);

  if (!docsCount)
    return (
      <div className="card stack">
        <h2>Los geht's</h2>
        <p>1. Lade unter <b>Material</b> Vorlesungsfolien und Altklausuren als PDF hoch.<br />2. Lass die KI das Material analysieren – sie erkennt Themen und schlägt passende Aufgabenformate vor.<br />3. Erzeuge unter <b>Themen</b> Aufgaben und fang an zu lernen.</p>
        {!hasActiveKey(settings) && <p className="notice warn">Vorher in den <Link to="/settings">Einstellungen</Link> die KI fürs Erstellen einrichten.</p>}
      </div>
    );

  return (
    <div className="stack">
      <div className="card">
        <div className="row" style={{ gap: 28 }}>
          <div className="stat"><b>{items.length}</b><span className="muted small">Aufgaben</span></div>
          <div className="stat"><b>{due}</b><span className="muted small">fällig</span></div>
          <div className="stat"><b>{fresh}</b><span className="muted small">neu</span></div>
          <div className="stat"><b>{practiced.length ? `${Math.round(avg * 100)} %` : "–"}</b><span className="muted small">Ø Beherrschung</span></div>
        </div>
      </div>
      <div className="row">
        <button className="primary" disabled={!due && !fresh} onClick={() => go("mode=due")} data-testid="start-due">
          ▶ Lernen ({due} fällig{fresh ? ` + bis zu ${Math.min(fresh, settings.newPerSession)} neue` : ""})
        </button>
        <button disabled={!weak.length} onClick={() => go("mode=weak")}>🎯 Schwächen üben</button>
        <button disabled={!items.length} onClick={() => go("mode=all")}>Alles durchgehen</button>
      </div>
      {!items.length && <p className="notice">Noch keine Aufgaben. Wechsle zu <b>Themen</b> und erzeuge welche.</p>}
      {weak.length > 0 && (
        <div className="card">
          <h2>Deine größten Baustellen</h2>
          <ul className="list">
            {weak.map((t) => (
              <li key={t.id} className="spread">
                <span style={{ flex: 1, minWidth: 180 }}>{t.name}</span>
                <div style={{ width: 200 }}><MasteryBar value={mastery.get(t.id)!.mastery} attempts={mastery.get(t.id)!.attempts} /></div>
                <button className="small" onClick={() => go(`mode=topic&topic=${t.id}`)}>Üben</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {errors.length > 0 && (
        <div className="card">
          <h2>Häufigste Fehlerarten</h2>
          <div className="row">
            {errors.map(([k, n]) => (
              <span key={k} className="badge bad">{ERROR_TYPE_LABELS[k as ErrorType]}: {n}×</span>
            ))}
          </div>
        </div>
      )}
      <DangerZone course={course} />
    </div>
  );
}

function DangerZone({ course }: { course: Course }) {
  const nav = useNavigate();
  return (
    <details className="card">
      <summary>Kurs verwalten</summary>
      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="danger"
          onClick={async () => {
            if (!confirm(`Kurs „${course.name}“ mit allen Aufgaben, PDFs und Lernständen löschen?`)) return;
            await deleteCourse(course.id);
            nav("/");
          }}
        >
          Kurs löschen
        </button>
      </div>
    </details>
  );
}

function Material({ course, docs }: { course: Course; docs: { id: string; name: string; kind: DocKind; bytes: number; pages?: number; analyzedAt?: number }[] }) {
  const busy = useBusy();
  const settings = useSettings();
  const [kind, setKind] = useState<DocKind>("slides");
  const [drag, setDrag] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const pending = docs.filter((d) => !d.analyzedAt);

  const upload = async (files: FileList | File[] | null) => {
    const pdfs = [...(files ?? [])].filter((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) return;
    await addDocuments(course.id, pdfs, kind);
    setInfo(`${pdfs.length} Datei(en) hinzugefügt. Jetzt „Analysieren“ tippen.`);
  };

  const analyze = async (all = false) => {
    const targets = all ? docs : pending;
    const pages = targets.reduce((a, d) => a + (d.pages ?? Math.max(1, Math.round(d.bytes / 60_000))), 0);
    if (!(await confirmClaudeCost("Die Analyse", pages, 10_000))) return;
    await busy.run("Analysiere Material …", async ({ signal, progress }) => {
      const res = await analyzeCourse(await getBackend("create"), course.id, { ...defaultCallOptions({ signal, onProgress: (p) => progress(p.step, p.receivedChars) }), all });
      setInfo(`Analyse fertig: ${res.added} neue Themen, ${res.updated} aktualisiert.`);
    });
  };

  const KIND_LABEL: Record<DocKind, string> = { slides: "Folien", exam: "Altklausur", other: "Sonstiges" };

  return (
    <div className="stack">
      <div className="card stack">
        <h2>PDFs hochladen</h2>
        <div className="row">
          {(["slides", "exam", "other"] as DocKind[]).map((k) => (
            <button key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
              {k === "slides" ? "📑 Vorlesungsfolien" : k === "exam" ? "📝 Altklausur" : "📄 Sonstiges (Skript, Übung)"}
            </button>
          ))}
        </div>
        <div
          className={`dropzone ${drag ? "drag" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void upload(e.dataTransfer.files);
          }}
        >
          <p>PDFs hierher ziehen oder</p>
          <button className="primary" onClick={() => input.current?.click()}>Dateien auswählen ({KIND_LABEL[kind]})</button>
          <input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden data-testid="file-input" onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
        </div>
        {info && <p className="notice good">{info}</p>}
      </div>
      <div className="card">
        <div className="spread">
          <h2>Dokumente ({docs.length})</h2>
          <div className="row">
            <button className="primary" disabled={!pending.length || !hasActiveKey(settings)} onClick={() => analyze(false)} data-testid="analyze">
              🔍 Analysieren{pending.length ? ` (${pending.length} neu)` : ""}
            </button>
            <button disabled={!docs.length || !hasActiveKey(settings)} onClick={() => analyze(true)}>Alles neu analysieren</button>
          </div>
        </div>
        {!hasActiveKey(settings) && <p className="notice warn">Für die Analyse zuerst in den <Link to="/settings">Einstellungen</Link> die KI fürs Erstellen einrichten.</p>}
        <ul className="list">
          {docs.map((d) => (
            <li key={d.id} className="spread">
              <span style={{ flex: 1, minWidth: 200, overflowWrap: "anywhere" }}>{d.name}</span>
              <span className="badge">{KIND_LABEL[d.kind]}</span>
              <span className="small muted">{formatBytes(d.bytes)}</span>
              {d.analyzedAt ? <span className="badge good">analysiert</span> : <span className="badge warn">neu</span>}
              <button className="small danger" onClick={() => confirm(`„${d.name}“ entfernen?`) && db.documents.delete(d.id)} aria-label={`${d.name} löschen`}>✕</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function MixEditor({ course }: { course: Course }) {
  const mix = course.mix ?? { flashcard: 25, multiple_choice: 25, short_answer: 25, worked_problem: 25 };
  const set = (k: keyof FormatMix, v: number) => db.courses.update(course.id, { mix: { ...mix, [k]: v } });
  const norm = normalizeMix(mix);
  return (
    <details className="card">
      <summary>Aufgaben-Mix: {ITEM_TYPES.map((t) => `${ITEM_TYPE_LABELS[t]} ${norm[t]} %`).join(" · ")}</summary>
      {course.mixReasoning && <p className="muted small" style={{ marginTop: 8 }}>KI-Empfehlung: {course.mixReasoning}</p>}
      <div className="col" style={{ marginTop: 10 }}>
        {ITEM_TYPES.map((t) => (
          <label key={t} className="row" style={{ flexWrap: "nowrap" }}>
            <span style={{ width: 210 }}>{ITEM_TYPE_LABELS[t]}</span>
            <input type="range" min={0} max={100} step={5} value={mix[t]} onChange={(e) => set(t, Number(e.target.value))} style={{ flex: 1 }} />
            <span style={{ width: 48, textAlign: "right" }}>{norm[t]} %</span>
          </label>
        ))}
      </div>
    </details>
  );
}

function Topics({ course, topics, items, mastery }: { course: Course; topics: Topic[]; items: Item[]; mastery: Map<string, TopicMastery> }) {
  const busy = useBusy();
  const nav = useNavigate();
  const settings = useSettings();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [count, setCount] = useState(5);
  const [msg, setMsg] = useState<string | null>(null);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) m.set(i.topicId, (m.get(i.topicId) ?? 0) + 1);
    return m;
  }, [items]);
  const ready = hasActiveKey(settings);

  const pdfPages = async () => {
    if (!includePdfsForCreate()) return 0;
    const docs = await db.documents.where("courseId").equals(course.id).toArray();
    return docs.reduce((a, d) => a + (d.pages ?? Math.max(1, Math.round(d.bytes / 60_000))), 0);
  };

  const generate = async (ids: string[]) => {
    const total = ids.length * count;
    const requests = Math.max(1, Math.ceil(total / 24));
    if (!(await confirmClaudeCost(`${total} Aufgaben erzeugen`, await pdfPages(), total * 500 + 4_000 * requests, requests))) return;
    await busy.run("Erzeuge Aufgaben …", async ({ signal, progress }) => {
      const mix = normalizeMix(course.mix ?? { flashcard: 25, multiple_choice: 25, short_answer: 25, worked_problem: 25 });
      const n = await generateForTopics(await getBackend("create"), course.id, ids, count, mix, {
        ...defaultCallOptions({ signal, onProgress: (p) => progress(p.step, p.receivedChars) }),
        includeDocs: includePdfsForCreate(),
      });
      setMsg(`${n} neue Aufgaben erzeugt.`);
      setSel(new Set());
    });
  };

  const variations = async (t: Topic) => {
    if (!(await confirmClaudeCost("4 Schwächen-Aufgaben erzeugen", await pdfPages(), 6_000))) return;
    await busy.run("Erzeuge Übungsaufgaben zu deinen Schwächen …", async ({ signal, progress }) => {
      const n = await generateWeaknessVariations(await getBackend("create"), course.id, t.id, 4, {
        ...defaultCallOptions({ signal, onProgress: (p) => progress(p.step, p.receivedChars) }),
        includeDocs: includePdfsForCreate(),
      });
      setMsg(`${n} neue Aufgaben zu „${t.name}“ erzeugt.`);
    });
  };

  if (!topics.length) return <p className="notice">Noch keine Themen. Lade unter <b>Material</b> PDFs hoch und analysiere sie.</p>;

  const allSelected = sel.size === topics.length;
  return (
    <div className="stack">
      <MixEditor course={course} />
      <div className="card row" style={{ position: "sticky", top: 64, zIndex: 5 }}>
        <label className="check">
          <input type="checkbox" checked={allSelected} onChange={() => setSel(allSelected ? new Set() : new Set(topics.map((t) => t.id)))} />
          Alle
        </label>
        <select value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: "auto" }} aria-label="Aufgaben pro Thema">
          {[3, 5, 8, 12].map((n) => (
            <option key={n} value={n}>{n} pro Thema</option>
          ))}
        </select>
        <button className="primary" disabled={!sel.size || !ready} onClick={() => generate([...sel])} data-testid="generate">
          ✨ Aufgaben erzeugen ({sel.size} Themen)
        </button>
        {msg && <span className="badge good">{msg}</span>}
      </div>
      {topics.map((t) => {
        const m = mastery.get(t.id)!;
        return (
          <div key={t.id} className="card" data-testid="topic">
            <div className="spread">
              <label className="check" style={{ flex: 1, minWidth: 220 }}>
                <input
                  type="checkbox"
                  checked={sel.has(t.id)}
                  onChange={() => {
                    const n = new Set(sel);
                    if (n.has(t.id)) n.delete(t.id);
                    else n.add(t.id);
                    setSel(n);
                  }}
                />
                <b>{t.name}</b>
              </label>
              <RelevanceBadge r={t.examRelevance} />
              <span className="badge">{counts.get(t.id) ?? 0} Aufgaben</span>
            </div>
            <div style={{ margin: "8px 0" }}><MasteryBar value={m.mastery} attempts={m.attempts} /></div>
            <details>
              <summary className="small">Details</summary>
              <MathText text={t.summary} />
              {t.concepts.length > 0 && <p className="small"><b>Konzepte:</b> {t.concepts.join(", ")}</p>}
              {t.formulas.length > 0 && <MathText className="small" text={`**Formeln:** ${t.formulas.join("   ")}`} />}
              <p className="small muted"><b>In Klausuren:</b> {t.examPatterns}</p>
            </details>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="small" disabled={!counts.get(t.id)} onClick={() => nav(`/course/${course.id}/study?mode=topic&topic=${t.id}`)}>▶ Üben</button>
              <button className="small" disabled={!ready} onClick={() => generate([t.id])}>+ {count} Aufgaben</button>
              <button className="small" disabled={!ready || !m.attempts} onClick={() => variations(t)} title="Neue Aufgaben, die gezielt deine Fehler trainieren">🎯 Schwächen-Aufgaben</button>
              <button
                className="small danger"
                onClick={async () => {
                  if (!confirm(`Thema „${t.name}“ mit allen Aufgaben löschen?`)) return;
                  await db.items.where("topicId").equals(t.id).delete();
                  await db.topics.delete(t.id);
                }}
              >
                Löschen
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Items({ topics, items }: { topics: Topic[]; items: Item[] }) {
  const [topicFilter, setTopicFilter] = useState("");
  const names = new Map(topics.map((t) => [t.id, t.name]));
  const list = items.filter((i) => !topicFilter || i.topicId === topicFilter).sort((a, b) => a.createdAt - b.createdAt);
  return (
    <div className="stack">
      <select value={topicFilter} onChange={(e) => setTopicFilter(e.target.value)} aria-label="Thema filtern">
        <option value="">Alle Themen ({items.length})</option>
        {topics.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      {list.map((i) => (
        <details key={i.id} className="card">
          <summary>
            <div className="spread" style={{ width: "100%" }}>
              <span style={{ flex: 1, minWidth: 200 }}>{i.prompt.replace(/\$+/g, "").slice(0, 110)}{i.prompt.length > 110 ? " …" : ""}</span>
              <span className="badge accent">{ITEM_TYPE_LABELS[i.type]}</span>
              <Difficulty d={i.difficulty} />
              {i.source === "variation" && <span className="badge">Schwächen-Aufgabe</span>}
              {i.suspended && <span className="badge warn">pausiert</span>}
            </div>
          </summary>
          <p className="small muted">{names.get(i.topicId)} · {i.card.reps ? `fällig ${new Date(i.due).toLocaleDateString("de-DE")}` : "noch nicht gelernt"}</p>
          <MathText className="prompt" text={i.prompt} />
          {i.options.length > 0 && (
            <ul>{i.options.map((o, k) => <li key={k}>{o.correct ? "✅" : "❌"} <MathText text={o.text} /></li>)}</ul>
          )}
          <div className="solution"><MathText text={i.answer} /></div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="small" onClick={() => db.items.update(i.id, { suspended: !i.suspended })}>{i.suspended ? "Fortsetzen" : "Pausieren"}</button>
            <button className="small danger" onClick={() => confirm("Aufgabe löschen?") && db.items.delete(i.id)}>Löschen</button>
          </div>
        </details>
      ))}
    </div>
  );
}
