import type { z } from "zod";
import {
  AnalysisSchema,
  GenerationSchema,
  GradeSchema,
  extractJson,
  normalizeGrade,
  normalizeItem,
  normalizeMix,
  toStrictJsonSchema,
  type Analysis,
  type FormatMix,
  type GeneratedItem,
  type GradeResult,
  type TopicData,
} from "../schemas";
import {
  ANALYZE_SYSTEM,
  GENERATE_SYSTEM,
  GRADE_SYSTEM,
  analyzeUserText,
  generateUserText,
  gradeUserText,
  variationUserText,
  type GenerateTopicSpec,
  type VariationSource,
} from "../prompts";
import { AIError, type CompleteRequest, type LLMBackend, type Part, type Usage } from "./types";

export interface DocInput {
  name: string;
  kind: "slides" | "exam" | "other";
  base64: string;
  bytes: number;
}

export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (info: { step: string; receivedChars?: number }) => void;
  onUsage?: (usage: Usage, model: string, purpose: string) => void;
}

const ANALYSIS_JSON = toStrictJsonSchema(AnalysisSchema);
const GENERATION_JSON = toStrictJsonSchema(GenerationSchema);
const GRADE_JSON = toStrictJsonSchema(GradeSchema);

/** Ruft das Modell auf und validiert die Antwort; bei ungültigem JSON wird einmal neu versucht. */
async function structured<T>(
  backend: LLMBackend,
  schema: z.ZodType<T>,
  req: CompleteRequest,
  purpose: string,
  opts: CallOptions,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await backend.complete(req);
    opts.onUsage?.(res.usage, res.model, purpose);
    try {
      const parsed = schema.safeParse(extractJson(res.text));
      if (parsed.success) return parsed.data;
      lastErr = parsed.error;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new AIError("invalid_output", `Die KI hat eine ungültige Antwort geliefert (${String(lastErr).slice(0, 200)}). Bitte erneut versuchen.`);
}

function pdfParts(docs: DocInput[]): Part[] {
  return docs.map((d) => ({ type: "pdf", name: d.name, base64: d.base64, bytes: d.bytes }));
}

/** Teilt Dokumente in Gruppen, die jeweils in einen Request passen (Klausuren zuletzt, damit Themen schon bekannt sind). */
export function batchDocuments(docs: DocInput[], maxBytes: number): DocInput[][] {
  const order = { slides: 0, other: 1, exam: 2 } as const;
  const sorted = [...docs].sort((a, b) => order[a.kind] - order[b.kind]);
  const batches: DocInput[][] = [];
  let cur: DocInput[] = [];
  let size = 0;
  for (const d of sorted) {
    if (d.bytes > maxBytes) {
      throw new AIError(
        "too_large",
        `„${d.name}“ ist mit ${(d.bytes / 1024 / 1024).toFixed(1)} MB zu groß (max. ${(maxBytes / 1024 / 1024).toFixed(0)} MB pro Datei). Bitte die PDF aufteilen oder komprimieren.`,
      );
    }
    if (size + d.bytes > maxBytes && cur.length) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(d);
    size += d.bytes;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** Wählt für die Generierung so viele Dokumente, wie in einen Request passen (Klausuren bevorzugt). */
export function pickContextDocuments(docs: DocInput[], maxBytes: number): DocInput[] {
  const order = { exam: 0, slides: 1, other: 2 } as const;
  const sorted = [...docs].sort((a, b) => order[a.kind] - order[b.kind]);
  const out: DocInput[] = [];
  let size = 0;
  for (const d of sorted) {
    if (size + d.bytes <= maxBytes) {
      out.push(d);
      size += d.bytes;
    }
  }
  return out;
}

export async function analyzeDocuments(
  backend: LLMBackend,
  courseName: string,
  docs: DocInput[],
  existing: TopicData[],
  opts: CallOptions = {},
): Promise<Analysis> {
  const batches = batchDocuments(docs, backend.maxInlineBytes);
  let topics = existing;
  let result: Analysis | undefined;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    opts.onProgress?.({ step: batches.length > 1 ? `Analysiere Teil ${i + 1}/${batches.length} …` : "Analysiere Material …" });
    const req: CompleteRequest = {
      system: ANALYZE_SYSTEM,
      parts: [...pdfParts(batch), { type: "text", text: analyzeUserText(courseName, batch, topics) }],
      schema: ANALYSIS_JSON,
      effort: "medium",
      maxTokens: 32000,
      signal: opts.signal,
      onProgress: (n) => opts.onProgress?.({ step: "Analysiere Material …", receivedChars: n }),
    };
    const res = await structured(backend, AnalysisSchema, req, "analyze", opts);
    result = { ...res, recommendedMix: normalizeMix(res.recommendedMix) };
    topics = mergeTopics(topics, result.topics);
  }
  if (!result) throw new AIError("other", "Keine Dokumente zum Analysieren.");
  return { ...result, topics };
}

/** Führt Themenlisten zusammen; gleiche Namen (ohne Groß-/Kleinschreibung) werden aktualisiert. */
export function mergeTopics(existing: TopicData[], incoming: TopicData[]): TopicData[] {
  const key = (n: string) => n.trim().toLowerCase();
  const map = new Map(existing.map((t) => [key(t.name), t]));
  for (const t of incoming) {
    const prev = map.get(key(t.name));
    map.set(key(t.name), prev ? { ...t, name: prev.name } : t);
  }
  return [...map.values()];
}

export async function generateItems(
  backend: LLMBackend,
  courseName: string,
  specs: GenerateTopicSpec[],
  mix: FormatMix,
  docs: DocInput[],
  opts: CallOptions = {},
): Promise<GeneratedItem[]> {
  const context = pickContextDocuments(docs, backend.maxInlineBytes);
  const all: GeneratedItem[] = [];
  // Höchstens ~24 Aufgaben pro Request, damit die Antwort nicht abgeschnitten wird.
  const chunks: GenerateTopicSpec[][] = [];
  let cur: GenerateTopicSpec[] = [];
  let n = 0;
  for (const s of specs) {
    if (n + s.count > 24 && cur.length) {
      chunks.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(s);
    n += s.count;
  }
  if (cur.length) chunks.push(cur);

  for (let i = 0; i < chunks.length; i++) {
    opts.onProgress?.({ step: chunks.length > 1 ? `Erzeuge Aufgaben (Teil ${i + 1}/${chunks.length}) …` : "Erzeuge Aufgaben …" });
    const req: CompleteRequest = {
      system: GENERATE_SYSTEM,
      parts: [...pdfParts(context), { type: "text", text: generateUserText(courseName, chunks[i], mix) }],
      schema: GENERATION_JSON,
      effort: "medium",
      maxTokens: 48000,
      cacheDocuments: true,
      signal: opts.signal,
      onProgress: (c) => opts.onProgress?.({ step: "Erzeuge Aufgaben …", receivedChars: c }),
    };
    const res = await structured(backend, GenerationSchema, req, "generate", opts);
    all.push(...assignTopics(res.items, chunks[i].map((s) => s.topic.name)));
  }
  return all;
}

export async function generateVariations(
  backend: LLMBackend,
  courseName: string,
  topic: TopicData,
  sources: VariationSource[],
  count: number,
  docs: DocInput[],
  opts: CallOptions = {},
): Promise<GeneratedItem[]> {
  const context = pickContextDocuments(docs, backend.maxInlineBytes);
  opts.onProgress?.({ step: "Erzeuge neue Übungsaufgaben zu deinen Schwächen …" });
  const req: CompleteRequest = {
    system: GENERATE_SYSTEM,
    parts: [...pdfParts(context), { type: "text", text: variationUserText(courseName, topic, sources, count) }],
    schema: GENERATION_JSON,
    effort: "medium",
    maxTokens: 32000,
    cacheDocuments: true,
    signal: opts.signal,
  };
  const res = await structured(backend, GenerationSchema, req, "variations", opts);
  return assignTopics(res.items, [topic.name]);
}

/** Verwirft unbrauchbare Items und ordnet unbekannte Themennamen dem ähnlichsten gültigen zu. */
export function assignTopics(items: GeneratedItem[], validNames: string[]): GeneratedItem[] {
  const lower = validNames.map((n) => n.toLowerCase());
  const out: GeneratedItem[] = [];
  for (const raw of items) {
    const it = normalizeItem(raw);
    if (!it) continue;
    let idx = lower.indexOf(it.topicName.trim().toLowerCase());
    if (idx < 0) idx = lower.findIndex((n) => n.includes(it.topicName.toLowerCase()) || it.topicName.toLowerCase().includes(n));
    if (idx < 0) idx = 0;
    out.push({ ...it, topicName: validNames[idx] });
  }
  return out;
}

export async function gradeAnswer(
  backend: LLMBackend,
  item: GeneratedItem,
  answer: { text?: string; imagePngBase64?: string },
  opts: CallOptions = {},
): Promise<GradeResult> {
  const parts: Part[] = [];
  if (answer.imagePngBase64) parts.push({ type: "image", mime: "image/png", base64: answer.imagePngBase64 });
  parts.push({ type: "text", text: gradeUserText(item, answer.text, !!answer.imagePngBase64) });
  opts.onProgress?.({ step: "KI bewertet deine Antwort …" });
  const res = await structured(
    backend,
    GradeSchema,
    { system: GRADE_SYSTEM, parts, schema: GRADE_JSON, effort: "low", maxTokens: 16000, signal: opts.signal },
    "grade",
    opts,
  );
  return normalizeGrade(res);
}
