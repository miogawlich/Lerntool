import { Rating, createEmptyCard, fsrs, type Grade } from "ts-fsrs";
import type { Attempt, Item, StoredCard, Topic } from "./db";
import { cardToStored, storedToCard } from "./db";

const f = fsrs({ enable_fuzz: true });

export function newCard(now = new Date()): StoredCard {
  return cardToStored(createEmptyCard(now));
}

/** Score 0–1 → FSRS-Bewertung. */
export function scoreToRating(score: number): Grade {
  if (score >= 0.95) return Rating.Good;
  if (score >= 0.6) return Rating.Hard;
  return Rating.Again;
}

export function review(card: StoredCard, rating: Grade, now = new Date()): StoredCard {
  return cardToStored(f.next(storedToCard(card), now, rating).card);
}

/** Vorschau der Intervalle für die vier Bewertungsknöpfe (Karteikarten). */
export function previewIntervals(card: StoredCard, now = new Date()): Record<"again" | "hard" | "good" | "easy", number> {
  const p = f.repeat(storedToCard(card), now);
  const ms = (g: Grade) => p[g].card.due.getTime() - now.getTime();
  return { again: ms(Rating.Again), hard: ms(Rating.Hard), good: ms(Rating.Good), easy: ms(Rating.Easy) };
}

export function formatInterval(ms: number): string {
  const min = ms / 60000;
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)} h`;
  const d = h / 24;
  if (d < 31) return `${Math.round(d)} T`;
  const mo = d / 30;
  if (mo < 12) return `${Math.round(mo)} Mon`;
  return `${(d / 365).toFixed(1)} J`;
}

export interface TopicMastery {
  topicId: string;
  /** 0–1, gleitender Mittelwert der Ergebnisse (neuere zählen stärker). */
  mastery: number;
  attempts: number;
  lastAt?: number;
  /** Weniger als 3 Versuche: Wert noch unsicher. */
  uncertain: boolean;
}

const ALPHA = 0.4;
/** Startwert vor dem ersten Versuch (ein einzelnes Ergebnis soll nicht alles bestimmen). */
const PRIOR = 0.5;
const HALF_LIFE_DAYS = 21;

/**
 * Mastery pro Thema: exponentiell gleitender Mittelwert über die Versuche (chronologisch),
 * danach leichter Zerfall Richtung 0.5, wenn das Thema lange nicht geübt wurde.
 */
export function computeMastery(topics: Topic[], attempts: Attempt[], now = Date.now()): Map<string, TopicMastery> {
  const byTopic = new Map<string, Attempt[]>();
  for (const a of attempts) {
    const arr = byTopic.get(a.topicId) ?? [];
    arr.push(a);
    byTopic.set(a.topicId, arr);
  }
  const out = new Map<string, TopicMastery>();
  for (const t of topics) {
    const list = (byTopic.get(t.id) ?? []).sort((a, b) => a.at - b.at);
    if (!list.length) {
      out.set(t.id, { topicId: t.id, mastery: 0, attempts: 0, uncertain: true });
      continue;
    }
    let m = PRIOR;
    for (const a of list) m = ALPHA * a.score + (1 - ALPHA) * m;
    const lastAt = list[list.length - 1].at;
    const ageDays = (now - lastAt) / 86_400_000;
    const decay = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    // Gutes Wissen verblasst langsam; schlechtes wird nicht „besser“ durch Nichtstun.
    const decayed = m > 0.5 ? 0.5 + (m - 0.5) * decay : m;
    out.set(t.id, { topicId: t.id, mastery: decayed, attempts: list.length, lastAt, uncertain: list.length < 3 });
  }
  return out;
}

/** Schwächste Themen zuerst; ungeübte Themen ganz vorne. */
export function weakestTopics(topics: Topic[], mastery: Map<string, TopicMastery>, threshold = 0.75): Topic[] {
  return topics
    .filter((t) => (mastery.get(t.id)?.mastery ?? 0) < threshold)
    .sort((a, b) => {
      const ma = mastery.get(a.id)!;
      const mb = mastery.get(b.id)!;
      if ((ma.attempts === 0) !== (mb.attempts === 0)) return ma.attempts === 0 ? 1 : -1;
      return ma.mastery - mb.mastery;
    });
}

export type SessionMode = "due" | "weak" | "topic" | "all";

export interface SessionOptions {
  mode: SessionMode;
  topicId?: string;
  limit?: number;
  newLimit?: number;
  now?: number;
}

/**
 * Stellt die Warteschlange einer Lernsession zusammen.
 * - due: fällige Wiederholungen + bis zu newLimit neue Items (gemischt nach Themen)
 * - weak: Items der schwächsten Themen; fällige und zuletzt falsch beantwortete zuerst
 * - topic: alle Items eines Themas, fällige zuerst
 */
export function buildSession(items: Item[], topics: Topic[], attempts: Attempt[], opts: SessionOptions): Item[] {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 20;
  const active = items.filter((i) => !i.suspended);
  const lastScore = new Map<string, number>();
  for (const a of [...attempts].sort((x, y) => x.at - y.at)) lastScore.set(a.itemId, a.score);
  const isNew = (i: Item) => i.card.reps === 0;

  if (opts.mode === "topic") {
    const list = active.filter((i) => i.topicId === opts.topicId);
    return list.sort((a, b) => Number(isNew(a)) - Number(isNew(b)) || a.due - b.due).slice(0, limit);
  }

  if (opts.mode === "weak") {
    const mastery = computeMastery(topics, attempts, now);
    const weak = weakestTopics(topics, mastery).filter((t) => (mastery.get(t.id)?.attempts ?? 0) > 0);
    const rank = new Map(weak.map((t, i) => [t.id, i]));
    const list = active.filter((i) => rank.has(i.topicId) && !isNew(i));
    const prio = (i: Item) => (lastScore.get(i.id) ?? 1) - (i.due <= now ? 0.5 : 0) + rank.get(i.topicId)! * 0.05;
    return list.sort((a, b) => prio(a) - prio(b)).slice(0, limit);
  }

  const due = active.filter((i) => !isNew(i) && i.due <= now).sort((a, b) => a.due - b.due);
  if (opts.mode === "all") return [...due, ...active.filter(isNew)].slice(0, limit);
  const fresh = interleaveByTopic(active.filter(isNew)).slice(0, opts.newLimit ?? 10);
  return [...due, ...fresh].slice(0, limit);
}

/** Verteilt neue Items abwechselnd über Themen (Interleaving hilft beim Lernen). */
export function interleaveByTopic(items: Item[]): Item[] {
  const groups = new Map<string, Item[]>();
  for (const i of [...items].sort((a, b) => a.createdAt - b.createdAt || a.difficulty - b.difficulty)) {
    const g = groups.get(i.topicId) ?? [];
    g.push(i);
    groups.set(i.topicId, g);
  }
  const out: Item[] = [];
  const queues = [...groups.values()];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift()!);
  return out;
}

export function errorTypeStats(attempts: Attempt[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of attempts) if (a.errorType && a.errorType !== "none") m.set(a.errorType, (m.get(a.errorType) ?? 0) + 1);
  return m;
}
