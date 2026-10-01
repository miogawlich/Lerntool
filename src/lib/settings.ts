import { useSyncExternalStore } from "react";
import type { ProviderId } from "./ai/types";
import { DEFAULT_CLAUDE_MODEL } from "./ai/claude";

export interface Settings {
  provider: ProviderId;
  geminiKey: string;
  geminiModel: string;
  claudeKey: string;
  claudeModel: string;
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
  provider: "gemini",
  geminiKey: "",
  geminiModel: "",
  claudeKey: "",
  claudeModel: DEFAULT_CLAUDE_MODEL,
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
    cache = { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
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

export function hasActiveKey(s: Settings = getSettings()): boolean {
  return s.provider === "gemini" ? !!s.geminiKey && !!s.geminiModel : !!s.claudeKey;
}
