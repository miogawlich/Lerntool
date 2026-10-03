import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";
import type { Attempt, Item, Topic } from "../src/lib/db";
import { buildSession, computeMastery, interleaveByTopic, newCard, review, scoreToRating, weakestTopics } from "../src/lib/scheduler";

const DAY = 86_400_000;
const topic = (id: string): Topic => ({ id, courseId: "c", name: id, summary: "", concepts: [], formulas: [], examRelevance: "hoch", examPatterns: "", order: 0 });
const mkItem = (id: string, topicId: string, opts: Partial<Item> = {}): Item => {
  const card = newCard(new Date(0));
  return { id, courseId: "c", topicId, createdAt: 0, source: "generated", type: "short_answer", difficulty: 1, prompt: id, answer: "x", options: [], rubric: [], card, due: card.due, ...opts };
};
const att = (itemId: string, topicId: string, score: number, at: number): Attempt => ({ id: `${itemId}-${at}`, itemId, topicId, courseId: "c", at, score, mode: "auto" });

describe("FSRS", () => {
  it("bildet Scores auf Bewertungen ab", () => {
    expect(scoreToRating(1)).toBe(Rating.Good);
    expect(scoreToRating(0.7)).toBe(Rating.Hard);
    expect(scoreToRating(0.2)).toBe(Rating.Again);
  });
  it("richtige Antworten verschieben die Fälligkeit weiter als falsche", () => {
    const now = new Date();
    let good = newCard(now), bad = newCard(now);
    for (let i = 0; i < 3; i++) {
      const t = new Date(now.getTime() + i * 3 * DAY);
      good = review(good, Rating.Good, t);
      bad = review(bad, Rating.Again, t);
    }
    expect(good.due).toBeGreaterThan(bad.due);
  });
});

describe("Mastery", () => {
  const topics = [topic("t1"), topic("t2"), topic("t3")];
  const now = 100 * DAY;
  it("neuere Versuche zählen stärker", () => {
    const m = computeMastery(topics, [att("a", "t1", 0, now - 3), att("a", "t1", 1, now - 2), att("a", "t1", 1, now - 1)], now);
    const m2 = computeMastery(topics, [att("a", "t1", 1, now - 3), att("a", "t1", 1, now - 2), att("a", "t1", 0, now - 1)], now);
    expect(m.get("t1")!.mastery).toBeGreaterThan(m2.get("t1")!.mastery);
    expect(m.get("t2")!.attempts).toBe(0);
  });
  it("gutes Wissen verblasst ohne Übung", () => {
    const fresh = computeMastery(topics, [att("a", "t1", 1, now)], now).get("t1")!.mastery;
    const old = computeMastery(topics, [att("a", "t1", 1, now - 60 * DAY)], now).get("t1")!.mastery;
    expect(old).toBeLessThan(fresh);
    expect(old).toBeGreaterThanOrEqual(0.5);
  });
  it("sortiert schwache Themen nach vorne, ungeübte ans Ende", () => {
    const m = computeMastery(topics, [att("a", "t1", 0.6, now), att("b", "t2", 0.1, now)], now);
    expect(weakestTopics(topics, m).map((t) => t.id)).toEqual(["t2", "t1", "t3"]);
  });
});

describe("Session", () => {
  const now = 50 * DAY;
  const topics = [topic("t1"), topic("t2")];
  it("due-Modus: fällige zuerst, dann neue (verschränkt)", () => {
    const reviewed = mkItem("old", "t1", { card: { ...newCard(new Date(0)), reps: 2, due: now - 1 }, due: now - 1 });
    const notDue = mkItem("later", "t1", { card: { ...newCard(new Date(0)), reps: 2, due: now + DAY }, due: now + DAY });
    const items = [notDue, mkItem("n1", "t1"), mkItem("n2", "t1"), mkItem("m1", "t2"), reviewed];
    const s = buildSession(items, topics, [], { mode: "due", now, newLimit: 3 });
    expect(s.map((i) => i.id)).toEqual(["old", "n1", "m1", "n2"]);
  });
  it("weak-Modus: Items mit schlechtem letzten Ergebnis aus schwachen Themen", () => {
    const seen = (id: string, t: string) => mkItem(id, t, { card: { ...newCard(new Date(0)), reps: 1, due: now + DAY }, due: now + DAY });
    const items = [seen("good", "t1"), seen("bad", "t2"), seen("meh", "t2"), mkItem("new", "t2")];
    const attempts = [att("good", "t1", 1, now - 5), att("good", "t1", 1, now - 4), att("bad", "t2", 0, now - 3), att("meh", "t2", 0.5, now - 2)];
    const s = buildSession(items, topics, attempts, { mode: "weak", now });
    expect(s.map((i) => i.id)).toEqual(["bad", "meh"]);
  });
  it("Interleaving verteilt Themen", () => {
    const out = interleaveByTopic([mkItem("a1", "A"), mkItem("a2", "A"), mkItem("b1", "B")]);
    expect(out.map((i) => i.id)).toEqual(["a1", "b1", "a2"]);
  });
});
