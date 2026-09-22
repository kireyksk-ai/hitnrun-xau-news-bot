import { createHash } from "node:crypto";
import type { IntelligenceStore } from "./intelligence-store.js";
import { anatomy, type Candle } from "./market-tape.js";
import { sessionAt, type DataQuality, type MarketPoint, type ShadowDecision } from "./persistent-market-brain.js";

const universe = [
  ["XAUUSD", "GC=F"], ["DXY", "DX-Y.NYB"], ["EURUSD", "EURUSD=X"], ["USDJPY", "JPY=X"], ["GBPUSD", "GBPUSD=X"], ["GBPJPY", "GBPJPY=X"],
  ["WTI", "CL=F"], ["BRENT", "BZ=F"], ["US2Y", "^UST2Y"], ["US5Y", "^FVX"], ["US10Y", "^TNX"], ["US20Y", "^UST20Y"], ["US30Y", "^TYX"], ["VIX", "^VIX"]
] as const;

type YahooChart = { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number; regularMarketTime?: number }; timestamp?: number[]; indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null> }> } }> } };
type Observation = { price: number; changePercent: number; fresh: boolean; source: string; observedAt?: string; quality: DataQuality; candle?: Candle };

async function one(label: string, symbol: string): Promise<[string, Observation] | null> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`, { signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json", "User-Agent": "HitnRunFX/1.0" } });
    const result = (await r.json() as YahooChart).chart?.result?.[0]; const meta = result?.meta;
    if (!r.ok || !meta?.regularMarketPrice || !meta.chartPreviousClose) return null;
    const fresh = !meta.regularMarketTime || Date.now() - meta.regularMarketTime * 1_000 < 20 * 60_000;
    const i = (result?.timestamp?.length ?? 0) - 1, quote = result?.indicators?.quote?.[0];
    const open = quote?.open?.[i], high = quote?.high?.[i], low = quote?.low?.[i], close = quote?.close?.[i];
    const observedAt = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1_000).toISOString() : undefined;
    const candle: Candle | undefined = typeof open === "number" && typeof high === "number" && typeof low === "number" && typeof close === "number"
      ? { open, high, low, close, capturedAt: observedAt ?? new Date().toISOString(), session: sessionAt(new Date()), quality: fresh ? "FRESH" : "STALE" } : undefined;
    return [label, { price: meta.regularMarketPrice, changePercent: (meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100, fresh, source: "Yahoo Finance chart API", observedAt, quality: fresh ? "FRESH" : "STALE", candle }];
  } catch { return null; }
}

/** Deterministic, silent Phase-4 observer. It creates no Telegram message. */
export async function observeMarket(store: IntelligenceStore): Promise<{ point: MarketPoint; decision: ShadowDecision }> {
  const results = await Promise.all(universe.map(([label, symbol]) => one(label, symbol)));
  const completed = results.filter((x): x is NonNullable<typeof x> => x !== null);
  const values = Object.fromEntries(completed.map(([label, observation]) => [label, { price: observation.price, changePercent: observation.changePercent, fresh: observation.fresh, source: observation.source, observedAt: observation.observedAt, quality: observation.quality }]));
  const unavailableAssets = universe.map(([label]) => label).filter((label) => !(label in values));
  const now = new Date(); const xauCandle = completed.find(([label]) => label === "XAUUSD")?.[1].candle;
  const quality: DataQuality = !completed.length ? "DATA_UNAVAILABLE" : Object.values(values).some((value) => value.quality === "FRESH") ? "FRESH" : "STALE";
  const point: MarketPoint = { capturedAt: now.toISOString(), values, session: sessionAt(now), unavailableAssets,
    candles: xauCandle ? { "5m": anatomy(xauCandle) } : undefined,
    coverage: { available: completed.length, requested: universe.length, quality } };
  store.recordMarketSnapshot(point);
  const xau = values.XAUUSD, dxy = values.DXY, y10 = values.US10Y, wti = values.WTI;
  const previous = store.marketBrain().snapshots.at(-2);
  let kind: ShadowDecision["kind"] = "CONSISTENT";
  let attribution: ShadowDecision["attribution"] = "INSUFFICIENT_EVIDENCE";
  const facts: string[] = [];
  const channels: string[] = [];
  if (!xau || !xau.fresh) { kind = "UNEXPLAINED_MOVE"; attribution = "DRIVER_UNKNOWN"; facts.push("DATA_STALE or DATA_UNAVAILABLE for XAUUSD"); }
  else if (Math.abs(xau.changePercent) >= 1 && (!dxy || !y10)) { kind = "UNEXPLAINED_MOVE"; attribution = "INSUFFICIENT_EVIDENCE"; facts.push("abnormal XAU move without sufficient cross-asset evidence"); }
  else if (xau && dxy && y10 && xau.changePercent > 0.35 && dxy.changePercent > 0.2 && y10.changePercent > 0.2) { kind = "CROSS_ASSET_DIVERGENCE"; attribution = "MULTIPLE_COMPETING_DRIVERS"; facts.push("XAU rose while DXY and US10Y also rose"); channels.push("YIELDS", "DXY", "SAFE_HAVEN_OR_STRUCTURAL_DEMAND"); }
  else if (previous && Object.keys(values).length < 4) { kind = "UNEXPLAINED_MOVE"; attribution = "INSUFFICIENT_EVIDENCE"; facts.push("market universe coverage insufficient"); }
  else { facts.push("routine market behavior; no material divergence"); attribution = "INSUFFICIENT_EVIDENCE"; }
  if (wti) channels.push("OIL");
  const decision: ShadowDecision = { timestamp: now.toISOString(), kind, attribution, facts, channels, confidence: kind === "CONSISTENT" ? 80 : 45 };
  store.recordShadow(decision);
  if (kind !== "CONSISTENT") store.recordExperience({ id: createHash("sha256").update(`${now.toISOString()}|${kind}`).digest("hex").slice(0, 16), createdAt: now.toISOString(), regime: store.regime, trigger: kind, attribution, confidence: decision.confidence });
  return { point, decision };
}
