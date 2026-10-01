import { getSettings, updateSettings } from "./settings";

/**
 * Anthropic rechnet in US-Dollar ab. Die App rechnet alle Beträge mit dem
 * EZB-Referenzkurs in Euro um (Quelle: Frankfurter-API, die die EZB-Kurse spiegelt).
 * Deine Bank nutzt beim Abbuchen ihren eigenen Kurs und ggf. Gebühren – die Euro-Werte sind daher Näherungen.
 */
export const RATE_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR";
const ONE_DAY = 86_400_000;

export function usdToEur(usd: number, rate = getSettings().usdToEur): number {
  return usd * rate;
}

export function eurToUsd(eur: number, rate = getSettings().usdToEur): number {
  return rate > 0 ? eur / rate : eur;
}

const fmt = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatEur(eur: number): string {
  if (eur > 0 && eur < 0.01) return "< 0,01 €";
  return `${fmt.format(eur)} €`;
}

/** Formatiert einen Dollar-Betrag als Euro zum aktuellen Kurs. */
export function formatUsdAsEur(usd: number, rate = getSettings().usdToEur): string {
  return formatEur(usdToEur(usd, rate));
}

/** Holt den aktuellen EZB-Referenzkurs. Wirft bei Netzwerkfehlern. */
export async function fetchUsdEurRate(fetchFn: typeof fetch = fetch): Promise<{ rate: number; date: string }> {
  const res = await fetchFn(RATE_URL);
  if (!res.ok) throw new Error(`Wechselkurs nicht abrufbar (HTTP ${res.status})`);
  const data = (await res.json()) as { date?: string; rates?: { EUR?: number } };
  const rate = data.rates?.EUR;
  if (!rate || !Number.isFinite(rate) || rate < 0.3 || rate > 3) throw new Error("Ungültiger Wechselkurs erhalten");
  return { rate, date: data.date ?? new Date().toISOString().slice(0, 10) };
}

/** Aktualisiert den Kurs höchstens einmal täglich – außer er wurde manuell festgelegt. */
export async function refreshRateIfStale(force = false, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const s = getSettings();
  if (!force && (s.usdToEurSource === "manual" || Date.now() - s.usdToEurFetchedAt < ONE_DAY)) return false;
  try {
    const { rate, date } = await fetchUsdEurRate(fetchFn);
    updateSettings({ usdToEur: rate, usdToEurDate: date, usdToEurSource: "ecb", usdToEurFetchedAt: Date.now() });
    return true;
  } catch {
    return false; // offline: letzten bekannten Kurs behalten
  }
}
