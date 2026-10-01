import "fake-indexeddb/auto";
import { LernDB } from "../src/lib/db";
import type { CompleteRequest, CompleteResponse, LLMBackend } from "../src/lib/ai/types";

let n = 0;
export function freshDb() {
  return new LernDB(`test-${Date.now()}-${n++}`);
}

/** Backend-Attrappe: liefert vorgegebene Antworten und protokolliert die Requests. */
export class FakeBackend implements LLMBackend {
  readonly provider = "gemini" as const;
  readonly model = "fake-model";
  requests: CompleteRequest[] = [];
  constructor(
    private responses: (string | ((req: CompleteRequest) => string))[],
    readonly maxInlineBytes = 1_000_000,
  ) {}
  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    this.requests.push(req);
    const r = this.responses.shift();
    if (r === undefined) throw new Error("FakeBackend: keine Antwort mehr");
    return { text: typeof r === "function" ? r(req) : r, model: this.model, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 } };
  }
}

export const sampleAnalysis = {
  subject: "Analysis I",
  recommendedMix: { flashcard: 20, multiple_choice: 20, short_answer: 10, worked_problem: 50 },
  mixReasoning: "Rechenlastiges Fach.",
  topics: [
    { name: "Folgen und Grenzwerte", summary: "Konvergenz von Folgen.", concepts: ["Konvergenz", "Cauchy-Folge"], formulas: ["$\\lim_{n\\to\\infty} a_n$"], examRelevance: "hoch", examPatterns: "Grenzwert berechnen" },
    { name: "Ableitungen", summary: "Differentialrechnung.", concepts: ["Kettenregel"], formulas: ["$(f\\circ g)' = f'(g)g'$"], examRelevance: "mittel", examPatterns: "Ableiten" },
  ],
};

export function item(topicName: string, type: string, prompt: string, extra: Record<string, unknown> = {}) {
  return {
    topicName,
    type,
    difficulty: 2,
    prompt,
    answer: "Lösung",
    options: type === "multiple_choice" ? [{ text: "A", correct: true, explanation: "" }, { text: "B", correct: false, explanation: "" }] : [],
    rubric: type === "worked_problem" ? ["Schritt 1"] : [],
    ...extra,
  };
}
