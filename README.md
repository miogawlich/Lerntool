# Lerntool

KI-gestützte Lern-App fürs Studium, optimiert fürs iPad mit Apple Pencil. Sie läuft als Web-App (PWA) in Safari.

- **Material hochladen:** Vorlesungsfolien und Altklausuren als PDF.
- **KI-Analyse:** erkennt Themen, schätzt die Klausurrelevanz anhand der Altklausuren und schlägt einen passenden Aufgaben-Mix vor.
- **Aufgaben:** Karteikarten, Multiple Choice, Kurzantworten sowie Rechen- und Freitextaufgaben im Stil der Altklausuren.
- **Antworten mit dem Stift:** Zeichenfeld mit fester Strichdicke (unabhängig vom Druck), Lasso zum Verschieben mehrerer Striche, Radierer, Rückgängig/Wiederholen. Die Handschrift wird von der KI gelesen und bewertet.
- **Schwächen gezielt üben:** Wiederholungen werden mit FSRS geplant. Pro Thema gibt es einen Beherrschungswert und eine Auswertung der Fehlerarten. Außerdem erzeugt die KI neue Aufgaben, die gezielt deine Fehler trainieren.

## KI-Anbieter

| | Gemini (Google) | Claude (Anthropic) |
|---|---|---|
| Kosten | kostenlose Stufe mit Limits pro Minute und Tag | Bezahlung pro Nutzung; Sonnet 5.5: 2 $ / 10 $ pro 1 Mio. Tokens (Ein- / Ausgabe) |
| Key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| Datenschutz | In der kostenlosen Stufe darf Google deine Eingaben zur Produktverbesserung nutzen. | Eingaben werden laut Anthropic nicht zum Training verwendet. |

Ein Claude.ai-Abo enthält **keinen** API-Zugang. Wenn du Claude nutzt, setz in der Console ein Ausgabenlimit. Um Kosten zu sparen, gilt standardmäßig: Bei offenen Aufgaben vergleichst du selbst mit der Musterlösung, die KI-Bewertung startest du per Knopf.

Die Keys liegen nur im Browser-Speicher deines Geräts und gehen direkt an Google bzw. Anthropic.

## Aufs iPad bringen

1. Im Repo unter **Settings → Pages** als Quelle **„GitHub Actions“** wählen. Danach baut, testet und veröffentlicht jeder Push die App automatisch.
2. Auf dem iPad in Safari die Pages-URL öffnen (`https://<user>.github.io/Lerntool/`).
3. **Teilen → „Zum Home-Bildschirm“**. Die App startet dann im Vollbild und funktioniert offline (die KI-Funktionen brauchen trotzdem Internet).
4. In den Einstellungen einen KI-Anbieter einrichten.

**Wichtig:** Alle Daten liegen nur auf dem Gerät. Safari kann Website-Daten löschen, wenn wenig Speicher frei ist. Exportiere deshalb regelmäßig unter *Einstellungen → Backup*.

## Entwicklung

```bash
npm install
npm run dev          # lokaler Server
npm test             # Unit-Tests (Logik, Schemas, KI-Schicht mit Attrappe, Datenbank)
npm run e2e          # Playwright im iPad-Format, Gemini-API gemockt
GEMINI_API_KEY=… ANTHROPIC_API_KEY=… npm run live-test   # Test gegen die echten APIs
```

Für den Live-Test kannst du eigene PDFs und Fotos von Handschrift in `testdata/` legen. Der Ordner ist per `.gitignore` vom Repo ausgeschlossen.

Struktur: `src/lib/ai/` (Anbieter, Prompts, Validierung), `src/lib/scheduler.ts` (FSRS, Beherrschungswert, Sessions), `src/lib/ink.ts` (Zeichenlogik), `src/components/InkCanvas.tsx`, `src/pages/`.
