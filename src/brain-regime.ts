import { existsSync, readFileSync } from "node:fs";
import { correlation, move, series, type Asset, type Bar } from "./brain-market.js";
import { atomicWrite, backupOnce } from "./brain-store.js";

/**
 * Market Regime Engine. Deterministic and explainable: every score is built from
 * cross-asset behaviour (moves and rolling correlations of hourly bars) plus the
 * mix of catalysts the bot has recently seen. It names the main driver, the
 * supporting drivers, the conflicts between them, and when the narrative shifts.
 */
export const REGIMES = ["INFLATION", "RATES_FED", "YIELDS", "DOLLAR", "RECESSION", "GEOPOLITICS", "RISK_ON", "RISK_OFF",
  "LIQUIDITY", "POSITIONING", "TECHNICAL_FLOW", "ANOMALY"] as const;
export type Regime = (typeof REGIMES)[number];
export type Catalyst = "INFLATION" | "LABOR" | "GROWTH" | "FED" | "YIELDS" | "DOLLAR" | "ENERGY" | "GEOPOLITICS" | "TRADE" | "GOLD_FLOWS" | "OTHER";

export function catalystOf(storyKey: string, text = ""): Catalyst {
  const t = text.toLowerCase();
  if (/central bank.*gold|gold (?:reserve|etf|import|demand)|comex|shanghai gold|pboc.*gold/.test(t)) return "GOLD_FLOWS";
  if (/^us-macro-(cpi|pce)/.test(storyKey) || /\b(cpi|pce|ppi|inflation)\b/.test(t) && !/^iran/.test(storyKey)) return "INFLATION";
  if (/^us-macro-(nfp|payroll|jobless-claims)/.test(storyKey)) return "LABOR";
  if (/^us-macro-/.test(storyKey)) return "GROWTH";
  if (storyKey === "fed-policy") return "FED";
  if (storyKey === "treasury-yields") return "YIELDS";
  if (storyKey === "fx-usd") return "DOLLAR";
  if (storyKey === "oil-supply") return "ENERGY";
  if (storyKey.startsWith("iran-gulf-conflict")) return "GEOPOLITICS";
  if (storyKey === "trade-sanctions") return "TRADE";
  return "OTHER";
}

/** What a regime usually implies for gold when its driver is moving the way it is. */
export type RegimeScore = { regime: Regime; score: number; goldBias: "BULLISH" | "BEARISH" | "MIXED"; evidence: string[] };
export type RegimeReading = {
  at: string; primary: Regime; supporting: Regime[]; conflicts: string[]; scores: RegimeScore[];
  dominantNarrative: string; confidence: number; dataQuality: "OK" | "PARTIAL" | "INSUFFICIENT";
};
export type RegimeInput = {
  now: number;
  bars: Partial<Record<Asset, Bar[]>>;
  catalystCounts: Partial<Record<Catalyst, number>>; // recent material catalysts (e.g. 48h)
};

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
function change(bars: Bar[] | undefined, asset: Asset, hours: number, now: number): number | undefined {
  if (!bars?.length) return undefined;
  const last = bars[bars.length - 1];
  const start = [...bars].reverse().find(([t]) => t <= now - hours * 3600_000);
  return start ? move(asset, start[1], last[1]) : undefined;
}

export function evaluateRegime(input: RegimeInput): RegimeReading {
  const { bars, now } = input;
  const c = (a: Asset, h: number) => change(bars[a], a, h, now);
  const xau1 = c("XAU", 24), xau5 = c("XAU", 120), dxy1 = c("DXY", 24), dxy5 = c("DXY", 120);
  const y10_5 = c("US10Y", 120), y2_5 = c("US2Y", 120), y10_1 = c("US10Y", 24), wti5 = c("WTI", 120), vix1 = c("VIX", 24), spx1 = c("SPX", 24), spx5 = c("SPX", 120);
  const since = now - 7 * 86400_000;
  const corr = (a: Asset, b: Asset) => bars[a] && bars[b] ? correlation(bars[a]!, bars[b]!, since) : undefined;
  const cDxy = corr("XAU", "DXY"), cY10 = corr("XAU", "US10Y"), cSpx = corr("XAU", "SPX");
  const cat = input.catalystCounts; const total = Math.max(1, Object.values(cat).reduce((a, b) => a + (b ?? 0), 0));
  const share = (...k: Catalyst[]) => k.reduce((s, x) => s + (cat[x] ?? 0), 0) / total;
  const f = (v: number | undefined, d = 2) => v === undefined ? "n/a" : v.toFixed(d);
  const available = [xau5, dxy5, y10_5, wti5, spx5].filter((v) => v !== undefined).length;
  const scores: RegimeScore[] = [];
  const push = (regime: Regime, score: number, goldBias: RegimeScore["goldBias"], evidence: string[]) => scores.push({ regime, score: clamp(score), goldBias, evidence });

  // DOLLAR: gold trading as the inverse of a trending dollar.
  push("DOLLAR", (cDxy && cDxy.r < 0 ? -cDxy.r * 60 : 0) + Math.min(40, Math.abs(dxy5 ?? 0) * 25) + share("DOLLAR") * 30,
    (dxy5 ?? 0) > 0 ? "BEARISH" : "BULLISH", [`corr XAU-DXY 7d ${f(cDxy?.r)}`, `DXY 5d ${f(dxy5)}%`]);
  // YIELDS: gold trading against the 10-year.
  push("YIELDS", (cY10 && cY10.r < 0 ? -cY10.r * 60 : 0) + Math.min(40, Math.abs(y10_5 ?? 0) / 25 * 40) + share("YIELDS") * 30,
    (y10_5 ?? 0) > 0 ? "BEARISH" : "BULLISH", [`corr XAU-US10Y 7d ${f(cY10?.r)}`, `US10Y 5d ${f(y10_5, 1)}bp`]);
  // RATES_FED: the front end leads (2Y moving more than 10Y) and Fed headlines dominate.
  const frontLed = y2_5 !== undefined && y10_5 !== undefined ? Math.abs(y2_5) - Math.abs(y10_5) : 0;
  push("RATES_FED", Math.min(40, Math.max(0, frontLed) * 3) + Math.min(25, Math.abs(y2_5 ?? 0) / 20 * 25) + share("FED", "LABOR") * 60,
    (y2_5 ?? 0) > 0 ? "BEARISH" : "BULLISH", [`US2Y 5d ${f(y2_5, 1)}bp vs US10Y ${f(y10_5, 1)}bp`, `Fed/labor share ${(share("FED", "LABOR") * 100).toFixed(0)}%`]);
  // INFLATION: inflation prints dominate and oil/yields rise together.
  push("INFLATION", share("INFLATION") * 70 + ((wti5 ?? 0) > 3 && (y10_5 ?? 0) > 5 ? 30 : 0),
    "MIXED", [`inflation share ${(share("INFLATION") * 100).toFixed(0)}%`, `WTI 5d ${f(wti5)}%`]);
  // GEOPOLITICS: conflict headlines and gold bid alongside the dollar or oil.
  push("GEOPOLITICS", share("GEOPOLITICS", "ENERGY") * 65 + ((xau5 ?? 0) > 0.5 && (dxy5 ?? 0) > 0 ? 20 : 0) + (Math.abs(wti5 ?? 0) > 5 ? 15 : 0),
    (xau5 ?? 0) >= 0 ? "BULLISH" : "BEARISH", [`geo/energy share ${(share("GEOPOLITICS", "ENERGY") * 100).toFixed(0)}%`, `WTI 5d ${f(wti5)}%`]);
  // RISK_OFF / RISK_ON from equities and volatility.
  push("RISK_OFF", ((vix1 ?? 0) > 10 ? 40 : (vix1 ?? 0) > 5 ? 20 : 0) + ((spx1 ?? 0) < -1 ? 35 : (spx1 ?? 0) < -0.5 ? 15 : 0) + ((xau1 ?? 0) > 0 ? 15 : 0),
    "BULLISH", [`VIX 1d ${f(vix1)}%`, `SPX 1d ${f(spx1)}%`]);
  push("RISK_ON", ((vix1 ?? 0) < -5 ? 35 : 0) + ((spx5 ?? 0) > 1.5 ? 35 : (spx5 ?? 0) > 0.7 ? 15 : 0) + ((xau5 ?? 0) < 0 ? 15 : 0),
    "BEARISH", [`VIX 1d ${f(vix1)}%`, `SPX 5d ${f(spx5)}%`]);
  // RECESSION: yields and oil falling with equities, growth data in focus.
  push("RECESSION", ((y10_5 ?? 0) < -15 ? 30 : 0) + ((wti5 ?? 0) < -4 ? 20 : 0) + ((spx5 ?? 0) < -2 ? 25 : 0) + share("GROWTH", "LABOR") * 30,
    "BULLISH", [`US10Y 5d ${f(y10_5, 1)}bp`, `SPX 5d ${f(spx5)}%`]);
  // LIQUIDITY: everything sold together, gold included (dash for cash).
  push("LIQUIDITY", ((xau1 ?? 0) < -1 && (spx1 ?? 0) < -1 && (vix1 ?? 0) > 10 ? 80 : 0) + (cSpx && cSpx.r > 0.5 && (spx5 ?? 0) < -2 ? 20 : 0),
    "BEARISH", [`XAU 1d ${f(xau1)}%`, `SPX 1d ${f(spx1)}%`, `corr XAU-SPX ${f(cSpx?.r)}`]);
  // ANOMALY: gold up with dollar AND yields up strongly (breaks the usual chains).
  push("ANOMALY", (xau5 ?? 0) > 1 && (dxy5 ?? 0) > 0.5 && (y10_5 ?? 0) > 10 ? 70 : (cDxy && cDxy.r > 0.3 ? 40 : 0),
    "MIXED", [`XAU 5d ${f(xau5)}% with DXY ${f(dxy5)}% and US10Y ${f(y10_5, 1)}bp`]);
  // TECHNICAL_FLOW / POSITIONING: large gold move that the macro links do not explain.
  const explained = Math.max(...scores.filter((s) => ["DOLLAR", "YIELDS", "RATES_FED", "GEOPOLITICS", "RISK_OFF", "RISK_ON"].includes(s.regime)).map((s) => s.score), 0);
  const bigMove = Math.abs(xau5 ?? 0) > 2 || Math.abs(xau1 ?? 0) > 1.2;
  push("TECHNICAL_FLOW", bigMove && explained < 45 ? 65 : bigMove ? 25 : 10, (xau1 ?? 0) >= 0 ? "BULLISH" : "BEARISH", [`XAU 1d ${f(xau1)}%, macro explanation score ${explained}`]);
  push("POSITIONING", Math.abs(xau5 ?? 0) > 3 && explained < 50 ? 55 : 5, (xau5 ?? 0) >= 0 ? "BEARISH" : "BULLISH", [`XAU 5d ${f(xau5)}% (stretched move, mean-reversion risk)`]);

  scores.sort((a, b) => b.score - a.score);
  const primary = scores[0];
  // Opposite ends of one axis cannot both support: keep only the stronger of RISK_ON / RISK_OFF.
  const riskLoser = (scores.find((s) => s.regime === "RISK_ON")?.score ?? 0) >= (scores.find((s) => s.regime === "RISK_OFF")?.score ?? 0) ? "RISK_OFF" : "RISK_ON";
  const supporting = scores.slice(1).filter((s) => s.regime !== riskLoser && s.score >= Math.max(30, primary.score * 0.6)).map((s) => s.regime);
  const active = [primary, ...scores.filter((s) => supporting.includes(s.regime))];
  const conflicts: string[] = [];
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const a = active[i], b = active[j];
    if ((a.goldBias === "BULLISH" && b.goldBias === "BEARISH") || (a.goldBias === "BEARISH" && b.goldBias === "BULLISH"))
      conflicts.push(`${a.regime} (${a.goldBias.toLowerCase()} emas) vs ${b.regime} (${b.goldBias.toLowerCase()} emas)`);
  }
  const confidence = clamp(primary.score - (scores[1]?.score ?? 0) + 40);
  const dataQuality = available >= 4 ? "OK" : available >= 2 ? "PARTIAL" : "INSUFFICIENT";
  const dominantNarrative = `${primary.regime}${supporting.length ? ` + ${supporting.join(", ")}` : ""}: ${primary.evidence.join("; ")}`;
  return { at: new Date(now).toISOString(), primary: dataQuality === "INSUFFICIENT" ? "ANOMALY" : primary.regime, supporting, conflicts,
    scores, dominantNarrative, confidence: dataQuality === "INSUFFICIENT" ? 20 : confidence, dataQuality };
}

export type RegimeShift = { at: string; from: Regime; to: Regime; confirmedAfterReadings: number };
/** A shift is confirmed only when the new primary holds for `persistence` consecutive readings. */
export function detectShift(history: RegimeReading[], persistence = 2): RegimeShift | undefined {
  if (history.length < persistence + 1) return undefined;
  const tail = history.slice(-persistence);
  const candidate = tail[0].primary;
  if (!tail.every((r) => r.primary === candidate)) return undefined;
  const before = history[history.length - persistence - 1];
  if (before.primary === candidate) return undefined;
  return { at: tail[0].at, from: before.primary, to: candidate, confirmedAfterReadings: persistence };
}

export function regimeBrief(reading: RegimeReading | undefined): string {
  if (!reading) return "REGIME: belum ada pembacaan.";
  return `REGIME (${reading.at.slice(0, 16)}Z, keyakinan ${reading.confidence}, data ${reading.dataQuality}): utama ${reading.primary}` +
    `${reading.supporting.length ? `, pendukung ${reading.supporting.join(", ")}` : ""}` +
    `${reading.conflicts.length ? `, konflik: ${reading.conflicts.join("; ")}` : ""}. Narasi dominan: ${reading.dominantNarrative}`;
}

export class RegimeLedger {
  private data: { history: RegimeReading[]; shifts: RegimeShift[] };
  constructor(private readonly path: string) {
    backupOnce(path);
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { history: [], shifts: [] };
  }
  current(): RegimeReading | undefined { return this.data.history.at(-1); }
  history(): RegimeReading[] { return this.data.history; }
  shifts(): RegimeShift[] { return this.data.shifts; }
  /** Stores the reading; returns a confirmed shift if this reading completes one. */
  add(reading: RegimeReading): RegimeShift | undefined {
    this.data.history.push(reading);
    if (this.data.history.length > 3000) this.data.history = this.data.history.slice(-3000);
    const shift = detectShift(this.data.history);
    if (shift && this.data.shifts.at(-1)?.at !== shift.at) this.data.shifts.push(shift); else if (shift) { atomicWrite(this.path, this.data); return undefined; }
    atomicWrite(this.path, this.data);
    return shift;
  }
  /** The confirmed regime (last shift target) or the latest primary when no shift yet. */
  confirmed(): Regime | undefined { return this.data.shifts.at(-1)?.to ?? this.current()?.primary; }
}

/** Hourly bars of every asset for the regime engine. */
export async function regimeBars(fetcher: typeof fetch = fetch): Promise<Partial<Record<Asset, Bar[]>>> {
  const assets: Asset[] = ["XAU", "DXY", "US2Y", "US10Y", "WTI", "VIX", "SPX"];
  const out: Partial<Record<Asset, Bar[]>> = {};
  await Promise.all(assets.map(async (a) => { const b = await series(a, "60m", fetcher); if (b.length) out[a] = b; }));
  return out;
}
