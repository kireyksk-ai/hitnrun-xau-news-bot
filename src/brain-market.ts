import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

/**
 * Point-in-time market reader for the Market Brain. Every number is read from a
 * timestamped Yahoo series *after the fact*, so a mark due at t+5m can be taken
 * accurately even if the worker restarted in between (1-minute data covers ~5 days).
 */
export const BRAIN_ASSETS = {
  XAU: ["GC=F"], DXY: ["DX-Y.NYB"], US2Y: ["2YY=F", "^UST2Y"], US10Y: ["^TNX"], WTI: ["CL=F"], VIX: ["^VIX"], SPX: ["^GSPC"],
  // Macro-only (daily/hourly): 30-year yield and 30-day fed funds futures (implied rate = 100 - price).
  US30Y: ["^TYX"], FEDFUNDS: ["ZQ=F"]
} as const;
export type Asset = keyof typeof BRAIN_ASSETS;
/** Assets read every minute for episodes and marks. */
export const ASSETS: Asset[] = ["XAU", "DXY", "US2Y", "US10Y", "WTI", "VIX", "SPX"];
export type Bar = [number, number]; // [epoch ms, close]
export type MarketState = Partial<Record<Asset, number>>;
export type DataHealth = { ok: boolean; fresh: Asset[]; stale: Asset[]; missing: Asset[]; note: string };

type Fetcher = typeof fetch;
const cache = new Map<string, { at: number; bars: Bar[] }>();
const workingSymbol = new Map<Asset, string>();

async function yahoo(symbol: string, interval: string, range: string, fetcher: Fetcher): Promise<Bar[]> {
  const response = await fetcher(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`, {
    headers: { Accept: "application/json", "User-Agent": "HitnRunFX/1.0" }, signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Yahoo ${symbol} ${response.status}`);
  const body = await response.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } };
  const result = body.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  return (result?.timestamp ?? []).map((t, i) => [t * 1000, closes[i]] as [number, number | null | undefined])
    .filter((p): p is Bar => typeof p[1] === "number" && p[1] > 0);
}

/** Bars for an asset; tries fallback symbols once and remembers the one that works. */
export async function series(asset: Asset, interval: "1m" | "5m" | "60m" | "1d", fetcher: Fetcher = fetch): Promise<Bar[]> {
  const range = interval === "1m" ? "5d" : interval === "5m" ? "1mo" : interval === "60m" ? "3mo" : "1y";
  const ttl = interval === "1m" ? 55_000 : interval === "5m" ? 240_000 : interval === "60m" ? 900_000 : 3600_000;
  const symbols = workingSymbol.has(asset) ? [workingSymbol.get(asset)!] : [...BRAIN_ASSETS[asset]];
  for (const symbol of symbols) {
    const key = `${symbol}|${interval}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.bars;
    try {
      const bars = await yahoo(symbol, interval, range, fetcher);
      if (bars.length) { cache.set(key, { at: Date.now(), bars }); workingSymbol.set(asset, symbol); return bars; }
    } catch (error) { log.debug({ err: error, symbol }, "Brain series fetch failed"); }
  }
  return [];
}

/** Last close at or before `ts`, only if that bar is within `toleranceMs` of `ts`. */
export function valueAt(bars: Bar[], ts: number, toleranceMs = 20 * 60_000): number | undefined {
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid][0] <= ts) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  if (found < 0) return undefined;
  return ts - bars[found][0] <= toleranceMs ? bars[found][1] : undefined;
}

/** Market state of all brain assets at a past or present moment. */
export async function stateAt(ts: number, fetcher: Fetcher = fetch): Promise<MarketState> {
  const age = Date.now() - ts;
  const interval = age < 4.5 * 86400_000 ? "1m" : "5m";
  const out: MarketState = {};
  await Promise.all(ASSETS.map(async (asset) => {
    const bars = await series(asset, interval, fetcher);
    // Yields and indices trade on fewer hours; allow a wider tolerance for them.
    const tolerance = asset === "XAU" ? 20 * 60_000 : 90 * 60_000;
    const value = valueAt(bars, ts, tolerance);
    if (value !== undefined) out[asset] = value;
  }));
  return out;
}

export async function dataHealth(now = Date.now(), fetcher: Fetcher = fetch): Promise<DataHealth> {
  const fresh: Asset[] = [], stale: Asset[] = [], missing: Asset[] = [];
  await Promise.all(ASSETS.map(async (asset) => {
    const bars = await series(asset, "1m", fetcher);
    if (!bars.length) { missing.push(asset); return; }
    (now - bars[bars.length - 1][0] <= 30 * 60_000 ? fresh : stale).push(asset);
  }));
  const ok = fresh.includes("XAU") && fresh.length >= 3;
  return { ok, fresh, stale, missing, note: ok ? "OK" : !fresh.includes("XAU") ? "XAU data not fresh (market closed or feed down)" : "fewer than 3 fresh assets" };
}

/** Percent change (yields: basis points) between two values of an asset. */
export function move(asset: Asset, from?: number, to?: number): number | undefined {
  if (from === undefined || to === undefined || !(from > 0)) return undefined;
  if (asset === "FEDFUNDS") return -(to - from) * 100; // futures price down = implied rate up (bp)
  return asset === "US2Y" || asset === "US10Y" || asset === "US30Y" ? (to - from) * 100 : (to - from) / from * 100;
}
export const unit = (asset: Asset) => asset === "US2Y" || asset === "US10Y" || asset === "US30Y" || asset === "FEDFUNDS" ? "bp" : "%";

/** Realised XAU volatility: std of 1-minute % returns over the last `minutes`. */
export function realisedVol(bars: Bar[], endTs: number, minutes = 60): number | undefined {
  const window = bars.filter(([t]) => t <= endTs && t > endTs - minutes * 60_000);
  if (window.length < 10) return undefined;
  const rets: number[] = [];
  for (let i = 1; i < window.length; i++) rets.push((window[i][1] - window[i - 1][1]) / window[i - 1][1] * 100);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
}

/** Pearson correlation of bar-to-bar changes of two aligned series. */
export function correlation(a: Bar[], b: Bar[], sinceTs: number, bucketMs = 3600_000, minPairs = 12): { r: number; n: number } | undefined {
  // Daily bars of different markets open at different hours: bucket by calendar day (floor); hourly by nearest hour.
  const key = (t: number) => bucketMs >= 86400_000 ? Math.floor(t / bucketMs) : Math.round(t / bucketMs);
  const bMap = new Map(b.map(([t, v]) => [key(t), v]));
  const pairs: Array<[number, number]> = [];
  let prev: [number, number] | undefined;
  for (const [t, v] of a) {
    if (t < sinceTs) continue;
    const w = bMap.get(key(t));
    if (w === undefined) { prev = undefined; continue; }
    if (prev) pairs.push([(v - prev[0]) / prev[0], (w - prev[1]) / prev[1]]);
    prev = [v, w];
  }
  if (pairs.length < minPairs) return undefined;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length, my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx && syy ? { r: sxy / Math.sqrt(sxx * syy), n: pairs.length } : undefined;
}

/** Test hook. */
export function clearBrainMarketCache(): void { cache.clear(); workingSymbol.clear(); }
