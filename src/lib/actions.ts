import type { Grade } from "ts-fsrs";
import { analyzeDocuments, generateItems, generateVariations, type CallOptions, type DocInput } from "./ai/service";
import type { LLMBackend } from "./ai/types";
import { blobToBase64, db as defaultDb, newId, type Attempt, type DocKind, type Item, type LernDB, type Topic } from "./db";
import type { ErrorType, FormatMix, GeneratedItem, TopicData } from "./schemas";
import { newCard, review, scoreToRating } from "./scheduler";

export async function createCourse(name: string, database: LernDB = defaultDb): Promise<string> {
  const id = newId();
  await database.courses.add({ id, name: name.trim() || "Neuer Kurs", createdAt: Date.now() });
  return id;
}

export async function addDocuments(courseId: string, files: File[], kind: DocKind, database: LernDB = defaultDb) {
  const recs = files.map((f) => ({
    id: newId(),
    courseId,
    name: f.name,
    kind,
    bytes: f.size,
    blob: f as Blob,
    addedAt: Date.now(),
  }));
  await database.documents.bulkAdd(recs);
  return recs.map((r) => r.id);
}

async function docInputs(courseId: string, database: LernDB, onlyIds?: string[]): Promise<DocInput[]> {
  const docs = await database.documents.where("courseId").equals(courseId).toArray();
  const chosen = onlyIds ? docs.filter((d) => onlyIds.includes(d.id)) : docs;
  return Promise.all(chosen.map(async (d) => ({ name: d.name, kind: d.kind, bytes: d.bytes, base64: await blobToBase64(d.blob) })));
}

export function topicToData(t: Topic): TopicData {
  return {
    name: t.name,
    summary: t.summary,
    concepts: t.concepts,
    formulas: t.formulas,
    examRelevance: t.examRelevance,
    examPatterns: t.examPatterns,
  };
}

/** Analysiert noch nicht analysierte Dokumente (oder alle) und aktualisiert Themen + empfohlenen Mix. */
export async function analyzeCourse(
  backend: LLMBackend,
  courseId: string,
  opts: CallOptions & { all?: boolean } = {},
  database: LernDB = defaultDb,
) {
  const course = await database.courses.get(courseId);
  if (!course) throw new Error("Kurs nicht gefunden");
  const allDocs = await database.documents.where("courseId").equals(courseId).toArray();
  const targets = opts.all ? allDocs : allDocs.filter((d) => !d.analyzedAt);
  if (!targets.length) return { added: 0, updated: 0 };
  const existing = await database.topics.where("courseId").equals(courseId).sortBy("order");
  const inputs = await docInputs(courseId, database, targets.map((d) => d.id));
  const analysis = await analyzeDocuments(backend, course.name, inputs, existing.map(topicToData), opts);

  let added = 0,
    updated = 0;
  await database.transaction("rw", [database.topics, database.documents, database.courses], async () => {
    const byName = new Map(existing.map((t) => [t.name.trim().toLowerCase(), t]));
    let order = existing.length;
    for (const t of analysis.topics) {
      const prev = byName.get(t.name.trim().toLowerCase());
      if (prev) {
        await database.topics.update(prev.id, { ...t, name: prev.name });
        updated++;
      } else {
        await database.topics.add({ id: newId(), courseId, order: order++, ...t });
        added++;
      }
    }
    const now = Date.now();
    await database.documents.bulkUpdate(targets.map((d) => ({ key: d.id, changes: { analyzedAt: now } })));
    await database.courses.update(courseId, {
      subject: analysis.subject,
      // Einen vom Nutzer angepassten Mix nicht überschreiben.
      ...(course.mix ? {} : { mix: analysis.recommendedMix }),
      mixReasoning: analysis.mixReasoning,
    });
  });
  return { added, updated };
}

function toItem(g: GeneratedItem, courseId: string, topicId: string, source: Item["source"]): Item {
  const card = newCard();
  const { topicName: _ignored, ...rest } = g;
  void _ignored;
  return { ...rest, id: newId(), courseId, topicId, createdAt: Date.now(), source, card, due: card.due };
}

export async function generateForTopics(
  backend: LLMBackend,
  courseId: string,
  topicIds: string[],
  countPerTopic: number,
  mix: FormatMix,
  opts: CallOptions = {},
  database: LernDB = defaultDb,
): Promise<number> {
  const course = await database.courses.get(courseId);
  if (!course) throw new Error("Kurs nicht gefunden");
  const topics = (await database.topics.bulkGet(topicIds)).filter((t): t is Topic => !!t);
  const specs = await Promise.all(
    topics.map(async (t) => ({
      topic: topicToData(t),
      count: countPerTopic,
      existingPrompts: (await database.items.where("topicId").equals(t.id).toArray()).map((i) => i.prompt),
    })),
  );
  const docs = await docInputs(courseId, database);
  const generated = await generateItems(backend, course.name, specs, mix, docs, opts);
  const byName = new Map(topics.map((t) => [t.name, t.id]));
  const items = generated.map((g) => toItem(g, courseId, byName.get(g.topicName) ?? topics[0].id, "generated"));
  await database.items.bulkAdd(items);
  return items.length;
}

/** Erzeugt neue Aufgaben, die gezielt die Fehler der letzten Versuche in einem Thema adressieren. */
export async function generateWeaknessVariations(
  backend: LLMBackend,
  courseId: string,
  topicId: string,
  count: number,
  opts: CallOptions = {},
  database: LernDB = defaultDb,
): Promise<number> {
  const course = await database.courses.get(courseId);
  const topic = await database.topics.get(topicId);
  if (!course || !topic) throw new Error("Thema nicht gefunden");
  const attempts = (await database.attempts.where("topicId").equals(topicId).toArray()).sort((a, b) => b.at - a.at);
  const weakAttempts = attempts.filter((a) => a.score < 0.85).slice(0, 6);
  const items = await database.items.bulkGet([...new Set(weakAttempts.map((a) => a.itemId))]);
  const sources = items
    .filter((i): i is Item => !!i)
    .map((i) => {
      const a = weakAttempts.find((x) => x.itemId === i.id);
      return {
        item: { ...i, topicName: topic.name },
        lastFeedback: a?.feedback,
        missedConcepts: a?.missedConcepts ?? [],
      };
    });
  if (!sources.length) {
    // Noch keine Fehler: allgemeine Übungsaufgaben zum Thema
    const mix = course.mix ?? { flashcard: 25, multiple_choice: 25, short_answer: 25, worked_problem: 25 };
    return generateForTopics(backend, courseId, [topicId], count, mix, opts, database);
  }
  const docs = await docInputs(courseId, database);
  const generated = await generateVariations(backend, course.name, topicToData(topic), sources, count, docs, opts);
  const newItems = generated.map((g) => toItem(g, courseId, topicId, "variation"));
  await database.items.bulkAdd(newItems);
  return newItems.length;
}

export interface AttemptInput {
  score: number;
  mode: Attempt["mode"];
  /** Für Karteikarten: direkte FSRS-Bewertung statt aus dem Score abgeleitet. */
  rating?: Grade;
  errorType?: ErrorType;
  feedback?: string;
  missedConcepts?: string[];
  answerText?: string;
  answerImage?: Blob;
  transcription?: string;
}

export async function recordAttempt(item: Item, input: AttemptInput, database: LernDB = defaultDb): Promise<Item> {
  const { rating, ...rest } = input;
  const now = new Date();
  const card = review(item.card, rating ?? scoreToRating(input.score), now);
  const updated: Item = { ...item, card, due: card.due };
  await database.transaction("rw", [database.items, database.attempts], async () => {
    await database.attempts.add({
      id: newId(),
      itemId: item.id,
      topicId: item.topicId,
      courseId: item.courseId,
      at: now.getTime(),
      ...rest,
    });
    await database.items.put(updated);
  });
  return updated;
}
