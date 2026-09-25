import pino from "pino";
import type { CalendarEvent } from "./economic-calendar.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

/**
 * Actual figures for released calendar events. ForexFactory's feed has forecast/previous but never the
 * actual, and the old secondary calendar leaves it empty, so results were almost never posted. Nasdaq's
 * public economic-calendar API (Investing.com data) carries actual / consensus / previous.
 * Quirk (verified): rows returned for ?date=D belong to the US-Eastern day D-1 and times are US-Eastern.
 * Both D-1 and D are tried and an event only matches within 90 minutes of its scheduled time, with
 * the same country and a matching name, so a day-shift can never attach a figure to the wrong release.
 */
export type NasdaqRow = { at: number; country: string; name: string; actual: string | null; consensus: string | null; previous: string | null };

const COUNTRY: Record<string, string[]> = {
  USD: ["united states"], EUR: ["euro zone", "germany", "france", "italy", "spain"], GBP: ["united kingdom"], JPY: ["japan"],
  AUD: ["australia"], CAD: ["canada"], CHF: ["switzerland"], NZD: ["new zealand"], CNY: ["china"]
};
const clean = (v: unknown): string | null => {
  const s = String(v ?? "").replace(/&nbsp;|\bnbsp;?/gi, " ").replace(/\s+/g, " ").trim();
  return s && s !== "-" ? s : null;
};
/** Offset of US-Eastern from UTC (hours) on a given calendar day, DST-aware. */
function easternOffset(day: string): number {
  const probe = new Date(`${day}T12:00:00Z`);
  const et = new Date(probe.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const utc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((et.getTime() - utc.getTime()) / 3_600_000);
}
const shift = (day: string, d: number) => new Date(Date.parse(`${day}T00:00:00Z`) + d * 86400_000).toISOString().slice(0, 10);

export function parseNasdaq(json: unknown, queryDay: string): NasdaqRow[] {
  const rows = (json as { data?: { rows?: Array<Record<string, unknown>> } })?.data?.rows ?? [];
  const out: NasdaqRow[] = [];
  for (const r of rows) {
    const t = String(r.gmt ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!t) continue; // "All Day", tentative
    // The row's day is ambiguous (see header), so both readings are kept; the matcher picks by time.
    for (const day of [shift(queryDay, -1), queryDay]) {
      const at = Date.parse(`${day}T${t[1].padStart(2, "0")}:${t[2]}:00Z`) - easternOffset(day) * 3_600_000;
      out.push({ at, country: String(r.country ?? "").toLowerCase(), name: String(r.eventName ?? ""), actual: clean(r.actual), consensus: clean(r.consensus), previous: clean(r.previous) });
    }
  }
  return out;
}

const DROP = new Set(["s&p", "global", "hcob", "flash", "prelim", "preliminary", "final", "adjusted", "the", "of", "sa", "nsa", "index", "us", "u.s.", "german", "french", "italian", "spanish", "uk", "eurozone", "japan", "japanese", "(mom)", "(yoy)", "(qoq)"]);
const PERIOD = (s: string) => /\bm\/m|\(mom\)|month/i.test(s) ? "M" : /\by\/y|\(yoy\)|year/i.test(s) ? "Y" : /\bq\/q|\(qoq\)|quarter/i.test(s) ? "Q" : "";
function tokens(name: string): Set<string> {
  return new Set(name.toLowerCase().replace(/[()]/g, " ").replace(/\b(m\/m|y\/y|q\/q|mom|yoy|qoq)\b/g, " ").split(/[^a-z0-9&.]+/)
    .map((w) => w === "claims" ? "claim" : w === "sales" ? "sale" : w).filter((w) => w.length > 1 && !DROP.has(w)));
}
const NATION: Record<string, string> = { german: "germany", french: "france", italian: "italy", spanish: "spain" };

/** The Nasdaq row that is the same release as the calendar event, or undefined. */
export function matchRow(event: Pick<CalendarEvent, "name" | "releaseAt">, currency: string, rows: NasdaqRow[]): NasdaqRow | undefined {
  const countries = COUNTRY[currency];
  if (!countries) return undefined;
  const nation = Object.entries(NATION).find(([adj]) => new RegExp(`^${adj}\\b`, "i").test(event.name))?.[1];
  const at = Date.parse(event.releaseAt), want = tokens(event.name), period = PERIOD(event.name);
  let best: { row: NasdaqRow; score: number; dt: number } | undefined;
  for (const row of rows) {
    if (!row.actual || !countries.includes(row.country) || (nation && row.country !== nation)) continue;
    if (currency === "EUR" && !nation && row.country !== "euro zone") continue;
    const dt = Math.abs(row.at - at);
    if (dt > 90 * 60_000) continue;
    if (period && PERIOD(row.name) && PERIOD(row.name) !== period) continue;
    const got = tokens(row.name);
    const common = [...want].filter((w) => got.has(w)).length;
    if (common / Math.max(1, Math.min(want.size, got.size)) < 0.75) continue;
    // Tie-break by overlap with the LARGER name, so "Retail Sales" prefers "Retail Sales" over "Core Retail Sales".
    const score = common / Math.max(want.size, got.size);
    if (!best || score > best.score || (score === best.score && dt < best.dt)) best = { row, score, dt };
  }
  return best?.row;
}

const cache = new Map<string, { at: number; rows: NasdaqRow[] }>();
const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" };

async function day(queryDay: string, fetcher: typeof fetch, now: number): Promise<NasdaqRow[]> {
  const hit = cache.get(queryDay);
  if (hit && now - hit.at < 90_000) return hit.rows;
  const r = await fetcher(`https://api.nasdaq.com/api/calendar/economicevents?date=${queryDay}`, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`nasdaq calendar ${r.status}`);
  const rows = parseNasdaq(await r.json(), queryDay);
  cache.set(queryDay, { at: now, rows });
  if (cache.size > 12) cache.delete(cache.keys().next().value!);
  return rows;
}

/** Fill missing actuals of events released in the last `hours` hours. Never throws; a failure keeps actuals empty. */
export async function fillActualsFromNasdaq(events: CalendarEvent[], currencyOf: (e: CalendarEvent) => string, fetcher: typeof fetch = fetch, now = Date.now(), hours = 6): Promise<CalendarEvent[]> {
  const due = events.filter((e) => !e.actual && Date.parse(e.releaseAt) <= now && now - Date.parse(e.releaseAt) <= hours * 3_600_000 && (e.consensus || e.prior));
  if (!due.length) return events;
  const days = new Set<string>();
  for (const e of due) { const d = new Date(Date.parse(e.releaseAt)).toISOString().slice(0, 10); days.add(d); days.add(shift(d, 1)); }
  const rows: NasdaqRow[] = [];
  for (const d of days) {
    try { rows.push(...await day(d, fetcher, now)); }
    catch (error) { log.warn({ err: error, day: d }, "Nasdaq calendar fetch failed"); }
  }
  if (!rows.length) return events;
  let filled = 0;
  const out = events.map((e) => {
    if (!due.includes(e)) return e;
    const row = matchRow(e, currencyOf(e), rows);
    if (!row?.actual) return e;
    filled++;
    return { ...e, actual: row.actual };
  });
  if (filled) log.info({ filled, due: due.length }, "Calendar actuals filled from Nasdaq");
  return out;
}
export function resetNasdaqCache(): void { cache.clear(); }
