import { describe, expect, it } from "vitest";
import { AnalysisSchema, GenerationSchema, GradeSchema, extractJson, normalizeGrade, normalizeItem, normalizeMix, toStrictJsonSchema } from "../src/lib/schemas";

describe("toStrictJsonSchema", () => {
  it("macht alle Objekte strikt und entfernt nicht unterstützte Keywords", () => {
    for (const s of [AnalysisSchema, GenerationSchema, GradeSchema]) {
      const json = toStrictJsonSchema(s);
      const walk = (n: any) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        expect(n.$schema).toBeUndefined();
        expect(n.minimum).toBeUndefined();
        if (n.type === "object") {
          expect(n.additionalProperties).toBe(false);
          expect(new Set(n.required)).toEqual(new Set(Object.keys(n.properties)));
        }
        Object.values(n).forEach(walk);
      };
      walk(json);
    }
  });
});

describe("normalize", () => {
  it("normiert den Mix auf 100 %", () => {
    const m = normalizeMix({ flashcard: 1, multiple_choice: 1, short_answer: 0, worked_problem: 2 });
    expect(m).toEqual({ flashcard: 25, multiple_choice: 25, short_answer: 0, worked_problem: 50 });
    expect(normalizeMix({ flashcard: 0, multiple_choice: 0, short_answer: 0, worked_problem: 0 }).flashcard).toBe(25);
  });
  it("verwirft MC ohne richtige Option und klemmt Schwierigkeit", () => {
    const base = { topicName: "x", prompt: "Frage", answer: "", rubric: [], difficulty: 7 };
    expect(normalizeItem({ ...base, type: "multiple_choice", options: [{ text: "a", correct: false, explanation: "" }, { text: "b", correct: false, explanation: "" }] })).toBeNull();
    const ok = normalizeItem({ ...base, type: "multiple_choice", options: [{ text: "a", correct: true, explanation: "" }, { text: "b", correct: false, explanation: "" }] });
    expect(ok?.difficulty).toBe(3);
    expect(normalizeItem({ ...base, type: "worked_problem", options: [] })).toBeNull(); // keine Musterlösung
  });
  it("rechnet Prozent-Scores in 0–1 um", () => {
    const g = { transcription: "", verdict: "partial" as const, errorType: "none" as const, feedback: "", missedConcepts: [] };
    expect(normalizeGrade({ ...g, score: 75 }).score).toBe(0.75);
    expect(normalizeGrade({ ...g, score: -1 }).score).toBe(0);
  });
});

describe("extractJson", () => {
  it("liest JSON auch aus Code-Fences und mit Text drumherum", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Hier: {"a":3} fertig')).toEqual({ a: 3 });
    expect(() => extractJson("kein json")).toThrow();
  });
});
