import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { atomicWrite } from "./brain-store.js";
import { assessEvent } from "./event-intelligence.js";
import { parseRss } from "./brain-hunter.js";
import { zonedTime } from "./briefing.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

/**
 * Five-year backtest, statistics only (no GPT: the model already knows 2021–2025, so
 * feeding it old news would be cheating). Runs in the background one small step at a
 * time and persists everything under `dir`, so a restart resumes where it stopped.
 *
 *  - prices: Yahoo daily 5y (XAU, DXY, US10Y, WTI, VIX, SPX) + hourly ~2y (XAU, DXY, US10Y)
 *  - FRED daily (no key): 10Y real yield, 10Y breakeven, 2Y, 10Y, fed funds upper target
 *  - FRED releases (FRED_API_KEY): every US print since 5y ago with its release-day value
 *  - historical headlines: Google News weekly windows, classified by the same deterministic
 *    story classifier the live bot uses
 *
 * Output: regime timeline, event-reaction tables per release × direction × regime, a
 * walk-forward (out-of-sample) score and a stability-based confidence per table cell.
 * It never changes publishing rules (AGENTS.md): it only adds context lines for Sol.
 */
export type Bar = [number, number];
export type Regime = "RATE" | "CB" | "MIXED";
export type ReleaseSpec = { key: string; family: string; name: string; series: string; transform: "mom" | "diff" | "level"; hawkishIsHigh: boolean; match: RegExp };
export const RELEASES: ReleaseSpec[] = [
  { key: "CPI", family: "INFLATION", name: "CPI m/m", series: "CPIAUCSL", transform: "mom", hawkishIsHigh: true, match: /\bcpi\b(?!.*core)|consumer price/i },
  { key: "CORECPI", family: "INFLATION", name: "Core CPI m/m", series: "CPILFESL", transform: "mom", hawkishIsHigh: true, match: /core cpi|cpi.*core/i },
  { key: "COREPCE", family: "INFLATION", name: "Core PCE m/m", series: "PCEPILFE", transform: "mom", hawkishIsHigh: true, match: /pce/i },
  { key: "PPI", family: "INFLATION", name: "PPI m/m", series: "PPIFIS", transform: "mom", hawkishIsHigh: true, match: /\bppi\b|producer price/i },
  { key: "NFP", family: "LABOR", name: "Nonfarm Payrolls", series: "PAYEMS", transform: "diff", hawkishIsHigh: true, match: /non-?farm|payrolls/i },
  { key: "UNRATE", family: "UNEMPLOYMENT", name: "Unemployment Rate", series: "UNRATE", transform: "level", hawkishIsHigh: false, match: /unemployment rate/i },
  { key: "CLAIMS", family: "LABOR", name: "Initial Jobless Claims", series: "ICSA", transform: "level", hawkishIsHigh: false, match: /jobless claims|initial claims/i },
  { key: "RETAIL", family: "GROWTH", name: "Retail Sales m/m", series: "RSAFS", transform: "mom", hawkishIsHigh: true, match: /retail sales/i },
  { key: "GDP", family: "GROWTH", name: "GDP q/q (annualized)", series: "A191RL1Q225SBEA", transform: "level", hawkishIsHigh: true, match: /\bgdp\b/i }
];
const YAHOO: Record<string, string> = { XAU: "GC=F", DXY: "DX-Y.NYB", US10Y: "^TNX", WTI: "CL=F", VIX: "^VIX", SPX: "^GSPC" };
const HOURLY = ["XAU", "DXY", "US10Y"];
const FRED_DAILY: Record<string, string> = { REAL10: "DFII10", BE10: "T10YIE", Y2: "DGS2", Y10: "DGS10", FEDUP: "DFEDTARU" };
export const NEWS_QUERIES = ["gold price", "Federal Reserve interest rates", "Iran OR Israel OR Houthi OR war", "tariffs OR trade war", "central bank gold buying", "US inflation OR jobs report"];

export type ReleaseEvent = { key: string; family: string; name: string; at: number; date: string; actual: number; prior: number | null; trend: number | null; surprise: number; hawkish: boolean };
export type Reaction = { d1?: number; d5?: number; h1?: number; dxy1?: number; y10bp1?: number };
export type Cell = { n: number; mean1d: number; mean1h: number | null; nH: number; upShare: number; t: number; confidence: "YAKIN" | "CUKUP" | "BELUM"; stableWindows: number };
export type Results = {
  builtAt: string; years: number; events: number; newsHeadlines: number;
  regimeMonths: Record<string, Regime>; regimeShare: Record<Regime, number>; goldByRegime: Record<Regime, { days: number; meanDaily: number }>;
  cells: Record<string, Cell>;
  walkForward: { trainUntil: string; tested: number; accuracy: number; baseline: number } | null;
  themes: Record<string, Record<string, { days: number; meanDaily: number; upShare: number }>>;
  iterations: number; status: string;
};
type State = { stage: "PRICES" | "FRED" | "RELEASES" | "NEWS" | "DONE"; step: number; releasesDone?: boolean; releaseIndex: number; vintageQueue: Array<{ key: string; date: string }>; newsIndex: number; iterations: number; lastRefresh: number };

// ---------- pure helpers (tested) ----------
export function valueAt(bars: Bar[], t: number): number | undefined {
  let lo = 0, hi = bars.length - 1, out: number | undefined;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid][0] <= t) { out = bars[mid][1]; lo = mid + 1; } else hi = mid - 1; }
  return out;
}
const pct = (a?: number, b?: number) => a !== undefined && b !== undefined && a ? +(((b - a) / a) * 100).toFixed(3) : undefined;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Daily close-to-close change for trading days. */
export function dailyChanges(bars: Bar[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < bars.length; i++) if (bars[i - 1][1]) out.set(dayKey(bars[i][0]), ((bars[i][1] - bars[i - 1][1]) / bars[i - 1][1]) * 100);
  return out;
}
function corr(xs: number[], ys: number[]): number | null {
  const n = xs.length; if (n < 15) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
/**
 * Regime per month from the rolling 40-day correlation of gold vs the 10Y real yield:
 * strongly negative = RATE logic, near zero/positive = CB (structural buyer) logic.
 */
export function regimeByMonth(gold: Bar[], real: Bar[]): Record<string, Regime> {
  const g = dailyChanges(gold);
  const r = new Map<string, number>();
  for (let i = 1; i < real.length; i++) r.set(dayKey(real[i][0]), real[i][1] - real[i - 1][1]);
  const days = [...g.keys()].filter((d) => r.has(d)).sort();
  const out: Record<string, Regime> = {};
  for (const month of [...new Set(days.map((d) => d.slice(0, 7)))]) {
    const end = days.filter((d) => d.slice(0, 7) <= month).slice(-40);
    const c = corr(end.map((d) => g.get(d)!), end.map((d) => r.get(d)!));
    if (c === null) continue;
    out[month] = c <= -0.3 ? "RATE" : c >= -0.05 ? "CB" : "MIXED";
  }
  return out;
}
/** Release-day value from a vintage: actual, prior and 3-period trend, in the release's unit. */
export function releaseFigures(spec: ReleaseSpec, values: number[]): { actual: number; prior: number | null; trend: number | null } | null {
  const v = values.filter((x) => Number.isFinite(x));
  const change = (i: number) => spec.transform === "mom" ? ((v[i] - v[i - 1]) / v[i - 1]) * 100 : spec.transform === "diff" ? v[i] - v[i - 1] : v[i];
  const minLen = spec.transform === "level" ? 2 : 3;
  if (v.length < minLen) return null;
  const last = v.length - 1;
  const actual = change(last), prior = last - 1 >= (spec.transform === "level" ? 0 : 1) ? change(last - 1) : null;
  const hist: number[] = [];
  for (let i = last - 1; i >= Math.max(spec.transform === "level" ? 0 : 1, last - (spec.key === "CLAIMS" ? 4 : 3)); i--) hist.push(change(i));
  const trend = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : null;
  return { actual: +actual.toFixed(4), prior: prior === null ? null : +prior.toFixed(4), trend: trend === null ? null : +trend.toFixed(4) };
}
export function reactionAt(at: number, daily: Record<string, Bar[]>, hourly: Record<string, Bar[]>): Reaction {
  const d = daily.XAU ?? [], out: Reaction = {};
  const idx = d.findIndex((b) => dayKey(b[0]) === dayKey(at));
  if (idx > 0) { out.d1 = pct(d[idx - 1][1], d[idx][1]); if (d[idx + 4]) out.d5 = pct(d[idx - 1][1], d[idx + 4][1]); }
  const h = hourly.XAU ?? [];
  if (h.length && at >= h[0][0]) {
    const pre = valueAt(h, at - 60_000), post = valueAt(h, at + 60 * 60_000);
    if (pre !== undefined && post !== undefined && valueAt(h, at + 60 * 60_000) !== valueAt(h, at - 60_000)) out.h1 = pct(pre, post);
    const dp = valueAt(hourly.DXY ?? [], at - 60_000), dq = valueAt(hourly.DXY ?? [], at + 60 * 60_000);
    out.dxy1 = pct(dp, dq);
    const yp = valueAt(hourly.US10Y ?? [], at - 60_000), yq = valueAt(hourly.US10Y ?? [], at + 60 * 60_000);
    if (yp !== undefined && yq !== undefined) out.y10bp1 = +((yq - yp) * 10).toFixed(2); // ^TNX is yield×10
  }
  return out;
}
function stats(xs: number[]): { n: number; mean: number; t: number; up: number } {
  const n = xs.length; if (!n) return { n: 0, mean: 0, t: 0, up: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean: +mean.toFixed(3), t: sd ? +(mean / (sd / Math.sqrt(n))).toFixed(2) : 0, up: +(xs.filter((x) => x > 0).length / n).toFixed(2) };
}
const cellKeys = (e: ReleaseEvent, regime: Regime | undefined) => {
  const dir = e.hawkish ? "PANAS" : "DINGIN";
  return [`${e.key}|${dir}|ALL`, `${e.family}|${dir}|ALL`, ...(regime ? [`${e.key}|${dir}|${regime}`, `${e.family}|${dir}|${regime}`] : [])];
};
/**
 * Tables + confidence. A cell is judged on expanding windows (every quarter from year 2):
 * it is stable when the sign of its mean did not flip in the last 4 windows. Repeating the
 * same data does not add certainty; only more events and a stable sign do.
 */
export function analyse(events: Array<ReleaseEvent & { reaction: Reaction }>, regimes: Record<string, Regime>): { cells: Record<string, Cell>; walkForward: Results["walkForward"] } {
  const sorted = [...events].filter((e) => e.reaction.d1 !== undefined).sort((a, b) => a.at - b.at);
  const build = (list: typeof sorted) => {
    const acc: Record<string, { d1: number[]; h1: number[] }> = {};
    for (const e of list) for (const k of cellKeys(e, regimes[e.date.slice(0, 7)])) {
      (acc[k] ??= { d1: [], h1: [] }).d1.push(e.reaction.d1!); if (e.reaction.h1 !== undefined) acc[k].h1.push(e.reaction.h1);
    }
    return acc;
  };
  const full = build(sorted);
  const cuts: number[] = [];
  if (sorted.length) { for (let t = sorted[0].at + 365 * 86400_000; t <= sorted[sorted.length - 1].at; t += 91 * 86400_000) cuts.push(t); }
  const signs: Record<string, number[]> = {};
  for (const cut of cuts) for (const [k, v] of Object.entries(build(sorted.filter((e) => e.at <= cut)))) if (v.d1.length >= 3) (signs[k] ??= []).push(Math.sign(stats(v.d1).mean));
  const cells: Record<string, Cell> = {};
  for (const [k, v] of Object.entries(full)) {
    const s = stats(v.d1), h = stats(v.h1);
    const last = (signs[k] ?? []).slice(-4);
    const stableWindows = last.length >= 4 && last.every((x) => x === last[0] && x === Math.sign(s.mean)) ? last.length : 0;
    const confidence = stableWindows && s.n >= 8 && Math.abs(s.t) >= 2 ? "YAKIN" : stableWindows && s.n >= 6 && Math.abs(s.t) >= 1 ? "CUKUP" : "BELUM";
    cells[k] = { n: s.n, mean1d: s.mean, mean1h: h.n ? h.mean : null, nH: h.n, upShare: s.up, t: s.t, confidence, stableWindows };
  }
  // Walk-forward: tables from the first 60% predict the sign of the last 40%.
  let walkForward: Results["walkForward"] = null;
  if (sorted.length >= 30) {
    const split = Math.floor(sorted.length * 0.6), train = build(sorted.slice(0, split)), test = sorted.slice(split);
    const trainAll = sorted.slice(0, split).map((e) => e.reaction.d1!);
    const majority = Math.sign(stats(trainAll).mean) || 1;
    let hit = 0, base = 0, tested = 0;
    for (const e of test) {
      const keys = cellKeys(e, regimes[e.date.slice(0, 7)]).reverse();
      const cell = keys.map((k) => train[k]).find((c) => c && c.d1.length >= 4);
      if (!cell || !e.reaction.d1) continue;
      tested++;
      if (Math.sign(stats(cell.d1).mean) === Math.sign(e.reaction.d1)) hit++;
      if (majority === Math.sign(e.reaction.d1)) base++;
    }
    walkForward = { trainUntil: sorted[split - 1].date, tested, accuracy: tested ? +(hit / tested).toFixed(2) : 0, baseline: tested ? +(base / tested).toFixed(2) : 0 };
  }
  return { cells, walkForward };
}
/** Headline themes (same classifier as live) × regime: gold's move on days the theme was in the news. */
export function themeStudy(news: Array<{ t: number; title: string }>, gold: Bar[], regimes: Record<string, Regime>): Results["themes"] {
  const moves = dailyChanges(gold);
  const byDayTheme = new Map<string, Set<string>>();
  for (const n of news) {
    const theme = assessEvent({ provider: "backtest", providerId: n.title, title: n.title, summary: "", url: "", publishedAt: new Date(n.t) }).storyKey.split("-").slice(0, 3).join("-");
    const d = dayKey(n.t); (byDayTheme.get(d) ?? byDayTheme.set(d, new Set()).get(d)!).add(theme);
  }
  const acc: Record<string, Record<string, number[]>> = {};
  for (const [d, themes] of byDayTheme) {
    const m = moves.get(d); if (m === undefined) continue;
    for (const th of themes) for (const reg of ["ALL", regimes[d.slice(0, 7)] ?? "MIXED"]) ((acc[th] ??= {})[reg] ??= []).push(m);
  }
  const out: Results["themes"] = {};
  for (const [th, regs] of Object.entries(acc)) for (const [reg, xs] of Object.entries(regs)) if (xs.length >= 5) { const s = stats(xs); (out[th] ??= {})[reg] = { days: s.n, meanDaily: s.mean, upShare: s.up }; }
  return out;
}
export function specFor(eventName: string): ReleaseSpec | undefined {
  if (/core/i.test(eventName) && /cpi/i.test(eventName)) return RELEASES.find((r) => r.key === "CORECPI");
  return RELEASES.find((r) => r.key !== "CORECPI" && r.match.test(eventName));
}
const fmtCell = (label: string, c: Cell | undefined) => c && c.n >= 4
  ? `${label} → XAU hari itu rata-rata ${c.mean1d >= 0 ? "+" : ""}${c.mean1d}% (n=${c.n}, naik ${Math.round(c.upShare * 100)}% kasus${c.mean1h !== null && c.nH >= 4 ? `, 1 jam pertama ${c.mean1h >= 0 ? "+" : ""}${c.mean1h}% n=${c.nH}` : ""}, keyakinan ${c.confidence})`
  : "";
/** Context line for Sol about one scheduled release, under the current regime. */
export function insightLine(r: Results | null, eventName: string, regime: Regime): string {
  const spec = r && specFor(eventName); if (!r || !spec) return "";
  const pick = (dir: string): string => (r.cells[`${spec.key}|${dir}|${regime}`]?.n ?? 0) >= 4
    ? fmtCell(`${spec.name} ${dir.toLowerCase()} saat rezim ${regime}`, r.cells[`${spec.key}|${dir}|${regime}`])
    : fmtCell(`${spec.name} ${dir.toLowerCase()} (semua rezim)`, r.cells[`${spec.key}|${dir}|ALL`]);
  const lines = ["PANAS", "DINGIN"].map(pick).filter(Boolean);
  if (!lines.length) return "";
  const wf = r.walkForward ? ` Uji luar sampel semua rilis: arah benar ${Math.round(r.walkForward.accuracy * 100)}% vs acuan ${Math.round(r.walkForward.baseline * 100)}% (n=${r.walkForward.tested}).` : "";
  return `BACKTEST ${r.years} THN (statistik, "panas/dingin" = dibanding tren 3 periode, bukan konsensus): ${lines.join("; ")}.${wf}`;
}
export function regimeLine(r: Results | null): string {
  if (!r || !Object.keys(r.regimeMonths).length) return "";
  const g = r.goldByRegime;
  return `BACKTEST REZIM ${r.years} THN: RATE ${Math.round(r.regimeShare.RATE * 100)}% bulan (emas rata-rata ${g.RATE.meanDaily}%/hari), CB ${Math.round(r.regimeShare.CB * 100)}% (${g.CB.meanDaily}%/hari), MIXED ${Math.round(r.regimeShare.MIXED * 100)}% (${g.MIXED.meanDaily}%/hari).`;
}
export function formatStatus(r: Results | null, s: State): string {
  if (!r) return `Backtest berjalan: tahap ${s.stage} langkah ${s.step}. Belum ada hasil.`;
  const top = Object.entries(r.cells).filter(([k, c]) => k.split("|")[2] !== "ALL" && c.confidence !== "BELUM").sort((a, b) => Math.abs(b[1].t) - Math.abs(a[1].t)).slice(0, 8)
    .map(([k, c]) => `  ${k.replace(/\|/g, " · ")}: ${c.mean1d >= 0 ? "+" : ""}${c.mean1d}% n=${c.n} t=${c.t} ${c.confidence}`);
  const conf = Object.values(r.cells).reduce<Record<string, number>>((m, c) => { m[c.confidence] = (m[c.confidence] ?? 0) + 1; return m; }, {});
  return [`BACKTEST ${r.years} THN — ${r.status} (iterasi ${r.iterations}, tahap ${s.stage})`, `Rilis tercatat: ${r.events} · judul berita historis: ${r.newsHeadlines}`,
    regimeLine(r), r.walkForward ? `Walk-forward (latih s/d ${r.walkForward.trainUntil}): arah benar ${Math.round(r.walkForward.accuracy * 100)}% vs acuan ${Math.round(r.walkForward.baseline * 100)}% (n=${r.walkForward.tested})` : "Walk-forward: data belum cukup",
    `Sel: YAKIN ${conf.YAKIN ?? 0} · CUKUP ${conf.CUKUP ?? 0} · BELUM ${conf.BELUM ?? 0}`, top.length ? `Temuan terkuat:\n${top.join("\n")}` : ""].filter(Boolean).join("\n");
}

// ---------- runner ----------
type Fetcher = typeof fetch;
export class Backtest {
  private state: State;
  private results: Results | null;
  constructor(private readonly dir: string, private readonly fredKey?: string, private readonly years = 5, private readonly fetcher: Fetcher = fetch) {
    mkdirSync(dir, { recursive: true });
    this.state = this.read<State>("state.json") ?? { stage: "PRICES", step: 0, releaseIndex: 0, vintageQueue: [], newsIndex: 0, iterations: 0, lastRefresh: 0 };
    this.results = this.read<Results>("results.json");
  }
  private read<T>(f: string): T | null { try { return existsSync(join(this.dir, f)) ? JSON.parse(readFileSync(join(this.dir, f), "utf8")) as T : null; } catch { return null; } }
  private save(): void { atomicWrite(join(this.dir, "state.json"), this.state); }
  current(): Results | null { return this.results; }
  status(): string { return formatStatus(this.results, this.state); }
  insight(eventName: string, regime: Regime): string { return insightLine(this.results, eventName, regime); }
  regime(): string { return regimeLine(this.results); }

  private async get(url: string): Promise<Response> {
    return this.fetcher(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; HitnRunBacktest/1.0)", Accept: "*/*" }, signal: AbortSignal.timeout(20_000) });
  }
  private async yahoo(symbol: string, range: string, interval: string): Promise<Bar[]> {
    const r = await this.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`);
    if (!r.ok) throw new Error(`yahoo ${symbol} ${r.status}`);
    const b = await r.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } };
    const res = b.chart?.result?.[0]; const c = res?.indicators?.quote?.[0]?.close ?? [];
    return (res?.timestamp ?? []).map((t, i) => [t * 1000, c[i]] as [number, number | null | undefined]).filter((x): x is Bar => typeof x[1] === "number");
  }
  private async fredCsv(id: string): Promise<Bar[]> {
    const start = new Date(Date.now() - (this.years + 1) * 365 * 86400_000).toISOString().slice(0, 10);
    const r = await this.get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`);
    if (!r.ok) throw new Error(`fred ${id} ${r.status}`);
    return (await r.text()).split("\n").slice(1).map((l) => l.split(",")).filter((p) => p.length >= 2 && p[1] && p[1] !== ".").map((p) => [Date.parse(`${p[0]}T00:00:00Z`), Number(p[1])] as Bar).filter((b) => Number.isFinite(b[1]));
  }
  private async fredApi(path: string, params: Record<string, string>): Promise<unknown> {
    const u = new URL(`https://api.stlouisfed.org/fred/${path}`);
    for (const [k, v] of Object.entries({ ...params, api_key: this.fredKey!, file_type: "json" })) u.searchParams.set(k, v);
    const r = await this.get(u.toString());
    if (!r.ok) throw new Error(`fred api ${path} ${r.status}`);
    return r.json();
  }

  /** One unit of work. Call every ~20 seconds; cheap when there is nothing to do. */
  async step(now = Date.now()): Promise<void> {
    const s = this.state;
    try {
      if (s.stage === "PRICES") {
        const daily = this.read<Record<string, Bar[]>>("daily.json") ?? {}, hourly = this.read<Record<string, Bar[]>>("hourly.json") ?? {};
        const keys = Object.keys(YAHOO);
        if (s.step < keys.length) { const k = keys[s.step]; daily[k] = await this.yahoo(YAHOO[k], `${this.years}y`, "1d"); atomicWrite(join(this.dir, "daily.json"), daily); log.info({ asset: k, bars: daily[k].length }, "Backtest daily prices"); }
        else { const k = HOURLY[s.step - keys.length]; hourly[k] = await this.yahoo(YAHOO[k], "730d", "60m"); atomicWrite(join(this.dir, "hourly.json"), hourly); log.info({ asset: k, bars: hourly[k].length }, "Backtest hourly prices"); }
        s.step++; if (s.step >= keys.length + HOURLY.length) { s.stage = "FRED"; s.step = 0; }
      } else if (s.stage === "FRED") {
        const fred = this.read<Record<string, Bar[]>>("fred.json") ?? {};
        const keys = Object.keys(FRED_DAILY); const k = keys[s.step];
        fred[k] = await this.fredCsv(FRED_DAILY[k]); atomicWrite(join(this.dir, "fred.json"), fred); log.info({ series: k, obs: fred[k].length }, "Backtest FRED daily");
        s.step++; if (s.step >= keys.length) { s.stage = this.fredKey ? "RELEASES" : "NEWS"; s.step = 0; this.analyse(); }
      } else if (s.stage === "RELEASES") {
        await this.releaseStep();
      } else if ((s.stage === "NEWS" || s.stage === "DONE") && this.fredKey && !s.releasesDone) {
        // FRED key added after the first run: go back and collect the release history.
        s.stage = "RELEASES"; s.releaseIndex = 0; s.vintageQueue = [];
      } else if (s.stage === "NEWS") {
        await this.newsStep(now);
      } else if (now - s.lastRefresh > 7 * 86400_000) {
        // Weekly refresh: new prices, new releases and a new iteration of the analysis.
        s.stage = "PRICES"; s.step = 0; s.releaseIndex = 0; s.vintageQueue = []; s.lastRefresh = now;
      }
    } catch (error) {
      log.warn({ err: error, stage: s.stage, step: s.step }, "Backtest step failed; will retry");
      if (s.stage === "PRICES" || s.stage === "FRED") s.step++; // skip a dead symbol instead of blocking the pipeline
      if (s.stage === "PRICES" && s.step >= Object.keys(YAHOO).length + HOURLY.length) { s.stage = "FRED"; s.step = 0; }
      if (s.stage === "FRED" && s.step >= Object.keys(FRED_DAILY).length) { s.stage = this.fredKey ? "RELEASES" : "NEWS"; s.step = 0; }
    }
    this.save();
  }
  private async releaseStep(): Promise<void> {
    const s = this.state;
    // First run: the whole window. Weekly refreshes: only the last 45 days.
    const start = new Date(Date.now() - (s.releasesDone ? 45 : this.years * 365) * 86400_000).toISOString().slice(0, 10);
    if (!s.vintageQueue.length) {
      const spec = RELEASES[s.releaseIndex];
      if (!spec) { s.releasesDone = true; s.stage = s.newsIndex >= this.years * 52 * NEWS_QUERIES.length ? "DONE" : "NEWS"; s.step = 0; this.analyse(); return; }
      const v = await this.fredApi("series/vintagedates", { series_id: spec.series, realtime_start: start, limit: "10000" }) as { vintage_dates?: string[] };
      s.vintageQueue = (v.vintage_dates ?? []).map((date) => ({ key: spec.key, date }));
      s.releaseIndex++;
      log.info({ release: spec.key, vintages: s.vintageQueue.length }, "Backtest release dates");
      return;
    }
    const job = s.vintageQueue.shift()!;
    const spec = RELEASES.find((r) => r.key === job.key)!;
    const obsStart = new Date(Date.parse(job.date) - (spec.key === "GDP" ? 900 : 200) * 86400_000).toISOString().slice(0, 10);
    const o = await this.fredApi("series/observations", { series_id: spec.series, realtime_start: job.date, realtime_end: job.date, observation_start: obsStart }) as { observations?: Array<{ date: string; value: string }> };
    const obs = (o.observations ?? []).filter((x) => x.value !== ".");
    const lastObs = obs[obs.length - 1]?.date;
    const seen = this.read<Record<string, string>>("last-obs.json") ?? {};
    // A vintage whose latest observation did not move is a revision day, not a release.
    if (lastObs && seen[spec.key] !== lastObs) {
      seen[spec.key] = lastObs; atomicWrite(join(this.dir, "last-obs.json"), seen);
      const fig = releaseFigures(spec, obs.map((x) => Number(x.value)));
      if (fig) {
        const surprise = +(fig.actual - (fig.trend ?? fig.prior ?? fig.actual)).toFixed(4);
        const ev: ReleaseEvent = { key: spec.key, family: spec.family, name: spec.name, date: job.date, at: zonedTime(job.date, "08:30", "America/New_York"),
          actual: fig.actual, prior: fig.prior, trend: fig.trend, surprise, hawkish: spec.hawkishIsHigh ? surprise > 0 : surprise < 0 };
        appendFileSync(join(this.dir, "releases.jsonl"), JSON.stringify(ev) + "\n");
      }
    }
  }
  private async newsStep(now: number): Promise<void> {
    const s = this.state;
    const weeks = this.years * 52, total = weeks * NEWS_QUERIES.length;
    if (s.newsIndex >= total) { s.stage = "DONE"; s.lastRefresh = now; this.analyse(); return; }
    const week = Math.floor(s.newsIndex / NEWS_QUERIES.length), q = NEWS_QUERIES[s.newsIndex % NEWS_QUERIES.length];
    const from = new Date(now - (weeks - week) * 7 * 86400_000), to = new Date(from.getTime() + 7 * 86400_000);
    const u = new URL("https://news.google.com/rss/search");
    u.searchParams.set("q", `${q} after:${from.toISOString().slice(0, 10)} before:${to.toISOString().slice(0, 10)}`);
    u.searchParams.set("hl", "en-US"); u.searchParams.set("gl", "US"); u.searchParams.set("ceid", "US:en");
    const r = await this.get(u.toString());
    if (r.ok) {
      const items = parseRss(await r.text(), from).filter((a) => a.publishedAt.getTime() < to.getTime() + 86400_000);
      if (items.length) appendFileSync(join(this.dir, "news.jsonl"), items.map((a) => JSON.stringify({ t: a.publishedAt.getTime(), title: a.title, q })).join("\n") + "\n");
    }
    s.newsIndex++;
    if (s.newsIndex % 60 === 0) { this.analyse(); log.info({ progress: `${s.newsIndex}/${total}` }, "Backtest news crawl progress"); }
  }
  private lines<T>(f: string): T[] {
    const p = join(this.dir, f); if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as T; } catch { return null; } }).filter((x): x is T => x !== null);
  }
  /** Rebuilds all tables from what is on disk. Each call is one iteration. */
  analyse(): Results | null {
    const daily = this.read<Record<string, Bar[]>>("daily.json") ?? {}, hourly = this.read<Record<string, Bar[]>>("hourly.json") ?? {}, fred = this.read<Record<string, Bar[]>>("fred.json") ?? {};
    if (!daily.XAU?.length || !fred.REAL10?.length) return this.results;
    const regimes = regimeByMonth(daily.XAU, fred.REAL10);
    const releases = [...new Map(this.lines<ReleaseEvent>("releases.jsonl").map((e) => [`${e.key}|${e.date}`, e])).values()];
    const events = releases.map((e) => ({ ...e, reaction: reactionAt(e.at, daily, hourly) }));
    const { cells, walkForward } = analyse(events, regimes);
    const moves = dailyChanges(daily.XAU);
    const regs: Regime[] = ["RATE", "CB", "MIXED"];
    const months = Object.values(regimes);
    const goldByRegime = Object.fromEntries(regs.map((g) => { const xs = [...moves].filter(([d]) => regimes[d.slice(0, 7)] === g).map(([, m]) => m); const st = stats(xs); return [g, { days: st.n, meanDaily: st.mean }]; })) as Results["goldByRegime"];
    const news = this.lines<{ t: number; title: string }>("news.jsonl");
    this.state.iterations++;
    const status = this.state.stage === "DONE" ? "selesai; diperbarui mingguan" : `berjalan (${this.state.stage})`;
    this.results = { builtAt: new Date().toISOString(), years: this.years, events: events.length, newsHeadlines: news.length, regimeMonths: regimes,
      regimeShare: Object.fromEntries(regs.map((g) => [g, months.length ? +(months.filter((m) => m === g).length / months.length).toFixed(2) : 0])) as Results["regimeShare"],
      goldByRegime, cells, walkForward, themes: themeStudy(news, daily.XAU, regimes), iterations: this.state.iterations, status };
    atomicWrite(join(this.dir, "results.json"), this.results);
    log.info({ iteration: this.state.iterations, events: events.length, news: news.length, walkForward, regimeShare: this.results.regimeShare }, "Backtest analysis updated");
    return this.results;
  }
}
