import { describe, expect, it } from "vitest";
import { ApiError } from "@google/genai";
import { GeminiBackend, mapGeminiError, pickDefaultGeminiModel, pickFallbackModels } from "../src/lib/ai/gemini";
import { AIError, type CompleteRequest } from "../src/lib/ai/types";
import { analyzeDocuments } from "../src/lib/ai/service";
import { FakeBackend, sampleAnalysis } from "./helpers";

const apiErr = (status: number, message: string) => new ApiError({ status, message });

/** Client-Attrappe: liefert der Reihe nach Fehler oder Antworten und merkt sich das Modell. */
function fakeClient(script: (Error | string)[]) {
  const calls: string[] = [];
  return {
    calls,
    models: {
      generateContent: (async (p: { model: string }) => {
        calls.push(p.model);
        const next = script.shift();
        if (next === undefined) throw new Error("Skript leer");
        if (next instanceof Error) throw next;
        return { text: next, candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
      }) as never,
    },
  };
}

const req = (statuses: string[] = []): CompleteRequest => ({
  system: "s",
  parts: [{ type: "text", text: "x" }],
  schema: {},
  effort: "low",
  maxTokens: 100,
  onStatus: (m) => statuses.push(m),
});

describe("Gemini: Wiederholversuche & Ausweichmodell", () => {
  const noSleep = async () => undefined;

  it("wiederholt bei 503 und hat dann Erfolg", async () => {
    const client = fakeClient([apiErr(503, "The model is overloaded."), apiErr(503, "overloaded"), '{"ok":true}']);
    const status: string[] = [];
    const be = new GeminiBackend("k", "gemini-3.0-flash", { client, sleep: noSleep });
    const res = await be.complete(req(status));
    expect(res.text).toBe('{"ok":true}');
    expect(client.calls).toEqual(["gemini-3.0-flash", "gemini-3.0-flash", "gemini-3.0-flash"]);
    expect(status[0]).toMatch(/neuer Versuch in 2 s/);
  });

  it("weicht auf ein anderes Modell aus, wenn das gewählte dauerhaft überlastet ist", async () => {
    const client = fakeClient([apiErr(503, "a"), apiErr(503, "b"), apiErr(503, "c"), '{"ok":1}']);
    const status: string[] = [];
    const be = new GeminiBackend("k", "gemini-3.5-flash-preview", { client, sleep: noSleep, fallbackModels: ["gemini-3.0-flash"] });
    const res = await be.complete(req(status));
    expect(res.model).toBe("gemini-3.0-flash");
    expect(status.some((s) => s.includes("weiche auf gemini-3.0-flash aus"))).toBe(true);
  });

  it("nicht wiederholbare Fehler (z. B. Key ungültig, Tageslimit) sofort melden", async () => {
    const client = fakeClient([apiErr(400, "API key not valid")]);
    const be = new GeminiBackend("k", "m", { client, sleep: noSleep, fallbackModels: ["x"] });
    await expect(be.complete(req())).rejects.toMatchObject({ kind: "auth" });
    expect(client.calls).toHaveLength(1);
    const client2 = fakeClient([apiErr(429, "Quota exceeded. Please retry in 30s.")]);
    await expect(new GeminiBackend("k", "m", { client: client2, sleep: noSleep }).complete(req())).rejects.toMatchObject({ kind: "rate_limit", retryAfterSeconds: 30 });
    expect(client2.calls).toHaveLength(1);
  });

  it("unterscheidet 503 (überlastet) von 500 (interner Fehler) und behält Googles Text", () => {
    const a = mapGeminiError(apiErr(503, '{"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}')) as AIError;
    expect(a.kind).toBe("overloaded");
    expect(a.detail).toBe("HTTP 503: The model is overloaded. Please try again later.");
    const b = mapGeminiError(apiErr(500, "Internal error encountered.")) as AIError;
    expect(b.kind).toBe("server");
    expect(b.message).toMatch(/interner Fehler/);
  });
});

describe("Modellwahl", () => {
  const ids = ["gemini-3.5-flash-preview", "gemini-3.0-flash", "gemini-3.0-pro", "gemini-3.0-flash-lite", "gemini-2.5-flash", "gemini-flash-latest"];
  it("stabile Modelle vor Vorabversionen", () => {
    expect(pickDefaultGeminiModel(ids)).toBe("gemini-3.0-flash");
  });
  it("Ausweichmodelle: andere stabile Flash-Modelle", () => {
    expect(pickFallbackModels(ids, "gemini-3.0-flash")).toEqual(["gemini-3.0-flash-lite", "gemini-2.5-flash"]);
    expect(pickFallbackModels(ids, "gemini-3.5-flash-preview")[0]).toBe("gemini-3.0-flash");
  });
});

describe("Analyse bei internem Google-Fehler", () => {
  it("versucht es Datei für Datei erneut", async () => {
    const be = new FakeBackend([JSON.stringify(sampleAnalysis), JSON.stringify(sampleAnalysis)]);
    const orig = be.complete.bind(be);
    let first = true;
    be.complete = async (r) => {
      if (first) {
        first = false;
        throw new AIError("server", "intern", undefined, "HTTP 500");
      }
      return orig(r);
    };
    const docs = [
      { name: "a.pdf", kind: "slides" as const, bytes: 10, base64: "A" },
      { name: "b.pdf", kind: "slides" as const, bytes: 10, base64: "B" },
    ];
    const res = await analyzeDocuments(be, "K", docs, []);
    expect(res.topics.length).toBe(2);
    expect(be.requests.map((r) => r.parts.filter((p) => p.type === "pdf").length)).toEqual([1, 1]);
  });
});
