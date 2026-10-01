import { useSyncExternalStore } from "react";
import type { ProviderId } from "./ai/types";
import { DEFAULT_CLAUDE_MODEL } from "./ai/models";

/** Wofür die KI genutzt wird: Material analysieren/Aufgaben erstellen oder Antworten bewerten. */
export type Purpose = "create" | "grade";

export interface Settings {
  /** KI für Analyse und Aufgabenerstellung (teuer, viele PDF-Tokens). */
  createProvider: ProviderId;
  /** KI für die Bewertung offener Antworten (günstig pro Aufruf). */
  gradeProvider: ProviderId;
  geminiKey: string;
  geminiModel: string;
  /** Beim Verbinden geladene Modellliste (für Ausweichmodelle). */
  geminiModels: string[];
  claudeKey: string;
  claudeModel: string;
  /** Monatliches Claude-Budget in Euro; 0 = keine Sperre. */
  claudeMonthlyBudgetEur: number;
  /** Wechselkurs: 1 US-Dollar = x Euro. */
  usdToEur: number;
  /** Datum des EZB-Kurses (YYYY-MM-DD), leer wenn nie abgerufen. */
  usdToEurDate: string;
  usdToEurSource: "default" | "ecb" | "manual";
  usdToEurFetchedAt: number;
  /** PDFs bei der Aufgabenerstellung mit Claude erneut mitschicken (bessere Aufgaben, deutlich teurer). */
  sendPdfsWithClaude: boolean;
  /** Offene Aufgaben automatisch per KI bewerten (sonst Selbstvergleich + Button). */
  autoGrade: boolean;
  /** Auch mit dem Finger zeichnen (sonst nur Apple Pencil / Maus). */
  fingerDraws: boolean;
  penWidth: number;
  penColor: string;
  newPerSession: number;
}

const KEY = "lerntool.settings.v1";

export const DEFAULT_SETTINGS: Settings = {
  createProvider: "gemini",
  gradeProvider: "gemini",
  geminiKey: "",
  geminiModel: "",
  geminiModels: [],
  claudeKey: "",
  claudeModel: DEFAULT_CLAUDE_MODEL,
  claudeMonthlyBudgetEur: 5,
  // Platzhalter bis zum ersten Abruf des EZB-Kurses
  usdToEur: 0.86,
  usdToEurDate: "",
  usdToEurSource: "default",
  usdToEurFetchedAt: 0,
  sendPdfsWithClaude: false,
  autoGrade: false,
  fingerDraws: false,
  penWidth: 3,
  penColor: "#1d1d1f",
  newPerSession: 10,
};

let cache: Settings | null = null;
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const stored = raw ? JSON.parse(raw) : {};
    // Ältere Version hatte nur einen gemeinsamen Anbieter.
    if (stored.provider && !stored.createProvider) {
      stored.createProvider = stored.provider;
      stored.gradeProvider = stored.provider;
    }
    delete stored.provider;
    // Ältere Version speicherte das Budget in Dollar.
    if (stored.claudeMonthlyBudget !== undefined && stored.claudeMonthlyBudgetEur === undefined) {
      stored.claudeMonthlyBudgetEur = stored.claudeMonthlyBudget;
    }
    delete stored.claudeMonthlyBudget;
    cache = { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache!;
}

export function updateSettings(patch: Partial<Settings>) {
  cache = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* Speicher nicht verfügbar – Einstellungen gelten nur bis zum Neuladen. */
  }
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSettings,
    getSettings,
  );
}

export function providerReady(p: ProviderId, s: Settings = getSettings()): boolean {
  return p === "gemini" ? !!s.geminiKey && !!s.geminiModel : !!s.claudeKey;
}

export function providerFor(purpose: Purpose, s: Settings = getSettings()): ProviderId {
  return purpose === "grade" ? s.gradeProvider : s.createProvider;
}

/** Ist die KI für diesen Zweck eingerichtet? */
export function hasActiveKey(s: Settings = getSettings(), purpose: Purpose = "create"): boolean {
  return providerReady(providerFor(purpose, s), s);
}

export const PROVIDER_LABEL: Record<ProviderId, string> = { gemini: "Gemini", claude: "Claude" };
