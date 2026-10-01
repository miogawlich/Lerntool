import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";
import { addDocuments, analyzeCourse, createCourse, generateForTopics, generateWeaknessVariations, recordAttempt } from "../src/lib/actions";
import { exportAll, importAll } from "../src/lib/backup";
import { FakeBackend, freshDb, item, sampleAnalysis } from "./helpers";

const pdf = (name: string) => new File([new Uint8Array([37, 80, 68, 70, 45, 49])], name, { type: "application/pdf" });

async function setup() {
  const db = freshDb();
  const courseId = await createCourse("Analysis I", db);
  await addDocuments(courseId, [pdf("folien.pdf")], "slides", db);
  await addDocuments(courseId, [pdf("klausur.pdf")], "exam", db);
  const be = new FakeBackend([JSON.stringify(sampleAnalysis)]);
  await analyzeCourse(be, courseId, {}, db);
  return { db, courseId };
}

describe("Kurs-Workflow", () => {
  it("Analyse legt Themen und Mix an und markiert Dokumente", async () => {
    const { db, courseId } = await setup();
    expect(await db.topics.count()).toBe(2);
    const course = await db.courses.get(courseId);
    expect(course?.mix?.worked_problem).toBe(50);
    expect((await db.documents.toArray()).every((d) => d.analyzedAt)).toBe(true);
    // Zweiter Lauf ohne neue Dokumente: kein KI-Aufruf
    const be = new FakeBackend([]);
    expect(await analyzeCourse(be, courseId, {}, db)).toEqual({ added: 0, updated: 0 });
  });

  it("Generierung, Versuch und Variationen", async () => {
    const { db, courseId } = await setup();
    const topics = await db.topics.toArray();
    const t = topics.find((x) => x.name === "Ableitungen")!;
    const be = new FakeBackend([JSON.stringify({ items: [item("Ableitungen", "worked_problem", "Leite ab"), item("Ableitungen", "flashcard", "Kettenregel?")] })]);
    expect(await generateForTopics(be, courseId, [t.id], 2, sampleAnalysis.recommendedMix, {}, db)).toBe(2);
    // PDFs wurden als Kontext mitgeschickt
    expect(be.requests[0].parts.filter((p) => p.type === "pdf")).toHaveLength(2);

    const items = await db.items.where("topicId").equals(t.id).toArray();
    const wp = items.find((i) => i.type === "worked_problem")!;
    const updated = await recordAttempt(wp, { score: 0.2, mode: "ai", errorType: "concept", feedback: "Kettenregel vergessen", missedConcepts: ["Kettenregel"] }, db);
    expect(updated.card.reps).toBe(1);
    expect(await db.attempts.count()).toBe(1);

    const fc = items.find((i) => i.type === "flashcard")!;
    await recordAttempt(fc, { score: 1, mode: "self", rating: Rating.Easy }, db);
    expect((await db.items.get(fc.id))!.card.due).toBeGreaterThan(updated.card.due);

    const be2 = new FakeBackend([JSON.stringify({ items: [item("Ableitungen", "worked_problem", "Variation")] })]);
    expect(await generateWeaknessVariations(be2, courseId, t.id, 1, {}, db)).toBe(1);
    const prompt = (be2.requests[0].parts.at(-1) as { text: string }).text;
    expect(prompt).toContain("Kettenregel vergessen");
    expect((await db.items.where("topicId").equals(t.id).toArray()).some((i) => i.source === "variation")).toBe(true);
  });

  it("Export/Import inkl. PDFs", async () => {
    const { db } = await setup();
    const json = await exportAll(db);
    expect(json).not.toContain("geminiKey");
    const db2 = freshDb();
    const res = await importAll(json, db2);
    expect(res.courses).toBe(1);
    const docs = await db2.documents.toArray();
    expect(docs).toHaveLength(2);
    expect(new Uint8Array(await docs[0].blob.arrayBuffer())[0]).toBe(37);
    await expect(importAll('{"app":"x"}', db2)).rejects.toThrow(/keine Lerntool-Sicherung/);
  });
});
