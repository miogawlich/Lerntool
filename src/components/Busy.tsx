import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { AIError } from "../lib/ai/types";

interface BusyState {
  step: string;
  chars?: number;
}

interface BusyApi {
  /** Führt eine (KI-)Aktion mit Overlay, Abbrechen-Knopf und Fehleranzeige aus. */
  run<T>(label: string, fn: (ctx: { signal: AbortSignal; progress: (step: string, chars?: number) => void }) => Promise<T>): Promise<T | undefined>;
  error: string | null;
  clearError(): void;
}

const Ctx = createContext<BusyApi | null>(null);

export function errorMessage(e: unknown): string {
  if (e instanceof AIError) return e.message;
  if (e instanceof DOMException && e.name === "AbortError") return "Abgebrochen.";
  if (e instanceof Error) {
    if (/abort/i.test(e.name) || /aborted/i.test(e.message)) return "Abgebrochen.";
    return e.message;
  }
  return String(e);
}

export function BusyProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BusyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const run = useCallback<BusyApi["run"]>(async (label, fn) => {
    const c = new AbortController();
    ctrl.current = c;
    setError(null);
    setState({ step: label });
    try {
      return await fn({ signal: c.signal, progress: (step, chars) => setState({ step, chars }) });
    } catch (e) {
      console.error(e);
      setError(errorMessage(e));
      return undefined;
    } finally {
      setState(null);
      ctrl.current = null;
    }
  }, []);

  return (
    <Ctx.Provider value={{ run, error, clearError: () => setError(null) }}>
      {children}
      {state && (
        <div className="overlay" role="dialog" aria-live="polite">
          <div className="card">
            <div className="spinner" />
            <p data-testid="busy-step">{state.step}</p>
            {state.chars ? <p className="muted small">{state.chars.toLocaleString("de-DE")} Zeichen empfangen</p> : <p className="muted small">Das kann bei großen PDFs ein bis zwei Minuten dauern.</p>}
            <button onClick={() => ctrl.current?.abort()}>Abbrechen</button>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useBusy(): BusyApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("BusyProvider fehlt");
  return v;
}

export function ErrorBanner() {
  const { error, clearError } = useBusy();
  if (!error) return null;
  return (
    <div className="notice error spread" role="alert" style={{ marginBottom: 14 }}>
      <span>{error}</span>
      <button className="small ghost" onClick={clearError} aria-label="Fehler schließen">✕</button>
    </div>
  );
}
