import type { ExamRelevance } from "../lib/schemas";

export function masteryColor(m: number) {
  return m >= 0.75 ? "var(--good)" : m >= 0.5 ? "var(--warn)" : "var(--bad)";
}

export function MasteryBar({ value, attempts }: { value: number; attempts: number }) {
  if (!attempts) return <span className="badge">noch nicht geübt</span>;
  return (
    <div className="row" style={{ gap: 8, flexWrap: "nowrap" }} title={`${Math.round(value * 100)} % aus ${attempts} Versuchen`}>
      <div className="bar" style={{ flex: 1, minWidth: 80 }}>
        <div style={{ width: `${Math.round(value * 100)}%`, background: masteryColor(value) }} />
      </div>
      <span className="small muted" style={{ minWidth: 40 }}>
        {Math.round(value * 100)} %
      </span>
    </div>
  );
}

export function RelevanceBadge({ r }: { r: ExamRelevance }) {
  const cls = r === "hoch" ? "bad" : r === "mittel" ? "warn" : "";
  return <span className={`badge ${cls}`}>Klausur: {r}</span>;
}

export function Difficulty({ d }: { d: number }) {
  return <span className="badge" title="Schwierigkeit">{"●".repeat(d) + "○".repeat(Math.max(0, 3 - d))}</span>;
}

export function formatBytes(b: number) {
  return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}
