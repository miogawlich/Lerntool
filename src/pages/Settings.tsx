import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ErrorBanner, useBusy } from "../components/Busy";
import { defaultCallOptions, getBackend } from "../lib/ai";
import { CLAUDE_MODELS } from "../lib/ai/models";
import type { GeminiModelInfo } from "../lib/ai/gemini";
import { exportAll, importAll } from "../lib/backup";
import { db } from "../lib/db";
import { updateSettings, useSettings } from "../lib/settings";

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
    return { gemini: agg(sum("gemini")), claude: agg(sum("claude")) };
  }, []);

  const loadModels = () =>
    busy.run("Verbinde mit Gemini …", async () => {
      const { listGeminiModels, pickDefaultGeminiModel } = await import("../lib/ai/gemini");
      const list = await listGeminiModels(s.geminiKey.trim());
      setModels(list);
      if (!list.length) throw new Error("Keine passenden Gemini-Modelle gefunden.");
      const keep = list.some((m) => m.id === s.geminiModel);
      updateSettings({ geminiModel: keep ? s.geminiModel : pickDefaultGeminiModel(list.map((m) => m.id)) ?? list[0].id });
      setMsg(`Verbunden – ${list.length} Modelle verfügbar.`);
    });

  const testConnection = () =>
    busy.run("Teste Verbindung …", async ({ signal }) => {
      const backend = await getBackend();
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
      <Link to="/" className="crumb small">← Kurse</Link>
      <h1>Einstellungen</h1>
      <ErrorBanner />
      {msg && <p className="notice good" data-testid="settings-msg">{msg}</p>}

      <section className="card stack">
        <h2>KI-Anbieter</h2>
        <div className="row">
          <button className={s.provider === "gemini" ? "active" : ""} onClick={() => updateSettings({ provider: "gemini" })}>Google Gemini (kostenlos)</button>
          <button className={s.provider === "claude" ? "active" : ""} onClick={() => updateSettings({ provider: "claude" })}>Anthropic Claude (kostenpflichtig)</button>
        </div>

        {s.provider === "gemini" ? (
          <div className="stack">
            <label className="field">
              Gemini-API-Key
              <span className="hint">Kostenlos erstellen unter <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>.</span>
              <input type={showKey ? "text" : "password"} value={s.geminiKey} onChange={(e) => updateSettings({ geminiKey: e.target.value.trim() })} autoComplete="off" spellCheck={false} placeholder="AIza…" data-testid="gemini-key" />
            </label>
            <div className="row">
              <button onClick={() => setShowKey(!showKey)} className="small">{showKey ? "Verbergen" : "Anzeigen"}</button>
              <button className="primary" disabled={!s.geminiKey} onClick={loadModels} data-testid="gemini-connect">Verbinden & Modelle laden</button>
            </div>
            {(models.length > 0 || s.geminiModel) && (
              <label className="field">
                Modell
                <select value={s.geminiModel} onChange={(e) => updateSettings({ geminiModel: e.target.value })} data-testid="gemini-model">
                  {!models.some((m) => m.id === s.geminiModel) && s.geminiModel && <option value={s.geminiModel}>{s.geminiModel}</option>}
                  {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <span className="hint">Empfohlen: das neueste „Flash“-Modell (großes kostenloses Kontingent). „Pro“-Modelle sind stärker, haben im Free Tier aber engere Limits.</span>
              </label>
            )}
            <p className="notice warn small">Hinweis: In der kostenlosen Stufe darf Google deine Eingaben (z. B. hochgeladene Folien) zur Verbesserung seiner Produkte verwenden. Es gelten Limits pro Minute und Tag.</p>
          </div>
        ) : (
          <div className="stack">
            <label className="field">
              Claude-API-Key
              <span className="hint">Aus der <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Anthropic Console</a>. Wird separat abgerechnet – ein Claude.ai-Abo enthält keinen API-Zugang. Setze dort am besten ein Ausgabenlimit.</span>
              <input type={showKey ? "text" : "password"} value={s.claudeKey} onChange={(e) => updateSettings({ claudeKey: e.target.value.trim() })} autoComplete="off" spellCheck={false} placeholder="sk-ant-…" data-testid="claude-key" />
            </label>
            <button onClick={() => setShowKey(!showKey)} className="small" style={{ alignSelf: "flex-start" }}>{showKey ? "Verbergen" : "Anzeigen"}</button>
            <label className="field">
              Modell
              <select value={s.claudeModel} onChange={(e) => updateSettings({ claudeModel: e.target.value })}>
                {CLAUDE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} – {m.inputPerM} $/{m.outputPerM} $ pro 1 Mio. Tokens</option>)}
              </select>
            </label>
          </div>
        )}
        <div className="row">
          <button onClick={testConnection} disabled={s.provider === "gemini" ? !s.geminiKey || !s.geminiModel : !s.claudeKey} data-testid="test-connection">Verbindung testen</button>
        </div>
        <p className="muted small">Die Keys werden nur auf diesem Gerät gespeichert (Browser-Speicher) und direkt an Google bzw. Anthropic geschickt – nie an einen anderen Server.</p>
      </section>

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
        <p>Claude: {usage?.claude.calls ?? 0} Anfragen, {(usage?.claude.tokens ?? 0).toLocaleString("de-DE")} Tokens, ca. {(usage?.claude.cost ?? 0).toFixed(2)} $</p>
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
    </main>
  );
}
