/**
 * Live-Test gegen die echten KI-APIs (nicht in CI).
 *   GEMINI_API_KEY=… und/oder ANTHROPIC_API_KEY=… npm run live-test
 * Material: alle PDFs in testdata/ (Dateiname mit „klausur“/„exam“ = Altklausur),
 * Handschrift: PNG/JPG in testdata/ (optional). Ohne eigene PDFs wird ein Beispiel-PDF erzeugt.
 * Keys werden nie ausgegeben.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { analyzeDocuments, generateItems, gradeAnswer, type DocInput } from "../src/lib/ai/service";
import { ClaudeBackend } from "../src/lib/ai/claude";
import { GeminiBackend, listGeminiModels, pickDefaultGeminiModel } from "../src/lib/ai/gemini";
import { claudeCostUsd } from "../src/lib/ai/models";
import type { LLMBackend, Usage } from "../src/lib/ai/types";

async function samplePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [
    ["Analysis I - Folgen", "Def.: (a_n) konvergiert gegen a, wenn fuer alle eps>0 ein N existiert", "mit |a_n - a| < eps fuer alle n >= N.", "Beispiel: a_n = 1/n -> 0", "Grenzwertsaetze: lim(a_n + b_n) = lim a_n + lim b_n"],
    ["Analysis I - Ableitungen", "Produktregel: (fg)' = f'g + fg'", "Kettenregel: (f(g(x)))' = f'(g(x)) g'(x)", "Beispiel: (sin(x^2))' = 2x cos(x^2)"],
  ];
  for (const lines of pages) {
    const p = doc.addPage([595, 842]);
    lines.forEach((l, i) => p.drawText(l, { x: 50, y: 780 - i * 26, size: i === 0 ? 20 : 13, font }));
  }
  return Buffer.from(await doc.save());
}

function loadDocs(): Promise<DocInput[]> | DocInput[] {
  const files = existsSync("testdata") ? readdirSync("testdata").filter((f) => f.toLowerCase().endsWith(".pdf")) : [];
  if (!files.length) {
    return samplePdf().then((b) => [{ name: "beispiel-folien.pdf", kind: "slides", bytes: b.length, base64: b.toString("base64") }]);
  }
  return files.map((f) => {
    const b = readFileSync(`testdata/${f}`);
    const kind = /klausur|exam|pruefung|prüfung/i.test(f) ? "exam" : "slides";
    return { name: f, kind, bytes: b.length, base64: b.toString("base64") } as DocInput;
  });
}

const images = existsSync("testdata") ? readdirSync("testdata").filter((f) => /\.(png|jpe?g)$/i.test(f)) : [];

async function run(label: string, backend: LLMBackend) {
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const onUsage = (u: Usage) => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cachedInputTokens += u.cachedInputTokens;
  };
  const docs = await loadDocs();
  console.log(`\n=== ${label} (${backend.model}) – ${docs.length} PDF(s): ${docs.map((d) => `${d.name} [${d.kind}]`).join(", ")}`);

  let t = Date.now();
  const analysis = await analyzeDocuments(backend, "Live-Test", docs, [], { onUsage });
  console.log(`Analyse (${((Date.now() - t) / 1000).toFixed(1)} s): Fach „${analysis.subject}“, ${analysis.topics.length} Themen`);
  console.log(`  Mix: ${JSON.stringify(analysis.recommendedMix)} – ${analysis.mixReasoning}`);
  for (const tp of analysis.topics.slice(0, 8)) console.log(`  • ${tp.name} [${tp.examRelevance}] ${tp.examPatterns.slice(0, 90)}`);
  if (!analysis.topics.length) throw new Error("Keine Themen erkannt");

  t = Date.now();
  const specs = analysis.topics.slice(0, 2).map((topic) => ({ topic, count: 4, existingPrompts: [] }));
  const items = await generateItems(backend, "Live-Test", specs, analysis.recommendedMix, docs, { onUsage });
  console.log(`Generierung (${((Date.now() - t) / 1000).toFixed(1)} s): ${items.length} Aufgaben`);
  const types = new Map<string, number>();
  items.forEach((i) => types.set(i.type, (types.get(i.type) ?? 0) + 1));
  console.log(`  Typen: ${[...types].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  for (const i of items.slice(0, 4)) console.log(`  [${i.type}] ${i.prompt.slice(0, 120).replace(/\n/g, " ")}`);
  if (items.length < 4) throw new Error("Zu wenige Aufgaben");

  const open = items.find((i) => i.type === "worked_problem" || i.type === "short_answer") ?? items[0];
  t = Date.now();
  const wrong = await gradeAnswer(backend, open, { text: "Keine Ahnung, vielleicht 42." }, { onUsage });
  console.log(`Bewertung falsche Antwort (${((Date.now() - t) / 1000).toFixed(1)} s): ${Math.round(wrong.score * 100)} % ${wrong.verdict}/${wrong.errorType} – ${wrong.feedback.slice(0, 140)}`);
  const right = await gradeAnswer(backend, open, { text: open.answer }, { onUsage });
  console.log(`Bewertung Musterlösung als Antwort: ${Math.round(right.score * 100)} % ${right.verdict}`);
  if (wrong.score > 0.4) console.warn("  ⚠ falsche Antwort zu gut bewertet");
  if (right.score < 0.7) console.warn("  ⚠ richtige Antwort zu schlecht bewertet");

  for (const img of images) {
    const b64 = readFileSync(`testdata/${img}`).toString("base64");
    const g = await gradeAnswer(backend, open, { imagePngBase64: b64 }, { onUsage });
    console.log(`Handschrift ${img}: ${Math.round(g.score * 100)} % – gelesen: ${g.transcription.slice(0, 120)} – ${g.feedback.slice(0, 120)}`);
  }

  const cost = backend.provider === "claude" ? ` ≈ ${claudeCostUsd(backend.model, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens).toFixed(3)} $` : " (Free Tier)";
  console.log(`Tokens: in ${usage.inputTokens}, cache ${usage.cachedInputTokens}, out ${usage.outputTokens}${cost}`);
}

let ran = 0;
if (process.env.GEMINI_API_KEY) {
  const key = process.env.GEMINI_API_KEY;
  const models = await listGeminiModels(key);
  const model = process.env.GEMINI_MODEL || pickDefaultGeminiModel(models.map((m) => m.id))!;
  console.log(`Gemini-Modelle: ${models.map((m) => m.id).join(", ")}`);
  await run("Gemini", new GeminiBackend(key, model));
  ran++;
}
if (process.env.ANTHROPIC_API_KEY) {
  // Eigener Key aus der Umgebung; die Basis-URL zeigt immer auf die öffentliche API.
  await run("Claude", new ClaudeBackend(process.env.ANTHROPIC_API_KEY, process.env.CLAUDE_MODEL || "claude-sonnet-5-5", { baseURL: "https://api.anthropic.com" }));
  ran++;
}
if (!ran) {
  console.log("Kein GEMINI_API_KEY oder ANTHROPIC_API_KEY gesetzt – Live-Test übersprungen.");
}
