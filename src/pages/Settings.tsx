import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { ErrorBanner, useBusy } from "../components/Busy";
import { claudeCostThisMonth, defaultCallOptions, getBackendFor } from "../lib/ai";
import type { ProviderId } from "../lib/ai/types";
import { CLAUDE_MODELS } from "../lib/ai/models";
import type { GeminiModelInfo } from "../lib/ai/gemini";
import { exportAll, importAll } from "../lib/backup";
import { db } from "../lib/db";
import { formatEur, formatUsdAsEur, refreshRateIfStale } from "../lib/currency";
import { PROVIDER_LABEL, providerReady, updateSettings, useSettings } from "../lib/settings";

const TEST_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" }, message: { type: "string" } },
  required: ["ok", "message"],
  additionalProperties: false,
};

export function SettingsPage() {
  const s = useSettings();
  const busy = useBusy();
  const [models, setModels] = useState<GeminiModelInfo[]>([]);
  const [showKey, setShowKey] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [estimate, setEstimate] = useState<string>("");

  useEffect(() => {
    navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
    navigator.storage?.estimate?.().then((e) => setEstimate(`${((e.usage ?? 0) / 1024 / 1024).toFixed(1)} MB belegt`)).catch(() => undefined);
  }, []);

  const usage = useLiveQuery(async () => {
    const since = Date.now() - 30 * 86_400_000;
    const rows = await db.usage.where("at").above(since).toArray();
    const sum = (p: string) => rows.filter((r) => r.provider === p);
    const agg = (rs: typeof rows) => ({
      calls: rs.length,
      tokens: rs.reduce((a, r) => a + r.inputTokens + r.outputTokens + r.cachedInputTokens, 0),
      cost: rs.reduce((a, r) => a + r.costUsd, 0),
    });
    return { gemini: agg(sum("gemini")), claude: agg(sum("claude")), claudeMonth: await claudeCostThisMonth() };
  }, []);

  const loadModels = () =>
    busy.run("Verbinde mit Gemini …", async () => {
      const { listGeminiModels, pickDefaultGeminiModel } = await import("../lib/ai/gemini");
      const list = await listGeminiModels(s.geminiKey.trim());
      setModels(list);
      if (!list.length) throw new Error("Keine passenden Gemini-Modelle gefunden.");
      const keep = list.some((m) => m.id === s.geminiModel);
      const ids = list.map((m) => m.id);
      const best = pickDefaultGeminiModel(ids) ?? ids[0];
      // Vorabversionen (Preview) sind im Free Tier oft überlastet → auf stabiles Modell wechseln.
      const isPreview = /(preview|exp|latest)/.test(s.geminiModel);
      updateSettings({ geminiModels: ids, geminiModel: keep && !isPreview ? s.geminiModel : best });
      setMsg(`Verbunden – ${list.length} Modelle verfügbar.`);
    });

  const testConnection = (provider: ProviderId) =>
    busy.run("Teste Verbindung …", async ({ signal }) => {
      const backend = await getBackendFor(provider);
      const res = await backend.complete({
        system: "Antworte knapp auf Deutsch.",
        parts: [{ type: "text", text: 'Antworte mit ok=true und message="Verbindung steht".' }],
        schema: TEST_SCHEMA,
        effort: "low",
        maxTokens: 2000,
        signal,
      });
      defaultCallOptions().onUsage?.(res.usage, res.model, "test");
      setMsg(`✅ ${backend.provider === "claude" ? "Claude" : "Gemini"} antwortet (${res.model}).`);
    });

  const doExport = async () => {
    const json = await exportAll();
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `lerntool-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const doImport = (file: File | undefined) =>
    file &&
    busy.run("Importiere …", async () => {
      const r = await importAll(await file.text());
      setMsg(`Import fertig: ${r.courses} Kurse, ${r.items} Aufgaben.`);
    });

  return (
    <main className="page stack">
      <h1>Einstellungen</h1>
      <ErrorBanner />
      {msg && <p className="notice good" data-testid="settings-msg">{msg}</p>}

      <section className="card stack">
        <h2>Welche KI wofür?</h2>
        <p className="small muted">
          Am günstigsten: <b>Erstellen mit Gemini</b> (kostenlos) und <b>Bewerten mit Claude</b>. Die Bewertung einer Antwort kostet nur Cent-Beträge,
          das Erstellen liest dagegen ganze PDFs und ist mit Claude der größte Kostenblock.
        </p>
        {(["create", "grade"] as const).map((purpose) => {
          const key = purpose === "create" ? "createProvider" : "gradeProvider";
          const current = s[key];
          return (
            <div key={purpose} className="spread">
              <span style={{ minWidth: 260 }}>{purpose === "create" ? "Material analysieren & Aufgaben erstellen" : "Antworten bewerten (Text & Handschrift)"}</span>
              <div className="row">
                {(["gemini", "claude"] as const).map((p) => (
                  <button key={p} className={current === p ? "active" : ""} onClick={() => updateSettings({ [key]: p })} data-testid={`${purpose}-${p}`}>
                    {PROVIDER_LABEL[p]}
                    {!providerReady(p, s) && <span className="badge warn">nicht eingerichtet</span>}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {s.createProvider === "claude" && (
          <label className="check">
            <input type="checkbox" checked={s.sendPdfsWithClaude} onChange={(e) => updateSettings({ sendPdfsWithClaude: e.target.checked })} data-testid="send-pdfs-claude" />
            <span>
              PDFs bei der Aufgabenerstellung mit Claude erneut mitschicken
              <span className="hint muted small" style={{ display: "block" }}>
                Aus (Sparmodus): Claude nutzt nur die bei der Analyse erkannten Themen, Konzepte und Formeln – ein Bruchteil der Kosten, Aufgaben etwas allgemeiner. An: Aufgaben näher am Material, kostet pro Durchgang etwa so viel wie die Analyse.
              </span>
            </span>
          </label>
        )}
      </section>

      <section className="card stack">
        <h2>Google Gemini (kostenlos)</h2>
        <label className="field">
          Gemini-API-Key
          <span className="hint">Erstellen unter <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a> oder in der Google Cloud Console (APIs &amp; Dienste → Anmeldedaten).</span>
          <input type={showKey ? "text" : "password"} value={s.geminiKey} onChange={(e) => updateSettings({ geminiKey: e.target.value.trim() })} autoComplete="off" spellCheck={false} placeholder="AIza…" data-testid="gemini-key" />
        </label>
        <div className="row">
          <button onClick={() => setShowKey(!showKey)} className="small">{showKey ? "Keys verbergen" : "Keys anzeigen"}</button>
          <button className="primary" disabled={!s.geminiKey} onClick={loadModels} data-testid="gemini-connect">Verbinden & Modelle laden</button>
          <button onClick={() => testConnection("gemini")} disabled={!s.geminiKey || !s.geminiModel} data-testid="test-gemini">Verbindung testen</button>
        </div>
        {(models.length > 0 || s.geminiModel) && (
          <label className="field">
            Modell
            <select value={s.geminiModel} onChange={(e) => updateSettings({ geminiModel: e.target.value })} data-testid="gemini-model">
              {!models.some((m) => m.id === s.geminiModel) && s.geminiModel && <option value={s.geminiModel}>{s.geminiModel}</option>}
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            {/(preview|exp|latest)/.test(s.geminiModel) && (
              <span className="notice warn small" data-testid="preview-warning">Das ist eine Vorabversion (Preview). Solche Modelle sind in der kostenlosen Stufe oft überlastet – besser ein stabiles „Flash“-Modell wählen.</span>
            )}
            <span className="hint">Empfohlen: das neueste stabile „Flash“-Modell (großes kostenloses Kontingent). „Pro“-Modelle sind stärker, haben im Free Tier aber engere Limits.</span>
          </label>
        )}
        <p className="notice warn small">In der kostenlosen Stufe darf Google deine Eingaben (z. B. hochgeladene Folien) zur Verbesserung seiner Produkte verwenden. Es gelten Limits pro Minute und Tag.</p>
      </section>

      <section className="card stack">
        <h2>Anthropic Claude (kostenpflichtig)</h2>
        <label className="field">
          Claude-API-Key
          <span className="hint">Aus der <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Anthropic Console</a>. Wird separat abgerechnet – ein Claude.ai-Abo enthält keinen API-Zugang. In der Console Guthaben vorab aufladen und automatisches Aufladen ausgeschaltet lassen.</span>
          <input type={showKey ? "text" : "password"} value={s.claudeKey} onChange={(e) => updateSettings({ claudeKey: e.target.value.trim() })} autoComplete="off" spellCheck={false} placeholder="sk-ant-…" data-testid="claude-key" />
        </label>
        <div className="row">
          <button onClick={() => testConnection("claude")} disabled={!s.claudeKey} data-testid="test-claude">Verbindung testen</button>
        </div>
        <label className="field">
          Modell
          <select value={s.claudeModel} onChange={(e) => updateSettings({ claudeModel: e.target.value })}>
            {CLAUDE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} – ca. {formatUsdAsEur(m.inputPerM)} / {formatUsdAsEur(m.outputPerM)} pro 1 Mio. Tokens (Ein-/Ausgabe)</option>)}
          </select>
        </label>
        <label className="field" style={{ maxWidth: 360 }}>
          Monatsbudget in € (0 = keine Sperre)
          <span className="hint">Ist es erreicht, blockiert die App weitere Claude-Anfragen bis zum Monatsende. Diese Sperre wirkt nur in der App, deshalb zusätzlich das Limit in der Anthropic Console nutzen.</span>
          <input type="number" min={0} step={0.5} value={s.claudeMonthlyBudgetEur} onChange={(e) => updateSettings({ claudeMonthlyBudgetEur: Math.max(0, Number(e.target.value) || 0) })} data-testid="claude-budget" />
        </label>
        <p className="small" data-testid="claude-month">
          Diesen Monat verbraucht: ca. {formatUsdAsEur(usage?.claudeMonth ?? 0)}
          {s.claudeMonthlyBudgetEur > 0 ? ` von ${formatEur(s.claudeMonthlyBudgetEur)}` : ""}
        </p>
        <div className="stack" style={{ gap: 6 }}>
          <p className="small" data-testid="rate-info">
            Umrechnung: 1 $ = {s.usdToEur.toLocaleString("de-DE", { maximumFractionDigits: 4 })} €{" "}
            {s.usdToEurSource === "ecb" && <span className="muted">(EZB-Referenzkurs vom {new Date(s.usdToEurDate).toLocaleDateString("de-DE")})</span>}
            {s.usdToEurSource === "manual" && <span className="muted">(manuell festgelegt)</span>}
            {s.usdToEurSource === "default" && <span className="badge warn">Platzhalter – noch kein aktueller Kurs geladen</span>}
          </p>
          <div className="row">
            <button
              className="small"
              data-testid="rate-refresh"
              onClick={() =>
                busy.run("Lade Wechselkurs …", async () => {
                  if (!(await refreshRateIfStale(true))) throw new Error("Wechselkurs konnte nicht geladen werden (offline?). Der bisherige Kurs bleibt aktiv.");
                  setMsg("Wechselkurs aktualisiert.");
                })
              }
            >
              EZB-Kurs aktualisieren
            </button>
            <label className="row small">
              oder selbst festlegen:
              <input
                type="number"
                min={0.3}
                max={3}
                step={0.01}
                style={{ width: 110 }}
                aria-label="Wechselkurs manuell"
                defaultValue={s.usdToEur}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 0.3 && v <= 3) updateSettings({ usdToEur: v, usdToEurSource: "manual" });
                }}
              />
            </label>
          </div>
          <p className="muted small">Anthropic rechnet in US-Dollar ab. Deine Bank rechnet beim Abbuchen mit ihrem eigenen Kurs um und erhebt ggf. Auslandsgebühren – die Euro-Werte sind daher Näherungen.</p>
        </div>
      </section>
      <p className="muted small">Die Keys werden nur auf diesem Gerät gespeichert (Browser-Speicher) und direkt an Google bzw. Anthropic geschickt – nie an einen anderen Server.</p>

      <section className="card stack">
        <h2>Lernen</h2>
        <label className="check">
          <input type="checkbox" checked={s.autoGrade} onChange={(e) => updateSettings({ autoGrade: e.target.checked })} />
          Offene Aufgaben automatisch von der KI bewerten lassen (sonst: Selbstvergleich, KI auf Knopfdruck)
        </label>
        <label className="check">
          <input type="checkbox" checked={s.fingerDraws} onChange={(e) => updateSettings({ fingerDraws: e.target.checked })} />
          Auch mit dem Finger zeichnen (sonst nur Apple Pencil – der Finger scrollt)
        </label>
        <label className="field" style={{ maxWidth: 320 }}>
          Neue Aufgaben pro Lernsession
          <input type="number" min={0} max={50} value={s.newPerSession} onChange={(e) => updateSettings({ newPerSession: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
      </section>

      <section className="card stack">
        <h2>Verbrauch (letzte 30 Tage)</h2>
        <p>Gemini: {usage?.gemini.calls ?? 0} Anfragen, {(usage?.gemini.tokens ?? 0).toLocaleString("de-DE")} Tokens (kostenlos im Free Tier)</p>
        <p>Claude: {usage?.claude.calls ?? 0} Anfragen, {(usage?.claude.tokens ?? 0).toLocaleString("de-DE")} Tokens, ca. {formatUsdAsEur(usage?.claude.cost ?? 0)}</p>
      </section>

      <section className="card stack">
        <h2>Daten & Backup</h2>
        <p className="small">
          Alles liegt nur auf diesem Gerät. Safari kann Website-Daten bei Speichermangel löschen – mach regelmäßig ein Backup.
          {persisted !== null && <> Dauerhafter Speicher: <b>{persisted ? "aktiv" : "nicht gewährt"}</b>.</>} {estimate}
        </p>
        <div className="row">
          <button onClick={doExport}>⬇️ Backup exportieren</button>
          <label className="btn">
            ⬆️ Backup importieren
            <input type="file" accept="application/json,.json" hidden onChange={(e) => void doImport(e.target.files?.[0])} />
          </label>
        </div>
      </section>
      <p className="muted small" data-testid="app-version">
        App-Version: {new Date(__BUILD_TIME__).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })} – Updates werden automatisch geladen.
      </p>
    </main>
  );
}
