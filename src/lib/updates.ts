import { useSyncExternalStore } from "react";
import { registerSW } from "virtual:pwa-register";

/**
 * App-Updates ohne Neuinstallation: Der Service Worker sucht beim Öffnen/Zurückkehren
 * in die App (und stündlich) nach einer neuen Version. Ist eine da, wird sie
 * automatisch geladen, solange keine Lernsession läuft – sonst erscheint ein Hinweis.
 */
let needRefresh = false;
const listeners = new Set<() => void>();
let applyUpdate: ((reload?: boolean) => Promise<void>) | null = null;

const inStudy = () => /\/study/.test(location.hash);

export function initUpdates() {
  if (!("serviceWorker" in navigator)) return;
  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      // Außerhalb einer Lernsession sofort aktualisieren (keine ungesicherte Handschrift gefährdet).
      if (!inStudy()) void applyUpdate?.(true);
      else {
        needRefresh = true;
        listeners.forEach((l) => l());
      }
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => void reg.update().catch(() => undefined);
      setInterval(check, 60 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
    },
  });
}

export function updateNow() {
  void applyUpdate?.(true);
}

export function useUpdateAvailable(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => needRefresh,
    () => false,
  );
}
