import type { Page, Route } from "@playwright/test";

/** Protokoll aller Requests an die (gemockte) Gemini-API. */
export interface GeminiLog {
  generate: { system: string; parts: Record<string, unknown>[]; model: string }[];
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

export const ANALYSIS = {
  subject: "Analysis I",
  recommendedMix: { flashcard: 25, multiple_choice: 25, short_answer: 20, worked_problem: 30 },
  mixReasoning: "Viel Rechnen, aber auch Begriffe.",
  topics: [
    { name: "Folgen und Grenzwerte", summary: "Konvergenz von Folgen, $\\varepsilon$-Kriterium.", concepts: ["Konvergenz", "Cauchy-Folge"], formulas: ["$\\lim_{n\\to\\infty} \\frac{1}{n} = 0$"], examRelevance: "hoch", examPatterns: "Grenzwert berechnen (10 P.)" },
    { name: "Differentialrechnung", summary: "Ableitungsregeln.", concepts: ["Kettenregel", "Produktregel"], formulas: ["$(fg)' = f'g + fg'$"], examRelevance: "mittel", examPatterns: "Ableiten (6 P.)" },
  ],
};

function itemsFor(topic: string) {
  return [
    { topicName: topic, type: "flashcard", difficulty: 1, prompt: `Was besagt die Definition zu ${topic}?`, answer: "Eine knappe Definition.", options: [], rubric: [] },
    {
      topicName: topic, type: "multiple_choice", difficulty: 2, prompt: `Welche Aussage zu ${topic} ist richtig?`, answer: "Erklärung.",
      options: [
        { text: "Richtige Aussage", correct: true, explanation: "Stimmt." },
        { text: "Falsche Aussage A", correct: false, explanation: "Typischer Fehler." },
        { text: "Falsche Aussage B", correct: false, explanation: "Nein." },
        { text: "Falsche Aussage C", correct: false, explanation: "Nein." },
      ],
      rubric: [],
    },
    { topicName: topic, type: "short_answer", difficulty: 2, prompt: `Erkläre kurz ${topic}.`, answer: "Musterantwort.", options: [], rubric: ["Begriff genannt", "Beispiel"] },
    { topicName: topic, type: "worked_problem", difficulty: 3, prompt: `Berechne $\\lim_{n\\to\\infty} \\frac{2n+1}{n}$ (${topic}).`, answer: "$\\lim = 2$ wegen $\\frac{2n+1}{n} = 2 + \\frac1n$.", options: [], rubric: ["Umformung", "Grenzwert 2"] },
  ];
}

export async function mockGemini(page: Page, opts: { failFirstGenerate?: number } = {}): Promise<GeminiLog> {
  const log: GeminiLog = { generate: [] };
  let failures = opts.failFirstGenerate ?? 0;
  // EZB-Wechselkurs (Frankfurter-API) deterministisch
  await page.route("https://api.frankfurter.dev/**", (route) =>
    json(route, { amount: 1, base: "USD", date: "2026-09-30", rates: { EUR: 0.9 } }),
  );
  await page.route("https://generativelanguage.googleapis.com/**", async (route) => {
    const url = route.request().url();
    if (route.request().method() === "GET" && /\/models(\?|$)/.test(url)) {
      return json(route, {
        models: [
          { name: "models/gemini-3.0-flash", displayName: "Gemini 3.0 Flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.0-pro", displayName: "Gemini 3.0 Pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding-004", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
        ],
      });
    }
    if (url.includes(":generateContent")) {
      const body = route.request().postDataJSON();
      const system = (body.systemInstruction?.parts ?? []).map((p: { text: string }) => p.text).join("") ?? "";
      const parts = body.contents?.[0]?.parts ?? [];
      const model = url.match(/models\/([^:]+):/)?.[1] ?? "";
      log.generate.push({ system, parts, model });
      if (failures > 0) {
        failures--;
        return json(route, { error: { code: 429, message: "Resource has been exhausted. Please retry in 7s.", status: "RESOURCE_EXHAUSTED" } }, 429);
      }
      const userText = parts.map((p: { text?: string }) => p.text ?? "").join("\n");
      let out: unknown;
      if (system.includes("analysierst")) out = ANALYSIS;
      else if (system.includes("Lernaufgaben")) {
        const topics = [...userText.matchAll(/### Thema: (.+)/g)].map((m) => m[1].trim());
        const variation = userText.match(/Thema: (.+)\n/);
        out = { items: (topics.length ? topics : [variation?.[1] ?? "?"]).flatMap(itemsFor) };
      } else if (system.includes("Korrektor")) {
        const hasImage = parts.some((p: { inlineData?: { mimeType: string } }) => p.inlineData?.mimeType === "image/png");
        out = hasImage
          ? { transcription: "$\\frac{2n+1}{n} = 3$", score: 0.5, verdict: "partial", errorType: "calculation", feedback: "Die Umformung stimmt, aber der Grenzwert ist $2$, nicht $3$.", missedConcepts: ["Grenzwert von $1/n$"] }
          : { transcription: "", score: 1, verdict: "correct", errorType: "none", feedback: "Richtig erklärt.", missedConcepts: [] };
      } else out = { ok: true, message: "Verbindung steht" };
      return json(route, {
        candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(out) }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300, totalTokenCount: 1500 },
      });
    }
    return json(route, { error: { code: 404, message: "not mocked" } }, 404);
  });
  return log;
}
