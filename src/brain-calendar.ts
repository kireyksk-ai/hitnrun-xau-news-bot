import { existsSync, readFileSync } from "node:fs";
import type { CalendarEvent } from "./economic-calendar.js";
import { move, stateAt } from "./brain-market.js";
import { atomicWrite, backupOnce } from "./brain-store.js";
import type { Linkage } from "./brain-macro.js";
import { matchPlaybook } from "./brain-events.js";

/**
 * Economic-event history: every high/medium release with actual vs consensus,
 * surprise and surprise z-score (against that event's own past surprises), and
 * the measured gold/dollar/yield reaction 5, 15 and 60 minutes after the print,
 * stamped with the linkage regime. This is what lets the bot say "last times CPI
 * beat, gold fell X in 5 minutes" instead of guessing.
 */
export type EventFamily = "INFLATION" | "LABOR" | "UNEMPLOYMENT" | "GROWTH" | "FED" | "OTHER";
export type EventRecord = {
  id: string; name: string; country: string; family: EventFamily; releaseAt: string; impact: string;
  consensus: number | null; prior: number | null; actual: number | null; surprise: number | null; surpriseZ: number | null;
  linkage: Linkage; expectedBias: "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";
  code?: string; magnitude?: "BESAR" | "NORMAL" | "KECIL";
  xauPre?: number; xau5?: number; xau15?: number; xau60?: number; dxy5?: number; us10y5bp?: number; resolved: boolean;
};

export function parseNum(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = v.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
export function familyOf(name: string): EventFamily {
  const n = name.toLowerCase();
  if (/unemployment rate/.test(n)) return "UNEMPLOYMENT";
  if (/\b(cpi|pce|ppi|inflation|price index)\b/.test(n)) return "INFLATION";
  if (/payroll|nonfarm|jobless|claims|employment change|adp|jolts/.test(n)) return "LABOR";
  if (/fomc|fed funds|interest rate decision|rate decision/.test(n)) return "FED";
  if (/gdp|pmi|ism|retail|durable|sentiment|confidence|housing|home sales|industrial|factory/.test(n)) return "GROWTH";
  return "OTHER";
}
/** Hawkish surprise = hotter inflation/labour/growth, lower unemployment. Its gold sign depends on the linkage regime. */
export function expectedBias(family: EventFamily, surprise: number | null, linkage: Linkage, name = ""): EventRecord["expectedBias"] {
  if (surprise === null || surprise === 0) return "UNKNOWN";
  // Owner playbook first: its bias is for the metric coming in ABOVE consensus; a miss flips it.
  const p = name ? matchPlaybook(name, 1)[0] : undefined;
  if (p) {
    const b = p.bias[linkage];
    if (b === "BULLISH" || b === "BEARISH") return surprise > 0 ? b : b === "BULLISH" ? "BEARISH" : "BULLISH";
    if (b === "NEUTRAL") return "MIXED";
    return "UNKNOWN";
  }
  if (family === "OTHER" || family === "FED") return "UNKNOWN";
  // Jobless claims: higher = weaker labour (dovish).
  const claims = /claims/i.test(name);
  const hawkish = family === "UNEMPLOYMENT" || claims ? surprise < 0 : surprise > 0;
  // In the central-bank/debasement regime a hawkish print does not reliably push gold down.
  if (linkage === "CB") return "MIXED";
  return hawkish ? "BEARISH" : "BULLISH";
}

/** Owner rule for payrolls: surprise >50K = big reaction, <20K = small; other events use z-score later. */
export function magnitudeOf(name: string, surprise: number | null): EventRecord["magnitude"] {
  if (surprise === null) return undefined;
  if (/non-?farm|payrolls?/i.test(name)) return Math.abs(surprise) > 50 ? "BESAR" : Math.abs(surprise) < 20 ? "KECIL" : "NORMAL";
  return undefined;
}

export function surpriseZ(history: EventRecord[], name: string, surprise: number | null): number | null {
  if (surprise === null) return null;
  const past = history.filter((r) => r.name === name && r.surprise !== null).map((r) => r.surprise!);
  if (past.length < 5) return null;
  const mean = past.reduce((a, b) => a + b, 0) / past.length;
  const std = Math.sqrt(past.reduce((a, b) => a + (b - mean) ** 2, 0) / past.length);
  return std ? +((surprise - 0) / std).toFixed(2) : null;
}

export function reactionStats(history: EventRecord[], name: string, family: EventFamily): { beat: { n: number; avg5: number | null }; miss: { n: number; avg5: number | null }; scope: string } {
  let pool = history.filter((r) => r.resolved && r.name === name && r.surprise !== null && r.xau5 !== undefined);
  let scope = name;
  if (pool.length < 3) { pool = history.filter((r) => r.resolved && r.family === family && r.surprise !== null && r.xau5 !== undefined); scope = `keluarga ${family}`; }
  const avg = (xs: number[]) => xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null;
  const beat = pool.filter((r) => r.surprise! > 0).map((r) => r.xau5!), miss = pool.filter((r) => r.surprise! < 0).map((r) => r.xau5!);
  return { beat: { n: beat.length, avg5: avg(beat) }, miss: { n: miss.length, avg5: avg(miss) }, scope };
}

export function historyLine(history: EventRecord[], e: Pick<CalendarEvent, "name">): string {
  const s = reactionStats(history, e.name, familyOf(e.name));
  if (!s.beat.n && !s.miss.n) return "";
  const f = (x: { n: number; avg5: number | null }) => x.n ? `XAU 5m rata-rata ${x.avg5! >= 0 ? "+" : ""}${x.avg5}% (n=${x.n})` : "belum ada data";
  return `historis ${s.scope}: di atas perkiraan → ${f(s.beat)}; di bawah → ${f(s.miss)}`;
}

export class CalendarHistory {
  private items: EventRecord[];
  constructor(private readonly path: string) { backupOnce(path); this.items = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : []; }
  all(): EventRecord[] { return this.items; }
  private save(): void { atomicWrite(this.path, this.items.slice(-5000)); }
  /** Records newly printed high/medium events (last 4 days). */
  observe(events: CalendarEvent[], linkage: Linkage, now = Date.now()): EventRecord[] {
    const added: EventRecord[] = [];
    for (const e of events) {
      if (!e.actual || (e.impact !== "high" && e.impact !== "medium")) continue;
      const t = Date.parse(e.releaseAt);
      if (!(t <= now && now - t < 4 * 86400_000) || this.items.some((r) => r.id === e.id)) continue;
      const consensus = parseNum(e.consensus), actual = parseNum(e.actual), prior = parseNum(e.prior);
      const surprise = actual !== null && consensus !== null ? +(actual - consensus).toFixed(4) : null;
      const family = familyOf(e.name);
      const rec: EventRecord = { id: e.id, name: e.name, country: e.country, family, releaseAt: e.releaseAt, impact: e.impact, consensus, prior, actual, surprise,
        surpriseZ: surpriseZ(this.items, e.name, surprise), linkage, expectedBias: expectedBias(family, surprise, linkage, e.name), resolved: false,
        code: matchPlaybook(e.name, 1)[0]?.code, magnitude: magnitudeOf(e.name, surprise) };
      this.items.push(rec); added.push(rec);
    }
    if (added.length) this.save();
    return added;
  }
  /** Fills the measured reaction once 60 minutes have passed. */
  async resolve(now = Date.now(), fetcher: typeof fetch = fetch): Promise<EventRecord[]> {
    const done: EventRecord[] = [];
    for (const r of this.items) {
      if (r.resolved) continue;
      const t = Date.parse(r.releaseAt);
      if (now < t + 62 * 60_000) continue;
      const [pre, p5, p15, p60] = await Promise.all([stateAt(t - 5 * 60_000, fetcher), stateAt(t + 5 * 60_000, fetcher), stateAt(t + 15 * 60_000, fetcher), stateAt(t + 60 * 60_000, fetcher)]);
      if (pre.XAU === undefined && now - t < 3 * 86400_000) continue;
      Object.assign(r, { xauPre: pre.XAU, xau5: move("XAU", pre.XAU, p5.XAU), xau15: move("XAU", pre.XAU, p15.XAU), xau60: move("XAU", pre.XAU, p60.XAU),
        dxy5: move("DXY", pre.DXY, p5.DXY), us10y5bp: move("US10Y", pre.US10Y, p5.US10Y), resolved: true });
      done.push(r);
    }
    if (done.length) this.save();
    return done;
  }
}
