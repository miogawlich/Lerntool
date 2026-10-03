import { describe, expect, it } from "vitest";
import { analyzeDocuments, assignTopics, batchDocuments, gradeAnswer, mergeTopics, pickContextDocuments, generateItems, type DocInput } from "../src/lib/ai/service";
import { AIError } from "../src/lib/ai/types";
import { pickDefaultGeminiModel } from "../src/lib/ai/gemini";
import { FakeBackend, item, sampleAnalysis } from "./helpers";

const doc = (name: string, kind: DocInput["kind"], bytes: number): DocInput => ({ name, kind, bytes, base64: "AAAA" });

describe("Dokument-Batching", () => {
  it("packt Folien vor Klausuren und respektiert das Größenlimit", () => {
    const b = batchDocuments([doc("k1", "exam", 40), doc("f1", "slides", 50), doc("f2", "slides", 40)], 100);
    expect(b.map((x) => x.map((d) => d.name))).toEqual([["f1", "f2"], ["k1"]]);
  });
  it("meldet zu große Einzeldateien verständlich", () => {
    expect(() => batchDocuments([doc("riesig.pdf", "slides", 200)], 100)).toThrow(/riesig\.pdf.*zu groß/);
  });
  it("Kontext für Generierung bevorzugt Altklausuren", () => {
    expect(pickContextDocuments([doc("f", "slides", 60), doc("k", "exam", 60)], 100).map((d) => d.name)).toEqual(["k"]);
  });
});

describe("analyzeDocuments", () => {
  it("schickt PDFs + Text und validiert die Antwort", async () => {
    const be = new FakeBackend([JSON.stringify(sampleAnalysis)]);
    const res = await analyzeDocuments(be, "Ana I", [doc("f.pdf", "slides", 10)], []);
    expect(res.topics).toHaveLength(2);
    expect(be.requests[0].parts.map((p) => p.type)).toEqual(["pdf", "text"]);
    expect(be.requests[0].schema).toHaveProperty("properties.topics");
  });
  it("führt mehrere Batches zusammen und gibt bekannte Themen als Kontext mit", async () => {
    const second = { ...sampleAnalysis, topics: [{ ...sampleAnalysis.topics[0], name: "folgen und grenzwerte", examRelevance: "hoch" }, { ...sampleAnalysis.topics[1], name: "Integrale" }] };
    const be = new FakeBackend([JSON.stringify(sampleAnalysis), JSON.stringify(second)], 15);
    const res = await analyzeDocuments(be, "Ana I", [doc("f.pdf", "slides", 10), doc("k.pdf", "exam", 10)], []);
    expect(res.topics.map((t) => t.name)).toEqual(["Folgen und Grenzwerte", "Ableitungen", "Integrale"]);
    const secondText = (be.requests[1].parts.at(-1) as { text: string }).text;
    expect(secondText).toContain("Bereits vorhandene Themen");
    expect(secondText).toContain("Ableitungen");
  });
  it("versucht es bei ungültigem JSON einmal erneut, dann klarer Fehler", async () => {
    const ok = new FakeBackend(["kaputt", JSON.stringify(sampleAnalysis)]);
    await expect(analyzeDocuments(ok, "x", [doc("f", "slides", 1)], [])).resolves.toBeTruthy();
    const bad = new FakeBackend(["kaputt", '{"subject": 1}']);
    await expect(analyzeDocuments(bad, "x", [doc("f", "slides", 1)], [])).rejects.toBeInstanceOf(AIError);
  });
});

describe("Generierung", () => {
  const topics = sampleAnalysis.topics as any;
  it("teilt große Anfragen auf und ordnet Themen zu", async () => {
    const be = new FakeBackend([
      JSON.stringify({ items: [item("Folgen und Grenzwerte", "short_answer", "F1")] }),
      JSON.stringify({ items: [item("ableitungen", "worked_problem", "W1"), item("Unbekannt", "multiple_choice", "M1")] }),
    ]);
    const res = await generateItems(
      be,
      "Ana",
      [
        { topic: topics[0], count: 20, existingPrompts: ["Alte Frage"] },
        { topic: topics[1], count: 10, existingPrompts: [] },
      ],
      sampleAnalysis.recommendedMix,
      [doc("f", "slides", 1)],
    );
    expect(be.requests).toHaveLength(2);
    expect(res.map((i) => i.topicName)).toEqual(["Folgen und Grenzwerte", "Ableitungen", "Ableitungen"]);
    const text = (be.requests[0].parts.at(-1) as { text: string }).text;
    expect(text).toContain("Alte Frage");
    expect(be.requests[0].cacheDocuments).toBe(true);
  });
  it("assignTopics verwirft kaputte Items", () => {
    const out = assignTopics([item("A", "multiple_choice", "x", { options: [] }) as any, item("A", "short_answer", "ok") as any], ["A"]);
    expect(out.map((i) => i.prompt)).toEqual(["ok"]);
  });
  it("mergeTopics ist case-insensitiv", () => {
    expect(mergeTopics(topics, [{ ...topics[0], name: "FOLGEN UND GRENZWERTE", summary: "neu" }])[0]).toMatchObject({ name: "Folgen und Grenzwerte", summary: "neu" });
  });
});

describe("Bewertung", () => {
  it("schickt Bild vor dem Text und normiert den Score", async () => {
    const be = new FakeBackend([JSON.stringify({ transcription: "x=2", score: 50, verdict: "partial", errorType: "calculation", feedback: "Fast.", missedConcepts: ["Vorzeichen"] })]);
    const g = await gradeAnswer(be, item("A", "worked_problem", "Löse x") as any, { imagePngBase64: "iVBOR" });
    expect(g.score).toBe(0.5);
    expect(be.requests[0].parts[0]).toMatchObject({ type: "image", mime: "image/png" });
    expect(be.requests[0].effort).toBe("low");
  });
});

describe("Gemini-Modellwahl", () => {
  it("bevorzugt neueste stabile Flash-Version", () => {
    expect(pickDefaultGeminiModel(["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.0-flash-preview", "gemini-3.0-flash"])).toBe("gemini-3.0-flash");
  });
});
