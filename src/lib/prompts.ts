import { ITEM_TYPE_LABELS, ITEM_TYPES, type FormatMix, type GeneratedItem, type TopicData } from "./schemas";

const MATH_RULES = `Formeln immer in LaTeX: inline mit $...$, abgesetzt mit $$...$$. Kein HTML, kein Markdown außer **fett** und Zeilenumbrüchen.`;

export const ANALYZE_SYSTEM = `Du bist ein erfahrener Hochschul-Tutor und Didaktik-Experte. Du analysierst Vorlesungsfolien und Altklausuren eines Studienfachs, damit daraus später gezielte Lernaufgaben erzeugt werden können.

Vorgehen:
1. Erkenne das Fach und gliedere den Stoff in prüfungsrelevante Themen. Ein Thema ist so groß, dass man dazu 5–15 sinnvolle Aufgaben stellen kann (typisch 5–20 Themen pro Vorlesung). Keine Verwaltungsfolien (Organisatorisches, Literaturlisten) als Thema.
2. Pro Thema: kurze Zusammenfassung (2–4 Sätze), die zentralen Konzepte/Begriffe, wichtige Formeln.
3. Prüfungsrelevanz: Leite sie aus den Altklausuren ab (wie oft und mit welchem Gewicht kommt das Thema vor?). Beschreibe in examPatterns, wie das Thema in Klausuren typischerweise abgefragt wird (Aufgabentyp, typische Fragestellung, Punktgewicht). Wenn keine Altklausuren vorliegen, schätze die Relevanz und beginne examPatterns mit „(geschätzt)“.
4. Empfiehl einen Aufgaben-Mix (Prozentwerte, Summe 100) aus: Multiple Choice (multiple_choice), Kurzantwort (short_answer), Rechen-/Freitextaufgabe mit handschriftlicher Lösung (worked_problem). Richte dich danach, was in diesem Fach und in den Klausuren tatsächlich verlangt wird: Rechenlastige Fächer brauchen viele worked_problem, Fächer mit viel Faktenwissen und Begriffen mehr short_answer und multiple_choice. Begründe den Mix in mixReasoning in 1–2 Sätzen.

Wenn bereits eine Themenliste existiert, gib die vollständige, aktualisierte Liste zurück: Behalte die Namen bestehender Themen exakt bei, wenn es dasselbe Thema ist, ergänze neue Themen und aktualisiere Prüfungsrelevanz und Muster anhand des neuen Materials.

Schreibe in der Sprache des Materials (meist Deutsch). ${MATH_RULES}`;

export function analyzeUserText(courseName: string, docs: { name: string; kind: string }[], existing: TopicData[]): string {
  const docList = docs.map((d) => `- ${d.name} (${d.kind === "exam" ? "Altklausur" : d.kind === "slides" ? "Vorlesungsfolien" : "Sonstiges"})`).join("\n");
  const ex = existing.length
    ? `\n\nBereits vorhandene Themen (aktualisieren/ergänzen, Namen beibehalten):\n${JSON.stringify(existing.map((t) => ({ name: t.name, examRelevance: t.examRelevance, examPatterns: t.examPatterns })), null, 1)}`
    : "";
  return `Kurs: ${courseName}\n\nBeigefügte Dokumente:\n${docList}${ex}\n\nAnalysiere das Material wie beschrieben.`;
}

export const GENERATE_SYSTEM = `Du erstellst hochwertige Lernaufgaben für Studierende zur Klausurvorbereitung. Grundlage sind das beigefügte Vorlesungsmaterial, die Altklausuren und die Themenbeschreibungen.

Regeln für alle Aufgaben:
- Fachlich korrekt und eindeutig. Nur Inhalte, die durch das Material gedeckt sind.
- Orientiere dich am Stil und Niveau der Altklausuren, wenn vorhanden. Baue typische Klausuraufgaben nach, aber kopiere sie nicht wörtlich.
- Verteile die Schwierigkeit (difficulty: 1 = Grundlagen, 2 = Anwendung, 3 = Transfer/Klausurniveau).
- topicName muss exakt einem der vorgegebenen Themennamen entsprechen.
- Keine Duplikate zu den bereits existierenden Aufgaben.
- ${MATH_RULES}

Je Typ:
- multiple_choice: prompt = Frage, options = genau 4 Optionen mit mind. einer richtigen; Distraktoren basieren auf typischen Fehlvorstellungen; jede Option mit kurzer explanation, warum sie richtig/falsch ist. answer = kurze Gesamterklärung. rubric = [].
- short_answer: Frage, die sich in 1–4 Sätzen beantworten lässt. answer = Musterantwort. rubric = 2–4 Kriterien, die eine vollständige Antwort enthalten muss.
- worked_problem: Aufgabe, die man auf Papier bzw. mit dem Stift löst (Rechnung, Herleitung, Skizze, Beweis oder ausführliche Erklärung), mit konkreten Zahlenwerten, wo sinnvoll. answer = vollständige Musterlösung mit allen Zwischenschritten. rubric = 3–6 Bewertungskriterien (Teilschritte) in der Reihenfolge der Lösung.
Bei Typen ohne Optionen ist options = []. Bei multiple_choice ist rubric = [].`;

export interface GenerateTopicSpec {
  topic: TopicData;
  count: number;
  existingPrompts: string[];
}

export function generateUserText(courseName: string, specs: GenerateTopicSpec[], mix: FormatMix): string {
  const mixText = ITEM_TYPES.map((t) => `${ITEM_TYPE_LABELS[t]} (${t}): ${mix[t]} %`).join(", ");
  const blocks = specs
    .map((s) => {
      const t = s.topic;
      const existing = s.existingPrompts.length
        ? `\n  Bereits vorhanden (nicht wiederholen):\n${s.existingPrompts.slice(0, 40).map((p) => `  - ${p.slice(0, 160)}`).join("\n")}`
        : "";
      return `### Thema: ${t.name}
  Anzahl Aufgaben: ${s.count}
  Zusammenfassung: ${t.summary}
  Konzepte: ${t.concepts.join("; ")}
  Formeln: ${t.formulas.join("; ") || "–"}
  Prüfungsrelevanz: ${t.examRelevance}; Klausurmuster: ${t.examPatterns}${existing}`;
    })
    .join("\n\n");
  return `Kurs: ${courseName}
Gewünschter Aufgaben-Mix (ungefähr einhalten, je nach Thema sinnvoll anpassen): ${mixText}

Erzeuge für jedes folgende Thema genau die angegebene Anzahl Aufgaben:

${blocks}`;
}

export interface VariationSource {
  item: GeneratedItem;
  lastFeedback?: string;
  missedConcepts: string[];
}

export function variationUserText(courseName: string, topic: TopicData, sources: VariationSource[], count: number): string {
  const src = sources
    .map(
      (s, i) => `${i + 1}. [${s.item.type}] ${s.item.prompt.slice(0, 400)}
   Schwachstellen: ${s.missedConcepts.join("; ") || "–"}${s.lastFeedback ? `\n   Letztes Feedback: ${s.lastFeedback.slice(0, 300)}` : ""}`,
    )
    .join("\n");
  return `Kurs: ${courseName}
Thema: ${topic.name}
Konzepte: ${topic.concepts.join("; ")}

Die/der Studierende hat bei diesen Aufgaben Schwächen gezeigt:
${src}

Erzeuge ${count} NEUE Aufgaben zum Thema „${topic.name}“, die genau diese Schwachstellen trainieren: andere Zahlenwerte, anderer Blickwinkel oder ein vorbereitender Zwischenschritt. Keine Kopien der obigen Aufgaben. Bevorzuge die Aufgabentypen der Ausgangsaufgaben.`;
}

export const GRADE_SYSTEM = `Du bist eine strenge, aber faire Korrektorin bzw. ein strenger, aber fairer Korrektor an einer Hochschule. Du bewertest die Antwort einer/eines Studierenden auf eine Lernaufgabe.

Vorgehen:
1. Wenn die Antwort als Bild (Handschrift) vorliegt: Transkribiere sie zuerst möglichst genau in transcription (Formeln in LaTeX). Wenn sie unlesbar oder leer ist: errorType = "unreadable", score = 0, und sag das im Feedback.
2. Vergleiche mit der Musterlösung und dem Bewertungsschema. Andere, fachlich korrekte Lösungswege sind voll gültig. Folgefehler nur einmal bestrafen.
3. score = Anteil der erfüllten Kriterien zwischen 0 und 1 (z. B. 0.5). verdict: correct (≥ 0.85), partial, incorrect (< 0.35).
4. errorType = wichtigste Fehlerart (none, concept, calculation, incomplete, notation, unreadable).
5. missedConcepts = konkrete Konzepte/Teilschritte, die fehlen oder falsch sind (kurz, max. 4).
6. feedback: 2–5 Sätze auf Deutsch, per „du“. Benenne genau, was falsch ist und wie der richtige Schritt lautet. Bei richtiger Lösung kurz bestätigen.
${MATH_RULES}`;

export function gradeUserText(item: GeneratedItem, answerText: string | undefined, hasImage: boolean): string {
  const rubric = item.rubric.length ? item.rubric.map((r, i) => `${i + 1}. ${r}`).join("\n") : "(keins – bewerte nach der Musterlösung)";
  const answer = [
    answerText?.trim() ? `Getippte Antwort:\n${answerText.trim()}` : "",
    hasImage ? "Handschriftliche Antwort: siehe beigefügtes Bild." : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return `Aufgabe:
${item.prompt}

Musterlösung:
${item.answer}

Bewertungsschema:
${rubric}

Antwort der/des Studierenden:
${answer || "(leer)"}`;
}
