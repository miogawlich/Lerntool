import { z } from "zod";

/**
 * Gemeinsame Antwort-Schemas für alle KI-Anbieter.
 * Bewusst ohne min/max-Constraints: Claude Structured Outputs unterstützen sie nicht,
 * Werte werden nach dem Parsen geklemmt (siehe normalize* unten).
 */

export const ITEM_TYPES = ["multiple_choice", "short_answer", "worked_problem"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  multiple_choice: "Multiple Choice",
  short_answer: "Kurzantwort",
  worked_problem: "Rechen-/Freitextaufgabe",
};

export const EXAM_RELEVANCE = ["hoch", "mittel", "niedrig"] as const;
export type ExamRelevance = (typeof EXAM_RELEVANCE)[number];

export const ERROR_TYPES = ["none", "concept", "calculation", "incomplete", "notation", "unreadable"] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export const ERROR_TYPE_LABELS: Record<ErrorType, string> = {
  none: "Kein Fehler",
  concept: "Konzeptfehler",
  calculation: "Rechenfehler",
  incomplete: "Unvollständig",
  notation: "Formaler Fehler/Notation",
  unreadable: "Nicht lesbar",
};

export const FormatMixSchema = z.object({
  multiple_choice: z.number(),
  short_answer: z.number(),
  worked_problem: z.number(),
});
export type FormatMix = z.infer<typeof FormatMixSchema>;

export const DEFAULT_MIX: FormatMix = { multiple_choice: 33, short_answer: 34, worked_problem: 33 };

/** Altbestand mit Karteikarten-Anteil: Der Anteil geht in die Kurzantworten über. */
export function migrateMix(mix: FormatMix & { flashcard?: number }): FormatMix {
  const { flashcard, ...rest } = mix;
  return flashcard ? { ...rest, short_answer: (rest.short_answer || 0) + flashcard } : rest;
}

/** Altbestand: Karteikarten werden zu Kurzantworten (Rückseite = Musterlösung). */
export function migrateItem<T extends { type: string }>(item: T): T {
  return (item.type as string) === "flashcard" ? { ...item, type: "short_answer" } : item;
}

export const TopicSchema = z.object({
  name: z.string(),
  summary: z.string(),
  concepts: z.array(z.string()),
  formulas: z.array(z.string()),
  examRelevance: z.enum(EXAM_RELEVANCE),
  examPatterns: z.string(),
});
export type TopicData = z.infer<typeof TopicSchema>;

export const AnalysisSchema = z.object({
  subject: z.string(),
  recommendedMix: FormatMixSchema,
  mixReasoning: z.string(),
  topics: z.array(TopicSchema),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const McOptionSchema = z.object({
  text: z.string(),
  correct: z.boolean(),
  explanation: z.string(),
});
export type McOption = z.infer<typeof McOptionSchema>;

/**
 * Flaches Item-Format, das für alle Typen funktioniert:
 * - multiple_choice: prompt = Frage, options = Antwortoptionen, answer = Gesamterklärung
 * - short_answer / worked_problem: prompt = Aufgabe, answer = Musterlösung, rubric = Bewertungsschema
 */
export const GeneratedItemSchema = z.object({
  topicName: z.string(),
  type: z.enum(ITEM_TYPES),
  difficulty: z.number(),
  prompt: z.string(),
  answer: z.string(),
  options: z.array(McOptionSchema),
  rubric: z.array(z.string()),
});
export type GeneratedItem = z.infer<typeof GeneratedItemSchema>;

export const GenerationSchema = z.object({
  items: z.array(GeneratedItemSchema),
});
export type Generation = z.infer<typeof GenerationSchema>;

export const GradeSchema = z.object({
  transcription: z.string(),
  score: z.number(),
  verdict: z.enum(["correct", "partial", "incorrect"]),
  errorType: z.enum(ERROR_TYPES),
  feedback: z.string(),
  missedConcepts: z.array(z.string()),
});
export type GradeResult = z.infer<typeof GradeSchema>;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

export function normalizeMix(mix: FormatMix): FormatMix {
  const vals = ITEM_TYPES.map((t) => Math.max(0, mix[t] || 0));
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return { ...DEFAULT_MIX };
  const out = {} as FormatMix;
  ITEM_TYPES.forEach((t, i) => (out[t] = Math.round((vals[i] / sum) * 100)));
  return out;
}

export function normalizeItem(item: GeneratedItem): GeneratedItem | null {
  if (!item.prompt.trim()) return null;
  const difficulty = Math.round(clamp(item.difficulty, 1, 3));
  if (item.type === "multiple_choice") {
    const options = item.options.filter((o) => o.text.trim());
    if (options.length < 2 || !options.some((o) => o.correct)) return null;
    return { ...item, difficulty, options };
  }
  if (!item.answer.trim()) return null;
  return { ...item, difficulty, options: [] };
}

export function normalizeGrade(g: GradeResult): GradeResult {
  // Manche Modelle liefern 0–100 statt 0–1.
  const raw = g.score > 1.0001 ? g.score / 100 : g.score;
  return { ...g, score: clamp(raw, 0, 1) };
}

type Json = Record<string, unknown>;

/**
 * Wandelt ein Zod-Schema in ein JSON-Schema um, das sowohl Claude Structured Outputs
 * als auch Gemini (responseJsonSchema) akzeptieren: alle Felder required,
 * additionalProperties: false, keine nicht unterstützten Keywords.
 */
export function toStrictJsonSchema(schema: z.ZodType): Json {
  const raw = z.toJSONSchema(schema, { target: "draft-7" }) as Json;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    const out: Json = {};
    for (const [k, v] of Object.entries(node as Json)) {
      if (["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "format"].includes(k)) continue;
      out[k] = strip(v);
    }
    if (out.type === "object" && out.properties) {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties as Json);
    }
    return out;
  };
  return strip(raw) as Json;
}

/** Extrahiert JSON auch dann, wenn das Modell es in ```-Blöcke packt. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) return JSON.parse(fence[1]);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Antwort enthielt kein gültiges JSON.");
  }
}
