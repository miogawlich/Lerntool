import Dexie, { type EntityTable } from "dexie";
import type { Card } from "ts-fsrs";
import { migrateItem, migrateMix, type ErrorType, type ExamRelevance, type FormatMix, type GeneratedItem } from "./schemas";

export interface Course {
  id: string;
  name: string;
  createdAt: number;
  subject?: string;
  mix?: FormatMix;
  mixReasoning?: string;
}

export type DocKind = "slides" | "exam" | "other";

export interface DocumentRec {
  id: string;
  courseId: string;
  name: string;
  kind: DocKind;
  bytes: number;
  /** Geschätzte Seitenzahl (für Kostenschätzung). */
  pages?: number;
  blob: Blob;
  addedAt: number;
  analyzedAt?: number;
}

export interface Topic {
  id: string;
  courseId: string;
  name: string;
  summary: string;
  concepts: string[];
  formulas: string[];
  examRelevance: ExamRelevance;
  examPatterns: string;
  order: number;
}

/** Serialisierte FSRS-Karte (Dates als Zahlen, damit Export/Import einfach bleibt). */
export interface StoredCard {
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review?: number;
}

export interface Item extends Omit<GeneratedItem, "topicName"> {
  id: string;
  courseId: string;
  topicId: string;
  createdAt: number;
  source: "generated" | "variation";
  card: StoredCard;
  /** Index-Feld: Fälligkeit (für schnelle Abfragen). */
  due: number;
  suspended?: boolean;
}

export type GradeMode = "auto" | "self" | "ai";

export interface Attempt {
  id: string;
  itemId: string;
  topicId: string;
  courseId: string;
  at: number;
  score: number;
  mode: GradeMode;
  errorType?: ErrorType;
  feedback?: string;
  missedConcepts?: string[];
  answerText?: string;
  answerImage?: Blob;
  transcription?: string;
}

export interface UsageRec {
  id?: number;
  at: number;
  provider: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
}

export class LernDB extends Dexie {
  courses!: EntityTable<Course, "id">;
  documents!: EntityTable<DocumentRec, "id">;
  topics!: EntityTable<Topic, "id">;
  items!: EntityTable<Item, "id">;
  attempts!: EntityTable<Attempt, "id">;
  usage!: EntityTable<UsageRec, "id">;

  constructor(name = "lerntool") {
    super(name);
    this.version(1).stores({
      courses: "id, createdAt",
      documents: "id, courseId",
      topics: "id, courseId, [courseId+order]",
      items: "id, courseId, topicId, due, [courseId+due]",
      attempts: "id, itemId, topicId, courseId, at",
      usage: "++id, at",
    });
    // v2: Fragetyp „Karteikarte“ entfällt → Kurzantwort, Mix-Anteil geht in Kurzantwort über.
    this.version(2).upgrade(async (tx) => {
      await tx.table("items").toCollection().modify((i: Item) => Object.assign(i, migrateItem(i)));
      await tx.table("courses").toCollection().modify((c: Course) => {
        if (c.mix) c.mix = migrateMix(c.mix);
      });
    });
  }
}

export const db = new LernDB();

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

export function cardToStored(c: Card): StoredCard {
  return {
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: c.last_review?.getTime(),
  };
}

export function storedToCard(s: StoredCard): Card {
  return {
    ...s,
    due: new Date(s.due),
    last_review: s.last_review !== undefined ? new Date(s.last_review) : undefined,
  } as Card;
}

export async function deleteCourse(courseId: string, database: LernDB = db) {
  await database.transaction("rw", [database.courses, database.documents, database.topics, database.items, database.attempts], async () => {
    await database.documents.where("courseId").equals(courseId).delete();
    await database.topics.where("courseId").equals(courseId).delete();
    await database.items.where("courseId").equals(courseId).delete();
    await database.attempts.where("courseId").equals(courseId).delete();
    await database.courses.delete(courseId);
  });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  return btoa(bin);
}

export function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type });
}
