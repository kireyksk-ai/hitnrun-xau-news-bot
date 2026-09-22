import { createHash } from "node:crypto";
import type { IntelligenceStore } from "./intelligence-store.js";
import { sessionAt, type MarketPoint, type ShadowDecision } from "./persistent-market-brain.js";

const universe = [
  ["XAUUSD", "GC=F"], ["DXY", "DX-Y.NYB"], ["EURUSD", "EURUSD=X"], ["GBPJPY", "GBPJPY=X"],
  ["WTI", "CL=F"], ["BRENT", "BZ=F"], ["US2Y", "^UST2Y"], ["US10Y", "^TNX"], ["US20Y", "^UST20Y"], ["US30Y", "^TYX"]
] as const;

async function one(label: string, symbol: string): Promise<[string, { price: number; changePercent: number; fresh: boolean }] | null> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`, { signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json", "User-Agent": "HitnRunFX/1.0" } });
    const meta = (await r.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number; regularMarketTime?: number } }> } }).chart?.result?.[0]?.meta;
    if (!r.ok || !meta?.regularMarketPrice || !meta.chartPreviousClose) return null;
    const fresh = !meta.regularMarketTime || Date.now() - meta.regularMarketTime * 1_000 < 20 * 60_000;
    return [label, { price: meta.regularMarketPrice, changePercent: (meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100, fresh }];
  } catch { return null; }
}

/** Deterministic, silent Phase-4 observer. It creates no Telegram message. */
export async function observeMarket(store: IntelligenceStore): Promise<{ point: MarketPoint; decision: ShadowDecision }> {
  const results = await Promise.all(universe.map(([label, symbol]) => one(label, symbol)));
  const values = Object.fromEntries(results.filter((x): x is NonNullable<typeof x> => x !== null));
  const now = new Date(); const point: MarketPoint = { capturedAt: now.toISOString(), values, session: sessionAt(now) };
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
