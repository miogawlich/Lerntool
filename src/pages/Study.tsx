import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Rating, type Grade } from "ts-fsrs";
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
import { buildSession, formatInterval, previewIntervals, type SessionMode } from "../lib/scheduler";
import { getSettings, hasActiveKey, useSettings } from "../lib/settings";

export function StudyPage() {
  const { courseId = "" } = useParams();
  const [params] = useSearchParams();
  const mode = (params.get("mode") as SessionMode) || "due";
  const topicId = params.get("topic") ?? undefined;
  const [queue, setQueue] = useState<Item[] | null>(null);
  const [topics, setTopics] = useState<Map<string, Topic>>(new Map());
  const [pos, setPos] = useState(0);
  const [scores, setScores] = useState<number[]>([]);

  useEffect(() => {
    (async () => {
      const [items, tps, attempts] = await Promise.all([
        db.items.where("courseId").equals(courseId).toArray(),
        db.topics.where("courseId").equals(courseId).toArray(),
        db.attempts.where("courseId").equals(courseId).toArray(),
      ]);
      setTopics(new Map(tps.map((t) => [t.id, t])));
      setQueue(buildSession(items, tps, attempts, { mode, topicId, limit: mode === "all" ? 200 : 20, newLimit: getSettings().newPerSession }));
    })();
  }, [courseId, mode, topicId]);

  if (!queue) return <main className="page">Lädt …</main>;

  if (pos >= queue.length) {
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    return (
      <main className="page stack">
        <div className="card stack" data-testid="session-done">
          <h1>{queue.length ? "Geschafft! 🎉" : "Gerade nichts zu tun"}</h1>
          {queue.length ? (
            <p>{scores.length} Aufgaben bearbeitet, Ø {Math.round(avg * 100)} % richtig.</p>
          ) : (
            <p className="muted">{mode === "weak" ? "Noch keine Schwächen erkannt – erst ein paar Aufgaben lernen." : "Keine fälligen oder neuen Aufgaben. Erzeuge neue Aufgaben oder komm später wieder."}</p>
          )}
          <div className="row">
            <Link className="btn primary" to={`/course/${courseId}`}>Zur Kursübersicht</Link>
            {mode !== "weak" && <Link className="btn" to={`/course/${courseId}/study?mode=weak`} onClick={() => { setQueue(null); setPos(0); setScores([]); }}>🎯 Schwächen üben</Link>}
          </div>
        </div>
      </main>
    );
  }

  const item = queue[pos];
  const done = (score: number) => {
    setScores((s) => [...s, score]);
    setPos((p) => p + 1);
    window.scrollTo({ top: 0 });
  };

  return (
    <main className="page">
      <ErrorBanner />
      <div className="study-head">
        <div className="row">
          <span className="badge accent">{ITEM_TYPE_LABELS[item.type]}</span>
          <Difficulty d={item.difficulty} />
          <span className="small muted">{topics.get(item.topicId)?.name}</span>
        </div>
        <span className="small muted" data-testid="progress">{pos + 1} / {queue.length}</span>
      </div>
      <div className="bar" style={{ marginBottom: 16 }}><div style={{ width: `${(pos / queue.length) * 100}%`, background: "var(--accent)" }} /></div>
      {item.type === "flashcard" && <Flashcard key={item.id} item={item} onDone={done} />}
      {item.type === "multiple_choice" && <MultipleChoice key={item.id} item={item} onDone={done} />}
      {(item.type === "short_answer" || item.type === "worked_problem") && <OpenAnswer key={item.id} item={item} onDone={done} />}
    </main>
  );
}

function Flashcard({ item, onDone }: { item: Item; onDone: (s: number) => void }) {
  const [shown, setShown] = useState(false);
  const iv = useMemo(() => previewIntervals(item.card), [item]);
  const rate = async (rating: Grade, score: number) => {
    await recordAttempt(item, { score, mode: "self", rating });
    onDone(score);
  };
  return (
    <div className="stack">
      <div className="card flash-card" onClick={() => setShown(true)} role="button" aria-label="Karte umdrehen">
        <MathText className="prompt" text={item.prompt} />
        {shown && (
          <>
            <hr style={{ width: "100%", border: 0, borderTop: "1px solid var(--border)", margin: "18px 0" }} />
            <MathText text={item.answer} />
          </>
        )}
      </div>
      {!shown ? (
        <button className="primary" onClick={() => setShown(true)} style={{ width: "100%" }}>Antwort zeigen</button>
      ) : (
        <div className="rating">
          <button onClick={() => rate(Rating.Again, 0)}>Nochmal<small>{formatInterval(iv.again)}</small></button>
          <button onClick={() => rate(Rating.Hard, 0.5)}>Schwer<small>{formatInterval(iv.hard)}</small></button>
          <button className="primary" onClick={() => rate(Rating.Good, 0.85)}>Gut<small style={{ color: "inherit" }}>{formatInterval(iv.good)}</small></button>
          <button onClick={() => rate(Rating.Easy, 1)}>Einfach<small>{formatInterval(iv.easy)}</small></button>
        </div>
      )}
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

function MultipleChoice({ item, onDone }: { item: Item; onDone: (s: number) => void }) {
  const multi = item.options.filter((o) => o.correct).length > 1;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [checked, setChecked] = useState(false);
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
  };
  return (
    <div className="stack">
      <div className="card">
        <MathText className="prompt" text={item.prompt} />
        {multi && <p className="small muted">Mehrere Antworten können richtig sein.</p>}
      </div>
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
          <button className="primary" onClick={() => onDone(score)}>Weiter</button>
        </div>
      )}
    </div>
  );
}

type Phase = { kind: "answer" } | { kind: "self" } | { kind: "ai"; result: GradeResult };

function OpenAnswer({ item, onDone }: { item: Item; onDone: (s: number) => void }) {
  const settings = useSettings();
  const busy = useBusy();
  const [input, setInput] = useState<"ink" | "text">(item.type === "worked_problem" ? "ink" : "text");
  const [text, setText] = useState("");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "answer" });
  const image = useRef<{ base64: string; blob: Blob } | null>(null);
  const empty = !text.trim() && !strokes.length;

  const snapshot = async () => {
    image.current = strokes.length ? await exportStrokesPng(strokes) : null;
    return image.current;
  };

  const aiGrade = () =>
    busy.run("KI bewertet deine Antwort …", async ({ signal }) => {
      const img = await snapshot();
      const result = await gradeAnswer(await getBackend("grade"), { ...item, topicName: "" }, { text, imagePngBase64: img?.base64 }, defaultCallOptions({ signal }));
      setPhase({ kind: "ai", result });
    });

  const save = async (input: AttemptInput) => {
    await recordAttempt(item, { ...input, answerText: text || undefined, answerImage: image.current?.blob });
    onDone(input.score);
  };

  return (
    <div className="stack">
      <div className="card">
        <MathText className="prompt" text={item.prompt} />
      </div>
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
        <SelfGrade item={item} answer={<YourAnswer text={text} image={image.current?.blob} />} onSave={(score, errorType) => save({ score, mode: "self", errorType })} />
      )}
      {phase.kind === "ai" && <AiResult item={item} result={phase.result} answer={<YourAnswer text={text} image={image.current?.blob} />} onSave={save} />}
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
