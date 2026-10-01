import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Link, Route, Routes, useLocation } from "react-router-dom";
import { BusyProvider } from "./components/Busy";
import { HomePage } from "./pages/Home";
import { CoursePage } from "./pages/Course";
import { StudyPage } from "./pages/Study";
import { SettingsPage } from "./pages/Settings";
import { refreshRateIfStale } from "./lib/currency";
import "./styles.css";

// Daten möglichst vor automatischem Löschen durch Safari schützen.
void navigator.storage?.persist?.().catch(() => undefined);
// Euro-Umrechnung aktuell halten (EZB-Kurs, höchstens einmal täglich).
void refreshRateIfStale();

/** Großer Zurück-Button in der fixierten Kopfleiste (auf allen Unterseiten). */
function BackButton() {
  const { pathname } = useLocation();
  if (pathname === "/") return null;
  const study = pathname.match(/^\/course\/([^/]+)\/study/);
  const to = study ? `/course/${study[1]}` : "/";
  return (
    <Link to={to} className="btn back-btn" data-testid="back">
      <span className="chev" aria-hidden>‹</span> {study ? "Kurs" : "Kurse"}
    </Link>
  );
}

function App() {
  return (
    <BusyProvider>
      <header className="topbar">
        <BackButton />
        <Link to="/" className="brand">📚 Lerntool</Link>
        <span className="spacer" />
        <Link to="/settings" className="btn small ghost" aria-label="Einstellungen">⚙️ Einstellungen</Link>
      </header>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/course/:courseId" element={<CoursePage />} />
        <Route path="/course/:courseId/study" element={<StudyPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<div className="page">Seite nicht gefunden. <Link to="/">Zur Startseite</Link></div>} />
      </Routes>
    </BusyProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
