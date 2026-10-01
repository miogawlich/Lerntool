import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@google/genai";
import { GeminiBackend, mapGeminiError, pickDefaultGeminiModel, pickFallbackModels, resetGeminiState } from "../src/lib/ai/gemini";
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
  beforeEach(() => resetGeminiState());

  it("wiederholt bei 503 nach einer Wartezeit und hat dann Erfolg", async () => {
    const client = fakeClient([apiErr(503, "The model is overloaded."), apiErr(503, "overloaded"), '{"ok":true}']);
    const status: string[] = [];
    const be = new GeminiBackend("k", "gemini-3.0-flash", { client, sleep: noSleep });
    const res = await be.complete(req(status));
    expect(res.text).toBe('{"ok":true}');
    expect(client.calls).toEqual(["gemini-3.0-flash", "gemini-3.0-flash", "gemini-3.0-flash"]);
    expect(status[0]).toMatch(/neuer Versuch in 3 s/);
  });

  it("weicht bei 503 sofort auf das nächste Modell aus, statt am selben zu warten", async () => {
    const client = fakeClient([apiErr(503, "a"), '{"ok":1}']);
    const status: string[] = [];
    let slept = 0;
    const be = new GeminiBackend("k", "gemini-3.8-flash", { client, sleep: async () => void slept++, fallbackModels: ["gemini-3.7-flash", "gemini-3.6-flash"] });
    const res = await be.complete(req(status));
    expect(res.model).toBe("gemini-3.7-flash");
    expect(slept).toBe(0);
    expect(status[0]).toMatch(/gemini-3.8-flash: überlastet – weiche auf gemini-3.7-flash aus/);
  });

  it("probiert alle Modelle reihum und wartet erst zwischen den Runden", async () => {
    const client = fakeClient([apiErr(503, "a"), apiErr(503, "b"), apiErr(503, "c"), '{"ok":1}']);
    const waits: number[] = [];
    const be = new GeminiBackend("k", "m1", { client, sleep: async (ms) => void waits.push(ms), fallbackModels: ["m2", "m3"] });
    const res = await be.complete(req());
    expect(client.calls).toEqual(["m1", "m2", "m3", "m1"]);
    expect(res.model).toBe("m1");
    expect(waits).toEqual([3000]);
  });

  it("merkt sich ein funktionierendes Ausweichmodell für die nächsten Aufrufe", async () => {
    const client = fakeClient([apiErr(503, "a"), '{"a":1}', '{"b":2}']);
    const opts = { client, sleep: noSleep, fallbackModels: ["m2"], now: () => 1000 };
    await new GeminiBackend("k", "m1", opts).complete(req());
    const res = await new GeminiBackend("k", "m1", opts).complete(req());
    expect(client.calls).toEqual(["m1", "m2", "m2"]);
    expect(res.model).toBe("m2");
    // Nach Ablauf wieder das gewählte Modell zuerst
    client.calls.length = 0;
    const later = fakeClient(['{"c":3}']);
    await new GeminiBackend("k", "m1", { ...opts, client: later, now: () => 1000 + 16 * 60_000 }).complete(req());
    expect(later.calls).toEqual(["m1"]);
  });

  it("überspringt Modelle, die es nicht mehr gibt (404), dauerhaft", async () => {
    const client = fakeClient([apiErr(404, "models/gemini-2.5-flash is no longer available"), '{"ok":1}', '{"ok":2}']);
    const opts = { client, sleep: noSleep, fallbackModels: ["gemini-3.5-flash"] };
    expect((await new GeminiBackend("k", "gemini-2.5-flash", opts).complete(req())).model).toBe("gemini-3.5-flash");
    await new GeminiBackend("k", "gemini-2.5-flash", opts).complete(req());
    expect(client.calls).toEqual(["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.5-flash"]);
  });

  it("Minutenlimit (429) eines Modells: anderes Modell nehmen; sind alle limitiert, Limit melden ohne zu warten", async () => {
    const ok = fakeClient([apiErr(429, "Quota exceeded. Please retry in 30s."), '{"ok":1}']);
    expect((await new GeminiBackend("k", "m1", { client: ok, sleep: noSleep, fallbackModels: ["m2"] }).complete(req())).model).toBe("m2");
    resetGeminiState();
    let slept = 0;
    const all = fakeClient([apiErr(429, "Quota exceeded. Please retry in 30s."), apiErr(429, "Quota exceeded. Please retry in 20s.")]);
    await expect(new GeminiBackend("k", "m1", { client: all, sleep: async () => void slept++, fallbackModels: ["m2"] }).complete(req())).rejects.toMatchObject({ kind: "rate_limit" });
    expect(all.calls).toEqual(["m1", "m2"]);
    expect(slept).toBe(0);
  });

  it("interner Fehler (500) wird nur einmal wiederholt, damit die Analyse aufteilen kann", async () => {
    const client = fakeClient([apiErr(500, "Internal"), apiErr(500, "Internal"), '{"ok":1}']);
    await expect(new GeminiBackend("k", "m1", { client, sleep: noSleep, fallbackModels: ["m2"] }).complete(req())).rejects.toMatchObject({ kind: "server" });
    expect(client.calls).toEqual(["m1", "m2"]);
  });

  it("gibt nach allen Runden mit Überlastung auf", async () => {
    const client = fakeClient(Array.from({ length: 8 }, () => apiErr(503, "overloaded")));
    await expect(new GeminiBackend("k", "m1", { client, sleep: noSleep, fallbackModels: ["m2"] }).complete(req())).rejects.toMatchObject({ kind: "overloaded" });
    expect(client.calls).toHaveLength(8);
  });

  it("nicht wiederholbare Fehler (z. B. Key ungültig) sofort melden", async () => {
    const client = fakeClient([apiErr(400, "API key not valid")]);
    const be = new GeminiBackend("k", "m", { client, sleep: noSleep, fallbackModels: ["x"] });
    await expect(be.complete(req())).rejects.toMatchObject({ kind: "auth" });
    expect(client.calls).toHaveLength(1);
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
  const real = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"];
  it("stabile Modelle vor Vorabversionen", () => {
    expect(pickDefaultGeminiModel(ids)).toBe("gemini-3.0-flash");
  });
  it("Ausweichmodelle: andere stabile Flash-Modelle", () => {
    expect(pickFallbackModels(ids, "gemini-3.0-flash")).toEqual(["gemini-2.5-flash", "gemini-3.0-flash-lite"]);
    // Volle Flash-Modelle vor Lite, bis zu vier Kandidaten
    expect(pickFallbackModels(real, "gemini-3.8-flash")).toEqual(["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash"]);
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
