/** Modellauswahl für Gemini – ohne SDK-Import, damit sie auch beim App-Start genutzt werden kann. */

/** Wählt ein sinnvolles Standardmodell: neueste „flash“-Version (gutes Free-Tier-Kontingent), sonst neuestes „pro“. */
export function pickDefaultGeminiModel(ids: string[]): string | undefined {
  const version = (id: string) => {
    const m = id.match(/gemini-(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : 0;
  };
  const stable = (id: string) => !/(preview|exp|latest)/.test(id);
  // Stabile Modelle zuerst (Previews sind im Free Tier oft überlastet), dann neueste Version, dann Flash vor Pro.
  const rank = (id: string) =>
    (stable(id) ? 100_000 : 0) + version(id) * 100 + (/flash/.test(id) && !/lite/.test(id) ? 5 : /pro/.test(id) ? 2 : /lite/.test(id) ? 1 : 0);
  return [...ids].sort((a, b) => rank(b) - rank(a))[0];
}

/** Standardmodell zum Bewerten: neuestes stabiles Flash-Lite (größtes Gratis-Kontingent), sonst wie beim Erstellen. */
export function pickDefaultGeminiGradeModel(ids: string[]): string | undefined {
  const lite = ids.filter((id) => /flash/.test(id) && /lite/.test(id) && !/(preview|exp|latest)/.test(id));
  return pickDefaultGeminiModel(lite) ?? pickDefaultGeminiModel(ids);
}

/**
 * Ausweichmodelle: andere stabile Flash-Modelle, neueste zuerst, Lite-Varianten zuletzt.
 * Bei Überlastung trifft es meist nur einzelne Modelle, daher lieber mehrere Kandidaten.
 */
export function pickFallbackModels(ids: string[], current: string, max = 4): string[] {
  const stable = ids.filter((id) => id !== current && /flash/.test(id) && !/(preview|exp|latest)/.test(id));
  const byRank = (list: string[]) => {
    const out: string[] = [];
    let rest = list;
    while (rest.length) {
      const best = pickDefaultGeminiModel(rest)!;
      out.push(best);
      rest = rest.filter((x) => x !== best);
    }
    return out;
  };
  const lite = (id: string) => /lite/.test(id);
  return [...byRank(stable.filter((id) => !lite(id))), ...byRank(stable.filter(lite))].slice(0, max);
}
