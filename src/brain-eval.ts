import type { Action, Episode, MarkMinute } from "./brain-episodes.js";
import { isFalseAlert } from "./brain-labeler.js";
import type { RegimeShift } from "./brain-regime.js";

/**
 * Continuous evaluation of the brain: directional accuracy per horizon, confidence
 * calibration, paper-trade expectancy after spread+slippage, profit factor, max
 * drawdown, false alerts, missed news, narrative-shift detection speed, and the
 * same numbers per catalyst and per regime. Paper only; nothing here trades.
 */
export type Trade = { id: string; at: string; action: "BUY" | "SELL"; horizon: MarkMinute; gross: number; net: number; catalyst: string; regime: string; confidence: number };
export type Metrics = {
  episodes: number; reviewed: number; labeled: number;
  hitByHorizon: Record<string, { hit: number; miss: number; rate: number | null }>;
  calibration: Array<{ band: string; calls: number; hitRate: number | null }>;
  labels: Record<string, number>;
  trades: number; winRate: number | null; expectancy: number | null; profitFactor: number | null; maxDrawdown: number; totalNet: number;
  falseAlerts: number; publishedLabeled: number; falseAlertRate: number | null;
  missedImportant: number; waits: number; noTrades: number;
  shiftLatencyHours: number | null;
  byCatalyst: Array<{ key: string; trades: number; expectancy: number | null; hitRate: number | null }>;
  byRegime: Array<{ key: string; trades: number; expectancy: number | null; hitRate: number | null }>;
};

const rate = (h: number, m: number) => h + m ? h / (h + m) : null;
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export function tradesOf(episodes: Episode[], costPct: number, actionOf: (e: Episode) => Action = (e) => e.finalAction): Trade[] {
  const out: Trade[] = [];
  for (const e of episodes) {
    const action = actionOf(e);
    if (action !== "BUY" && action !== "SELL") continue;
    const H = e.decision?.horizonMinutes ?? 60;
    const r = e.marks[`${H}`]?.moves.XAU;
    if (r === undefined) continue;
    const gross = (action === "BUY" ? 1 : -1) * r;
    out.push({ id: e.id, at: e.at, action, horizon: H, gross, net: gross - costPct, catalyst: e.catalyst, regime: e.regime?.primary ?? "UNCLEAR", confidence: e.decision?.confidence ?? 0 });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function tradeStats(trades: Trade[]): { expectancy: number | null; profitFactor: number | null; maxDrawdown: number; winRate: number | null; totalNet: number } {
  let equity = 0, peak = 0, maxDD = 0, wins = 0, grossWin = 0, grossLoss = 0;
  for (const t of trades) {
    equity += t.net; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity);
    if (t.net > 0) { wins++; grossWin += t.net; } else grossLoss += -t.net;
  }
  return { expectancy: mean(trades.map((t) => t.net)), profitFactor: grossLoss ? grossWin / grossLoss : trades.length ? Infinity : null,
    maxDrawdown: +maxDD.toFixed(4), winRate: trades.length ? wins / trades.length : null, totalNet: +equity.toFixed(4) };
}

export function metrics(episodes: Episode[], costPct: number, shifts: RegimeShift[] = [], actionOf?: (e: Episode) => Action): Metrics {
  const reviewed = episodes.filter((e) => e.reviewed);
  const labeled = episodes.filter((e) => e.label);
  const hitByHorizon: Metrics["hitByHorizon"] = {};
  for (const m of [15, 60, 240, 1440] as MarkMinute[]) {
    let hit = 0, miss = 0;
    for (const e of reviewed) {
      const d = e.decision?.direction; if (d !== "BULLISH" && d !== "BEARISH") continue;
      const r = e.marks[`${m}`]?.moves.XAU; if (r === undefined || Math.abs(r) < 0.05) continue;
      if ((d === "BULLISH") === (r > 0)) hit++; else miss++;
    }
    hitByHorizon[`${m}`] = { hit, miss, rate: rate(hit, miss) };
  }
  const bands = [[50, 60], [60, 70], [70, 80], [80, 101]].map(([lo, hi]) => {
    let hit = 0, miss = 0;
    for (const e of reviewed) {
      const d = e.decision; if (!d || (d.direction !== "BULLISH" && d.direction !== "BEARISH") || d.confidence < lo || d.confidence >= hi) continue;
      const r = e.marks[`${d.horizonMinutes}`]?.moves.XAU; if (r === undefined || Math.abs(r) < 0.05) continue;
      if ((d.direction === "BULLISH") === (r > 0)) hit++; else miss++;
    }
    return { band: `${lo}-${Math.min(hi, 100) - 1}%`, calls: hit + miss, hitRate: rate(hit, miss) };
  });
  const labels: Record<string, number> = {};
  for (const e of labeled) labels[e.label!.label] = (labels[e.label!.label] ?? 0) + 1;
  const costed = tradesOf(reviewed, costPct, actionOf);
  const stats = tradeStats(costed);
  const publishedLabeled = reviewed.filter((e) => e.published && e.label).length;
  const falseAlerts = reviewed.filter(isFalseAlert).length;
  const missedImportant = episodes.filter((e) => e.label?.label === "MISSED_MOVE" && e.tier <= 2 && Math.abs(e.label.peakMove ?? 0) >= 0.3).length;
  const group = (key: (t: typeof costed[number]) => string) => {
    const map = new Map<string, typeof costed>();
    for (const t of costed) map.set(key(t), [...(map.get(key(t)) ?? []), t]);
    return [...map].map(([k, ts]) => ({ key: k, trades: ts.length, expectancy: mean(ts.map((t) => t.net)), hitRate: ts.length ? ts.filter((t) => t.gross > 0).length / ts.length : null }))
      .sort((a, b) => b.trades - a.trades).slice(0, 8);
  };
  // Narrative-shift speed: hours from the first material alert of the new driver's catalyst family to the confirmed shift.
  const family: Record<string, string[]> = { RATES_FED: ["FED", "LABOR"], INFLATION: ["INFLATION"], GEOPOLITICS: ["GEOPOLITICS", "ENERGY"], DOLLAR: ["DOLLAR"], YIELDS: ["YIELDS"], RECESSION: ["GROWTH", "LABOR"] };
  const lags: number[] = [];
  for (const s of shifts) {
    const cats = family[s.to]; if (!cats) continue;
    const t = Date.parse(s.at);
    const first = reviewed.filter((e) => e.published && cats.includes(e.catalyst) && Date.parse(e.at) <= t && Date.parse(e.at) >= t - 72 * 3600_000).sort((a, b) => a.at.localeCompare(b.at))[0];
    if (first) lags.push((t - Date.parse(first.at)) / 3600_000);
  }
  return {
    episodes: episodes.length, reviewed: reviewed.length, labeled: labeled.length, hitByHorizon, calibration: bands, labels,
    trades: costed.length, winRate: stats.winRate, expectancy: stats.expectancy, profitFactor: stats.profitFactor, maxDrawdown: stats.maxDrawdown, totalNet: stats.totalNet,
    falseAlerts, publishedLabeled, falseAlertRate: publishedLabeled ? falseAlerts / publishedLabeled : null, missedImportant,
    waits: reviewed.filter((e) => e.finalAction === "WAIT").length, noTrades: reviewed.filter((e) => e.finalAction === "NO_TRADE").length,
    shiftLatencyHours: lags.length ? +(mean(lags)!.toFixed(1)) : null,
    byCatalyst: group((t) => t.catalyst), byRegime: group((t) => t.regime)
  };
}

const p = (v: number | null, d = 1) => v === null ? "–" : `${(v * 100).toFixed(d)}%`;
const r = (v: number | null, d = 3) => v === null ? "–" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
export function formatMetrics(m: Metrics, title: string): string {
  return [`🧠 ${title}`,
    `Episode ${m.episodes} (direview Sol ${m.reviewed}, sudah dinilai ${m.labeled})`,
    `Akurasi arah: 15m ${p(m.hitByHorizon["15"].rate)} · 1j ${p(m.hitByHorizon["60"].rate)} · 4j ${p(m.hitByHorizon["240"].rate)} · 24j ${p(m.hitByHorizon["1440"].rate)}`,
    `Kalibrasi: ${m.calibration.filter((b) => b.calls).map((b) => `${b.band}→${p(b.hitRate, 0)} (${b.calls})`).join(" · ") || "–"}`,
    `Label: ${Object.entries(m.labels).map(([k, v]) => `${k} ${v}`).join(" · ") || "–"}`,
    `Paper (setelah biaya): ${m.trades} keputusan · win ${p(m.winRate)} · expectancy ${r(m.expectancy)} · PF ${m.profitFactor === null ? "–" : Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞"} · maxDD ${m.maxDrawdown.toFixed(2)}% · total ${r(m.totalNet, 2)}`,
    `WAIT ${m.waits} · NO_TRADE ${m.noTrades} · false alert ${m.falseAlerts}/${m.publishedLabeled} (${p(m.falseAlertRate)}) · berita penting terlewat ${m.missedImportant}`,
    `Deteksi pergantian narasi: ${m.shiftLatencyHours === null ? "belum ada data" : `rata-rata ${m.shiftLatencyHours} jam`}`,
    `Per katalis: ${m.byCatalyst.map((x) => `${x.key} ${x.trades}× ${r(x.expectancy)}`).join(" · ") || "–"}`,
    `Per rezim: ${m.byRegime.map((x) => `${x.key} ${x.trades}× ${r(x.expectancy)}`).join(" · ") || "–"}`,
    `Penilaian internal bot, bukan sinyal trading.`].join("\n");
}
