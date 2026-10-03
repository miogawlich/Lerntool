import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ErrorBanner, useBusy } from "../components/Busy";
import { Difficulty } from "../components/Bits";
import { InkCanvas } from "../components/InkCanvas";
import { MathText } from "../components/MathText";
import { recordAttempt, type AttemptInput } from "../lib/actions";
import { defaultCallOptions, getBackend } from "../lib/ai";
import { gradeAnswer } from "../lib/ai/service";
import { db, type Item, type Topic } from "../lib/db";
import type { Stroke } from "../lib/ink";
import { exportStrokesPng } from "../lib/inkRender";
import { ERROR_TYPE_LABELS, ERROR_TYPES, ITEM_TYPE_LABELS, type ErrorType, type GradeResult } from "../lib/schemas";
import { buildSession, type SessionMode } from "../lib/scheduler";
import { getSettings, hasActiveKey, useSettings } from "../lib/settings";

/**
 * Zustand der einzelnen Aufgaben einer Sitzung (Entwürfe, Bewertungsphase), damit beim
 * Hin- und Herblättern nichts verloren geht. Lebt so lange wie die Sitzung.
 */
const SessionStore = createContext<Map<string, unknown>>(new Map());

function useStored<T>(key: string, init: T | (() => T)) {
  const store = useContext(SessionStore);
  const [value, setValue] = useState<T>(() => (store.has(key) ? (store.get(key) as T) : typeof init === "function" ? (init as () => T)() : init));
  const current = useRef(value);
  // Sofort in den Store schreiben: Nach dem Speichern wird oft im selben Zug weitergeblättert.
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      const next = typeof v === "function" ? (v as (prev: T) => T)(current.current) : v;
      current.current = next;
      store.set(key, next);
      setValue(next);
    },
    [store, key],
  );
  return [value, set] as const;
}

export function StudyPage() {
  const { courseId = "" } = useParams();
  const [params] = useSearchParams();
  const mode = (params.get("mode") as SessionMode) || "due";
  const topicId = params.get("topic") ?? undefined;
  const [queue, setQueue] = useState<Item[] | null>(null);
  const [topics, setTopics] = useState<Map<string, Topic>>(new Map());
  const [pos, setPos] = useState(0);
  const [results, setResults] = useState<Map<string, number>>(new Map());
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [store, setStore] = useState(() => new Map<string, unknown>());

  useEffect(() => {
    setQueue(null);
    (async () => {
      const [items, tps, attempts] = await Promise.all([
        db.items.where("courseId").equals(courseId).toArray(),
        db.topics.where("courseId").equals(courseId).toArray(),
        db.attempts.where("courseId").equals(courseId).toArray(),
      ]);
      const q = buildSession(items, tps, attempts, { mode, topicId, limit: mode === "all" ? 200 : 20, newLimit: getSettings().newPerSession });
      setTopics(new Map(tps.map((t) => [t.id, t])));
      setFlagged(new Set(q.filter((i) => i.flagged).map((i) => i.id)));
      setResults(new Map());
      setStore(new Map());
      setPos(0);
      setQueue(q);
    })();
  }, [courseId, mode, topicId]);

  if (!queue) return <main className="page">Lädt …</main>;

  const goTo = (p: number) => {
    setPos(Math.max(0, Math.min(queue.length, p)));
    window.scrollTo({ top: 0 });
  };

  if (pos >= queue.length) {
    const scores = [...results.values()];
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const firstOpen = queue.findIndex((i) => !results.has(i.id));
    return (
      <main className="page stack">
        <div className="card stack" data-testid="session-done">
          <h1>{queue.length ? (firstOpen < 0 ? "Geschafft! 🎉" : "Sitzung beenden?") : "Gerade nichts zu tun"}</h1>
          {queue.length ? (
            <p>
              {scores.length} Aufgaben bearbeitet, Ø {Math.round(avg * 100)} % richtig.
              {firstOpen >= 0 && <> {queue.length - scores.length} noch offen.</>}
            </p>
          ) : (
            <p className="muted">{mode === "weak" ? "Noch keine Schwächen erkannt – erst ein paar Aufgaben lernen." : "Keine fälligen oder neuen Aufgaben. Erzeuge neue Aufgaben oder komm später wieder."}</p>
          )}
          <div className="row">
            {firstOpen >= 0 && <button className="primary" onClick={() => goTo(firstOpen)}>Offene Aufgaben bearbeiten</button>}
            {queue.length > 0 && <button onClick={() => goTo(queue.length - 1)}>← Zurück</button>}
            <Link className={`btn ${firstOpen < 0 ? "primary" : ""}`} to={`/course/${courseId}`}>Zur Kursübersicht</Link>
            {mode !== "weak" && <Link className="btn" to={`/course/${courseId}/study?mode=weak`}>🎯 Schwächen üben</Link>}
          </div>
        </div>
      </main>
    );
  }

  const item = queue[pos];
  const isFlagged = flagged.has(item.id);
  const toggleFlag = async () => {
    const next = new Set(flagged);
    if (isFlagged) next.delete(item.id);
    else next.add(item.id);
    setFlagged(next);
    await db.items.update(item.id, { flagged: !isFlagged });
  };
  const answered = (score: number) => setResults((r) => new Map(r).set(item.id, score));
  const next = () => goTo(pos + 1);
  const flag = <FlagButton flagged={isFlagged} onToggle={toggleFlag} />;

  return (
    <SessionStore.Provider value={store}>
      <main className="page">
        <ErrorBanner />
        <div className="study-head">
          <div className="row">
            <span className="badge accent">{ITEM_TYPE_LABELS[item.type]}</span>
            <Difficulty d={item.difficulty} />
            <span className="small muted">{topics.get(item.topicId)?.name}</span>
          </div>
          <QuestionMenu queue={queue} pos={pos} results={results} flagged={flagged} onSelect={goTo} />
        </div>
        <div className="bar" style={{ marginBottom: 16 }}><div style={{ width: `${(results.size / queue.length) * 100}%`, background: "var(--accent)" }} /></div>
        {item.type === "multiple_choice" && <MultipleChoice key={item.id} item={item} flag={flag} onAnswered={answered} onNext={next} />}
        {(item.type === "short_answer" || item.type === "worked_problem") && <OpenAnswer key={item.id} item={item} flag={flag} onAnswered={answered} onNext={next} />}
        <nav className="study-nav" aria-label="Zwischen Aufgaben wechseln">
          <button onClick={() => goTo(pos - 1)} disabled={pos === 0} data-testid="prev">← Vorherige</button>
          <button onClick={next} data-testid="next">{pos === queue.length - 1 ? "Beenden →" : "Nächste →"}</button>
        </nav>
      </main>
    </SessionStore.Provider>
  );
}

function FlagIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ display: "block" }}>
      <path d="M3.5 15V1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M3.5 2h9l-2.2 3.5L12.5 9h-9z" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function FlagButton({ flagged, onToggle }: { flagged: boolean; onToggle: () => void }) {
  return (
    <button
      className={`flag-btn ${flagged ? "on" : ""}`}
      onClick={onToggle}
      aria-pressed={flagged}
      aria-label={flagged ? "Markierung entfernen" : "Als schwierig markieren"}
      title={flagged ? "Markierung entfernen" : "Als schwierig markieren"}
      data-testid="flag"
    >
      <FlagIcon filled={flagged} />
    </button>
  );
}

function QuestionMenu({ queue, pos, results, flagged, onSelect }: { queue: Item[]; pos: number; results: Map<string, number>; flagged: Set<string>; onSelect: (p: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const select = (p: number) => {
    setOpen(false);
    onSelect(p);
  };
  const marked = queue.map((it, i) => (flagged.has(it.id) ? i : -1)).filter((i) => i >= 0);
  const state = (id: string) => {
    const s = results.get(id);
    return s === undefined ? "" : s >= 0.85 ? "good" : s >= 0.35 ? "warn" : "bad";
  };
  return (
    <div className="qmenu" ref={ref}>
      <button className="small" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true" data-testid="question-menu">
        <span data-testid="progress">{pos + 1} / {queue.length}</span>
        {marked.length > 0 && <span className="qmenu-flagcount"><FlagIcon filled />{marked.length}</span>}
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="qmenu-panel card" role="menu" aria-label="Alle Aufgaben">
          {marked.length > 0 && (
            <>
              <div className="qmenu-title">Markiert</div>
              <div className="qmenu-flagged">
                {marked.map((i) => (
                  <button key={queue[i].id} className="qmenu-flagged-item" role="menuitem" onClick={() => select(i)}>
                    <span className="flag-mark"><FlagIcon filled /></span>
                    <b>{i + 1}</b>
                    <span className="muted">{plainSnippet(queue[i].prompt)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="qmenu-title">Alle Aufgaben</div>
          <div className="qmenu-grid">
            {queue.map((it, i) => (
              <button
                key={it.id}
                role="menuitem"
                className={`qmenu-num ${state(it.id)} ${i === pos ? "current" : ""}`}
                onClick={() => select(i)}
                aria-label={`Aufgabe ${i + 1}${flagged.has(it.id) ? ", markiert" : ""}${results.has(it.id) ? ", bearbeitet" : ""}`}
                aria-current={i === pos ? "true" : undefined}
              >
                {i + 1}
                {flagged.has(it.id) && <span className="flag-mark"><FlagIcon filled /></span>}
              </button>
            ))}
          </div>
          <div className="qmenu-legend small muted">
            <span><i className="dot good" /> richtig</span>
            <span><i className="dot warn" /> teilweise</span>
            <span><i className="dot bad" /> falsch</span>
            <span><i className="dot" /> offen</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Kurzer Klartext-Auszug für das Menü (ohne LaTeX-/Markdown-Zeichen). */
function plainSnippet(s: string, n = 60) {
  const t = s.replace(/\$\$?[^$]*\$\$?/g, "…").replace(/[*_#`]/g, "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function PromptCard({ item, flag, children }: { item: Item; flag: ReactNode; children?: ReactNode }) {
  return (
    <div className="card prompt-card">
      {flag}
      <div style={{ flex: 1, minWidth: 0 }}>
        <MathText className="prompt" text={item.prompt} />
        {children}
      </div>
    </div>
  );
}

export function scoreMultipleChoice(options: { correct: boolean }[], selected: Set<number>): number {
  const correct = options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0);
  const hits = correct.filter((i) => selected.has(i)).length;
  const wrong = [...selected].filter((i) => !options[i]?.correct).length;
  if (hits === correct.length && wrong === 0) return 1;
  return Math.max(0, (hits - wrong) / correct.length) * 0.5;
}

interface TaskProps {
  item: Item;
  flag: ReactNode;
  /** Ergebnis wurde gespeichert (zählt für die Sitzung). */
  onAnswered: (score: number) => void;
  onNext: () => void;
}

function MultipleChoice({ item, flag, onAnswered, onNext }: TaskProps) {
  const multi = item.options.filter((o) => o.correct).length > 1;
  const [selected, setSelected] = useStored<Set<number>>(`${item.id}:selected`, () => new Set());
  const [checked, setChecked] = useStored(`${item.id}:checked`, false);
  const score = scoreMultipleChoice(item.options, selected);
  const toggle = (i: number) => {
    if (checked) return;
    const n = new Set(multi ? selected : []);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    setSelected(n);
  };
  const check = async () => {
    setChecked(true);
    await recordAttempt(item, { score, mode: "auto", errorType: score === 1 ? "none" : "concept" });
    onAnswered(score);
  };
  return (
    <div className="stack">
      <PromptCard item={item} flag={flag}>
        {multi && <p className="small muted">Mehrere Antworten können richtig sein.</p>}
      </PromptCard>
      <div className="mc-options">
        {item.options.map((o, i) => {
          const cls = checked ? (o.correct ? "correct" : selected.has(i) ? "wrong" : "") : selected.has(i) ? "selected" : "";
          return (
            <button key={i} className={`mc-option ${cls}`} onClick={() => toggle(i)} aria-pressed={selected.has(i)} data-testid="mc-option">
              <MathText text={o.text} />
              {checked && o.explanation && <MathText className="expl" text={o.explanation} />}
            </button>
          );
        })}
      </div>
      {!checked ? (
        <button className="primary" disabled={!selected.size} onClick={check}>Prüfen</button>
      ) : (
        <div className="stack">
          <div className={`notice ${score === 1 ? "good" : score > 0 ? "warn" : "error"}`}>{score === 1 ? "Richtig!" : score > 0 ? "Teilweise richtig." : "Leider falsch."}</div>
          {item.answer && <div className="solution"><MathText text={item.answer} /></div>}
          <button className="primary" onClick={onNext}>Weiter</button>
        </div>
      )}
    </div>
  );
}

type Phase = { kind: "answer" } | { kind: "self" } | { kind: "ai"; result: GradeResult } | { kind: "done"; input: AttemptInput };

function OpenAnswer({ item, flag, onAnswered, onNext }: TaskProps) {
  const settings = useSettings();
  const busy = useBusy();
  const [input, setInput] = useStored<"ink" | "text">(`${item.id}:input`, item.type === "worked_problem" ? "ink" : "text");
  const [text, setText] = useStored(`${item.id}:text`, "");
  const [strokes, setStrokes] = useStored<Stroke[]>(`${item.id}:strokes`, []);
  const [phase, setPhase] = useStored<Phase>(`${item.id}:phase`, { kind: "answer" });
  const [image, setImage] = useStored<{ base64: string; blob: Blob } | null>(`${item.id}:image`, null);
  const empty = !text.trim() && !strokes.length;

  const snapshot = async () => {
    const img = strokes.length ? await exportStrokesPng(strokes) : null;
    setImage(img);
    return img;
  };

  const aiGrade = () =>
    busy.run("KI bewertet deine Antwort …", async ({ signal }) => {
      const img = await snapshot();
      const result = await gradeAnswer(await getBackend("grade"), { ...item, topicName: "" }, { text, imagePngBase64: img?.base64 }, defaultCallOptions({ signal }));
      setPhase({ kind: "ai", result });
    });

  const save = async (input: AttemptInput) => {
    await recordAttempt(item, { ...input, answerText: text || undefined, answerImage: image?.blob });
    setPhase({ kind: "done", input });
    onAnswered(input.score);
    onNext();
  };
  const yourAnswer = <YourAnswer text={text} image={image?.blob} />;

  return (
    <div className="stack">
      <PromptCard item={item} flag={flag} />
      {phase.kind === "answer" && (
        <>
          <div className="row">
            <button className={input === "ink" ? "active" : ""} onClick={() => setInput("ink")}>✏️ Stift</button>
            <button className={input === "text" ? "active" : ""} onClick={() => setInput("text")}>⌨️ Tastatur</button>
          </div>
          <div style={{ display: input === "ink" ? "block" : "none" }}>
            <InkCanvas value={strokes} onChange={setStrokes} />
          </div>
          {input === "text" && <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Deine Antwort … (Formeln gern als $x^2$)" aria-label="Antwort" />}
          <div className="row">
            {settings.autoGrade && hasActiveKey(settings, "grade") ? (
              <button className="primary" disabled={empty} onClick={aiGrade} data-testid="ai-grade">Abgeben (KI bewertet)</button>
            ) : (
              <>
                <button className="primary" onClick={async () => { await snapshot(); setPhase({ kind: "self" }); }} data-testid="self-grade">Lösung zeigen & selbst bewerten</button>
                <button disabled={empty || !hasActiveKey(settings, "grade")} onClick={aiGrade} data-testid="ai-grade" title={hasActiveKey(settings, "grade") ? "" : "Erst die KI fürs Bewerten in den Einstellungen einrichten"}>🤖 KI bewerten</button>
              </>
            )}
          </div>
        </>
      )}
      {phase.kind === "self" && (
        <SelfGrade item={item} answer={yourAnswer} onSave={(score, errorType) => save({ score, mode: "self", errorType })} />
      )}
      {phase.kind === "ai" && <AiResult item={item} result={phase.result} answer={yourAnswer} onSave={save} />}
      {phase.kind === "done" && <Saved item={item} input={phase.input} answer={yourAnswer} onNext={onNext} />}
    </div>
  );
}

/** Bereits bewertete Aufgabe beim Zurückblättern: Ergebnis statt erneuter Abgabe. */
function Saved({ item, input, answer, onNext }: { item: Item; input: AttemptInput; answer: ReactNode; onNext: () => void }) {
  const cls = input.score >= 0.85 ? "good" : input.score >= 0.35 ? "warn" : "error";
  return (
    <div className="stack" data-testid="saved-result">
      <div className={`notice ${cls}`}>
        <b>Bereits bewertet: {Math.round(input.score * 100)} %</b>
        {input.feedback && <MathText text={input.feedback} />}
      </div>
      <Solution item={item} />
      {answer}
      <button className="primary" onClick={onNext}>Weiter</button>
    </div>
  );
}

function Solution({ item }: { item: Item }) {
  return (
    <div className="solution">
      <b>Musterlösung</b>
      <MathText text={item.answer} />
    </div>
  );
}

/** Die eigene Antwort (getippt und/oder gezeichnet) zum Vergleich mit der Musterlösung. */
function YourAnswer({ text, image }: { text: string; image?: Blob }) {
  const url = useMemo(() => (image ? URL.createObjectURL(image) : undefined), [image]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (!text.trim() && !url) return null;
  return (
    <div className="card stack" data-testid="your-answer">
      <b>Deine Antwort</b>
      {text.trim() && <MathText text={text} />}
      {url && <img src={url} alt="Deine handschriftliche Antwort" style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid var(--border)" }} />}
    </div>
  );
}

function SelfGrade({ item, answer, onSave }: { item: Item; answer: ReactNode; onSave: (score: number, errorType?: ErrorType) => void }) {
  const [hit, setHit] = useState<Set<number>>(new Set());
  const [errorType, setErrorType] = useState<ErrorType>("none");
  const rubric = item.rubric;
  const score = rubric.length ? hit.size / rubric.length : 0;
  return (
    <div className="stack">
      <Solution item={item} />
      {answer}
      {rubric.length > 0 ? (
        <div className="card">
          <b>Was hattest du richtig?</b>
          {rubric.map((r, i) => (
            <label key={i} className="check">
              <input type="checkbox" checked={hit.has(i)} onChange={() => { const n = new Set(hit); if (n.has(i)) n.delete(i); else n.add(i); setHit(n); }} />
              <MathText text={r} />
            </label>
          ))}
          <div className="spread" style={{ marginTop: 10 }}>
            <label className="row">
              Fehlerart:
              <select value={errorType} onChange={(e) => setErrorType(e.target.value as ErrorType)} style={{ width: "auto" }}>
                {ERROR_TYPES.filter((e) => e !== "unreadable").map((e) => <option key={e} value={e}>{ERROR_TYPE_LABELS[e]}</option>)}
              </select>
            </label>
            <button className="primary" onClick={() => onSave(score, score === 1 ? "none" : errorType === "none" ? "incomplete" : errorType)}>
              Speichern ({Math.round(score * 100)} %) & weiter
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button onClick={() => onSave(0, "concept")}>❌ Falsch</button>
          <button onClick={() => onSave(0.5, "incomplete")}>〰️ Teilweise</button>
          <button className="primary" onClick={() => onSave(1, "none")}>✅ Richtig</button>
        </div>
      )}
    </div>
  );
}

function AiResult({ item, result, answer, onSave }: { item: Item; result: GradeResult; answer: ReactNode; onSave: (i: AttemptInput) => void }) {
  const cls = result.verdict === "correct" ? "good" : result.verdict === "partial" ? "warn" : "error";
  const base = { feedback: result.feedback, missedConcepts: result.missedConcepts, transcription: result.transcription };
  return (
    <div className="stack" data-testid="ai-result">
      <div className={`notice ${cls}`}>
        <div className="spread">
          <span className="score-big">{Math.round(result.score * 100)} %</span>
          {result.errorType !== "none" && <span className="badge bad">{ERROR_TYPE_LABELS[result.errorType]}</span>}
        </div>
        <MathText text={result.feedback} />
        {result.missedConcepts.length > 0 && <MathText className="small" text={`**Nachholen:** ${result.missedConcepts.join(", ")}`} />}
      </div>
      {result.transcription && (
        <details className="card">
          <summary>So hat die KI deine Handschrift gelesen</summary>
          <MathText text={result.transcription} />
        </details>
      )}
      <details className="card" open={result.verdict !== "correct"}>
        <summary>Musterlösung</summary>
        <MathText text={item.answer} />
      </details>
      {answer}
      <div className="row">
        <button className="primary" onClick={() => onSave({ ...base, score: result.score, mode: "ai", errorType: result.errorType })}>Übernehmen & weiter</button>
        <span className="muted small">Bewertung falsch? Korrigieren:</span>
        <button className="small" onClick={() => onSave({ ...base, score: 0, mode: "self", errorType: result.errorType === "none" ? "concept" : result.errorType })}>Falsch</button>
        <button className="small" onClick={() => onSave({ ...base, score: 0.5, mode: "self", errorType: result.errorType === "none" ? "incomplete" : result.errorType })}>Teilweise</button>
        <button className="small" onClick={() => onSave({ ...base, score: 1, mode: "self", errorType: "none" })}>Richtig</button>
      </div>
    </div>
  );
}
