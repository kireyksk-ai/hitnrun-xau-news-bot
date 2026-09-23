import { existsSync, readFileSync } from "node:fs";
import { move, series, stateAt, realisedVol, type Asset, type DataHealth, type MarketState } from "./brain-market.js";
import { atomicWrite, backupOnce, DebouncedSaver } from "./brain-store.js";
import type { Catalyst, Regime, RegimeReading } from "./brain-regime.js";

/**
 * One news item = one episode: what was known, what Sol decided (internally),
 * what the independent critic said, and what the market did afterwards.
 * Internal actions (BUY/SELL/WAIT/NO_TRADE) are the brain's own assessment only;
 * they are never published to the groups.
 */
export type Action = "BUY" | "SELL" | "WAIT" | "NO_TRADE";
export type Direction = "BULLISH" | "BEARISH" | "TWO_WAY" | "UNCLEAR";
export type InternalAssessment = {
  action: Action; direction: Direction; confidence: number; horizonMinutes: 60 | 240 | 1440;
  evidenceFor: string[]; evidenceAgainst: string[]; activation?: string; invalidation?: string;
  mainRisk?: string; nextCatalyst?: string; marketAcceptance?: string; pastDifference?: string; narrative?: string;
};
export type CriticResult = {
  verdict: "PASS" | "DOWNGRADE" | "BLOCK" | "SKIPPED"; reasons: string[]; pricedIn: boolean; preMoved: boolean;
  whipsawRisk: "LOW" | "MEDIUM" | "HIGH"; sourceIssue: boolean; crossMarketConflict: boolean;
  adjustedConfidence?: number; adjustedAction?: Action;
};
export const MARKS = [1, 5, 15, 30, 60, 240, 1440] as const;
export type MarkMinute = (typeof MARKS)[number];
export type EpisodeMark = { at: string; state: MarketState; moves: Partial<Record<Asset, number>>; unavailable?: boolean };
export type Label = {
  label: "CORRECT" | "WRONG" | "LATE" | "RIGHT_DIRECTION_WRONG_TIMING" | "SPIKE_ONLY" | "REVERSED" | "NO_REACTION" | "MISSED_MOVE" | "CORRECT_REJECT" | "UNCALLED_MOVE";
  final: boolean; at: string; horizonMove?: number; threshold: number; peakMove?: number; note: string;
};
export type Episode = {
  id: string; at: string; publishedAt?: string; title: string; fact: string; provider: string; source: string;
  tier: number; credibility: number; storyKey: string; catalyst: Catalyst; changeType: string;
  stage: string; published: boolean; outcomeReason: string; reviewed: boolean;
  session: string; regime?: { primary: Regime; supporting: Regime[]; conflicts: string[]; confidence: number }; narrative?: string;
  market0: MarketState; pre: { m15: Partial<Record<Asset, number>>; m60: Partial<Record<Asset, number>> }; vol60?: number; health?: DataHealth;
  decision?: InternalAssessment; critic?: CriticResult; finalAction: Action; guardrails: string[]; policyVersion: string;
  retrieval?: { episodeIds: string[]; lessonKeys: string[] };
  candidate?: { policyVersion: string; action: Action; direction: Direction; confidence: number };
  marks: Partial<Record<`${MarkMinute}`, EpisodeMark>>;
  label?: Label; lessonKeys?: string[];
};

const LITE_MARKS: MarkMinute[] = [5, 15, 60];
export function marksFor(e: Episode): MarkMinute[] { return e.reviewed ? [...MARKS] : LITE_MARKS; }

export function dueMarks(e: Episode, now: number): MarkMinute[] {
  const t0 = Date.parse(e.at);
  // Wait two minutes past the mark so the 1-minute bar exists.
  return marksFor(e).filter((m) => !e.marks[`${m}`] && now >= t0 + m * 60_000 + 120_000);
}

export async function takeMark(e: Episode, minute: MarkMinute, now: number, fetcher: typeof fetch = fetch): Promise<EpisodeMark | undefined> {
  const t = Date.parse(e.at) + minute * 60_000;
  const state = await stateAt(t, fetcher);
  if (state.XAU === undefined) {
    // Market closed or feed gap: retry for up to 3 days, then record as unavailable.
    if (now - t < 3 * 86400_000) return undefined;
    return { at: new Date(t).toISOString(), state, moves: {}, unavailable: true };
  }
  const moves: Partial<Record<Asset, number>> = {};
  for (const asset of Object.keys(state) as Asset[]) { const m = move(asset, e.market0[asset], state[asset]); if (m !== undefined) moves[asset] = +m.toFixed(4); }
  return { at: new Date(t).toISOString(), state, moves };
}

/** Market context captured at decision time: levels now, the move of the last 15/60 minutes, realised volatility. */
export async function marketContextAt(t0: number, fetcher: typeof fetch = fetch): Promise<Pick<Episode, "market0" | "pre" | "vol60">> {
  const [now, m15, m60, xauBars] = await Promise.all([stateAt(t0, fetcher), stateAt(t0 - 15 * 60_000, fetcher), stateAt(t0 - 60 * 60_000, fetcher), series("XAU", "1m", fetcher)]);
  const diff = (from: MarketState) => {
    const out: Partial<Record<Asset, number>> = {};
    for (const asset of Object.keys(now) as Asset[]) { const m = move(asset, from[asset], now[asset]); if (m !== undefined) out[asset] = +m.toFixed(4); }
    return out;
  };
  const vol = realisedVol(xauBars, t0, 60);
  return { market0: now, pre: { m15: diff(m15), m60: diff(m60) }, vol60: vol === undefined ? undefined : +vol.toFixed(5) };
}

export function credibilityOf(tier: number): number { return tier <= 1 ? 95 : tier === 2 ? 80 : tier === 3 ? 45 : 25; }

export function regimeStamp(r?: RegimeReading): Episode["regime"] {
  return r ? { primary: r.primary, supporting: r.supporting, conflicts: r.conflicts, confidence: r.confidence } : undefined;
}

export class EpisodeLedger {
  private items: Episode[];
  private index = new Map<string, number>();
  private saver: DebouncedSaver;
  constructor(private readonly path: string) {
    backupOnce(path);
    this.items = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Episode[] : [];
    this.reindex();
    this.saver = new DebouncedSaver(() => atomicWrite(this.path, this.items), 10_000);
  }
  private reindex(): void { this.index.clear(); this.items.forEach((e, i) => this.index.set(e.id, i)); }
  all(): Episode[] { return this.items; }
  get(id: string): Episode | undefined { const i = this.index.get(id); return i === undefined ? undefined : this.items[i]; }
  has(id: string): boolean { return this.index.has(id); }
  upsert(e: Episode): void {
    const i = this.index.get(e.id);
    if (i === undefined) { this.items.push(e); this.index.set(e.id, this.items.length - 1); this.prune(); }
    else this.items[i] = e;
    this.saver.schedule();
  }
  /** Reviewed episodes are kept 180 days; lite (pre-filter) episodes 10 days unless they revealed a missed move. */
  private prune(): void {
    if (this.items.length % 200 !== 0) return;
    const now = Date.now();
    this.items = this.items.filter((e) => {
      const age = now - Date.parse(e.at);
      if (e.reviewed || e.label?.label === "MISSED_MOVE") return age < 180 * 86400_000;
      return age < 10 * 86400_000;
    }).slice(-25000);
    this.reindex();
  }
  pendingMarks(now: number): Episode[] { return this.items.filter((e) => dueMarks(e, now).length > 0); }
  flush(): void { this.saver.flush(); }
}
