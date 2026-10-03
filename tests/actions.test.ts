import { describe, expect, it } from "vitest";
import Dexie from "dexie";
import { addDocuments, analyzeCourse, createCourse, generateForTopics, generateWeaknessVariations, recordAttempt } from "../src/lib/actions";
import { exportAll, importAll } from "../src/lib/backup";
import { LernDB } from "../src/lib/db";
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
    const be = new FakeBackend([JSON.stringify({ items: [item("Ableitungen", "worked_problem", "Leite ab"), item("Ableitungen", "short_answer", "Kettenregel?")] })]);
    expect(await generateForTopics(be, courseId, [t.id], 2, sampleAnalysis.recommendedMix, {}, db)).toBe(2);
    // PDFs wurden als Kontext mitgeschickt
    expect(be.requests[0].parts.filter((p) => p.type === "pdf")).toHaveLength(2);

    const items = await db.items.where("topicId").equals(t.id).toArray();
    const wp = items.find((i) => i.type === "worked_problem")!;
    const updated = await recordAttempt(wp, { score: 0.2, mode: "ai", errorType: "concept", feedback: "Kettenregel vergessen", missedConcepts: ["Kettenregel"] }, db);
    expect(updated.card.reps).toBe(1);
    expect(await db.attempts.count()).toBe(1);

    const sa = items.find((i) => i.type === "short_answer")!;
    await recordAttempt(sa, { score: 1, mode: "self" }, db);
    expect((await db.items.get(sa.id))!.card.due).toBeGreaterThan(updated.card.due);

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

  it("Import alter Sicherungen: Karteikarten werden zu Kurzantworten", async () => {
    const { db } = await setup();
    const data = JSON.parse(await exportAll(db));
    data.courses[0].mix = { flashcard: 20, multiple_choice: 20, short_answer: 10, worked_problem: 50 };
    data.items = [{ id: "alt", courseId: data.courses[0].id, topicId: "t", type: "flashcard", prompt: "Kettenregel?", answer: "$(f\\circ g)' = f'(g)g'$", options: [], rubric: [] }];
    const db2 = freshDb();
    await importAll(JSON.stringify(data), db2);
    expect((await db2.items.get("alt"))!).toMatchObject({ type: "short_answer", answer: "$(f\\circ g)' = f'(g)g'$" });
    expect((await db2.courses.toArray())[0].mix).toEqual({ multiple_choice: 20, short_answer: 30, worked_problem: 50 });
  });
});

describe("DB-Migration v2", () => {
  it("wandelt gespeicherte Karteikarten in Kurzantworten um", async () => {
    const name = `migr-${Date.now()}`;
    const old = new Dexie(name);
    old.version(1).stores({ courses: "id, createdAt", documents: "id, courseId", topics: "id, courseId, [courseId+order]", items: "id, courseId, topicId, due, [courseId+due]", attempts: "id, itemId, topicId, courseId, at", usage: "++id, at" });
    await old.table("courses").add({ id: "c", name: "K", createdAt: 0, mix: { flashcard: 25, multiple_choice: 25, short_answer: 25, worked_problem: 25 } });
    await old.table("items").bulkAdd([
      { id: "f", courseId: "c", topicId: "t", due: 0, type: "flashcard", prompt: "Vorderseite", answer: "Rückseite", options: [], rubric: [] },
      { id: "m", courseId: "c", topicId: "t", due: 0, type: "multiple_choice", prompt: "MC", answer: "", options: [], rubric: [] },
    ]);
    old.close();
    const db = new LernDB(name);
    expect(await db.items.get("f")).toMatchObject({ type: "short_answer", prompt: "Vorderseite", answer: "Rückseite" });
    expect((await db.items.get("m"))!.type).toBe("multiple_choice");
    expect((await db.courses.get("c"))!.mix).toEqual({ multiple_choice: 25, short_answer: 50, worked_problem: 25 });
  });
});
