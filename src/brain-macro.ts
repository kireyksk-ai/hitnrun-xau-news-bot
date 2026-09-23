import { existsSync, readFileSync } from "node:fs";
import { correlation, move, series, type Asset, type Bar } from "./brain-market.js";
import { atomicWrite, backupOnce } from "./brain-store.js";
import { REGIME_RULES_SUMMARY } from "./brain-events.js";

/**
 * Macro layer of the Market Brain.
 *  1. Linkage regime: is gold trading the RATE logic (yields up → gold down) or the
 *     CENTRAL-BANK / DEBASEMENT logic (yields up, gold still bid: reserve buying,
 *     sovereign/fiscal risk)? Weighted score in [-1, +1], 3-day confirmation,
 *     fast switch on a long-end yield shock, false-switch detection.
 *  2. Rule chain: oil → inflation expectations → rate expectations → gold, whose
 *     sign depends on the linkage regime; every fire is resolved against the real
 *     gold move and each rule's confidence is learned from its own hit rate.
 *  3. Battle tracker: strength and direction of each camp (central banks, rates,
 *     geopolitical hedge, speculative/CTA flow).
 * Inputs that are not available from the bot's feeds (breakeven inflation, real
 * yields, central-bank tonnage, debt/GDP) are reported as unavailable, never guessed.
 */
export type Linkage = "RATE" | "CB" | "MIXED";
export type LinkageSignal = { name: string; weight: number; value: number | null; f: number | null; note: string };
export type LinkageReading = { at: string; score: number; regime: Linkage; confidence: number; signals: LinkageSignal[]; unavailable: string[] };
export type MacroInput = {
  now: number;
  daily: Partial<Record<Asset, Bar[]>>;
  goldFlowNews30d: number;   // central-bank / reserve-buying headlines seen (proxy for tonnage)
  geoShare7d: number;        // share of material catalysts that were geopolitical/energy (0..1)
  geoSharePrev7d: number;
};

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const last = (b?: Bar[]) => b?.length ? b[b.length - 1][1] : undefined;
function changeDays(bars: Bar[] | undefined, asset: Asset, days: number): number | undefined {
  if (!bars || bars.length < days + 1) return undefined;
  return move(asset, bars[bars.length - 1 - days][1], bars[bars.length - 1][1]);
}
function meanStd(values: number[]): { mean: number; std: number } {
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  return { mean, std: Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, values.length)) };
}

export function evaluateLinkage(input: MacroInput, threshold = 0.3): LinkageReading {
  const d = input.daily;
  const since = input.now - 30 * 86400_000; // ~20 trading days
  const c10 = d.XAU && d.US10Y ? correlation(d.XAU, d.US10Y, since, 86400_000, 12) : undefined;
  const cDxy = d.XAU && d.DXY ? correlation(d.XAU, d.DXY, since, 86400_000, 12) : undefined;
  const y30 = last(d.US30Y);
  const signals: LinkageSignal[] = [
    { name: "corr20d XAU-US10Y", weight: 0.30, value: c10?.r ?? null, f: c10 ? clamp(-c10.r / 0.5) : null, note: "negatif kuat = logika rate; positif = logika bank sentral/debasement" },
    { name: "corr20d XAU-DXY", weight: 0.20, value: cDxy?.r ?? null, f: cDxy ? clamp(-cDxy.r / 0.5) : null, note: "negatif kuat = rate/dolar dominan" },
    { name: "berita pembelian bank sentral 30h (proxy tonase)", weight: 0.20, value: input.goldFlowNews30d, f: -Math.min(1, input.goldFlowNews30d / 8), note: "tonase resmi tidak tersedia; dipakai jumlah berita reserve buying" },
    { name: "yield 30Y level", weight: 0.15, value: y30 ?? null, f: y30 === undefined ? null : clamp((4.9 - y30) / 0.4), note: ">5.3% = stres fiskal → condong bank sentral; <4.5% = condong rate" },
    { name: "risiko geopolitik (porsi berita 7h)", weight: 0.05, value: input.geoShare7d, f: -Math.min(1, input.geoShare7d * 2), note: "naik = hedge sementara" }
  ];
  const unavailable = ["debt/GDP & rasio bunga (tidak ada feed; bobot 0.10 dibagi ke sinyal lain)"];
  const usable = signals.filter((s) => s.f !== null);
  const wsum = usable.reduce((a, s) => a + s.weight, 0);
  const score = wsum ? usable.reduce((a, s) => a + s.weight * s.f!, 0) / wsum : 0;
  const regime: Linkage = score > threshold ? "RATE" : score < -threshold ? "CB" : "MIXED";
  const confidence = Math.round(Math.min(1, Math.abs(score) / 0.7) * Math.min(1, wsum / 0.9) * 100) / 100;
  return { at: new Date(input.now).toISOString(), score: +score.toFixed(3), regime, confidence, signals, unavailable };
}

export type LinkageState = { official: Linkage; since: string; threshold: number; falseSwitches: string[]; history: LinkageReading[]; switches: Array<{ at: string; from: Linkage; to: Linkage; fast: boolean }> };
/** Official switch needs the candidate to hold for 72h of readings, or a long-end shock (30Y +50bp in 2 days). */
export function updateOfficial(state: LinkageState, reading: LinkageReading, y30Change2d?: number): { state: LinkageState; switched?: { from: Linkage; to: Linkage; fast: boolean } } {
  const now = Date.parse(reading.at);
  const history = [...state.history, reading].slice(-2000);
  let { official, since, threshold, falseSwitches } = state;
  // Relax a raised threshold after 30 days without false switches.
  if (falseSwitches.length && now - Date.parse(falseSwitches[falseSwitches.length - 1]) > 30 * 86400_000) threshold = Math.max(0.3, threshold - 0.1);
  let switched: { from: Linkage; to: Linkage; fast: boolean } | undefined;
  const fast = y30Change2d !== undefined && y30Change2d >= 50 && reading.regime !== official;
  const window = history.filter((r) => now - Date.parse(r.at) <= 72 * 3600_000);
  const spanned = window.length && now - Date.parse(window[0].at) >= 70 * 3600_000;
  const held = spanned && window.every((r) => r.regime === reading.regime);
  if (reading.regime !== official && (fast || held)) {
    // A switch back within 48h of the previous one was a false switch: demand more next time.
    const lastSwitch = state.switches[state.switches.length - 1];
    if (lastSwitch && lastSwitch.from === reading.regime && now - Date.parse(lastSwitch.at) < 48 * 3600_000) {
      falseSwitches = [...falseSwitches, reading.at].slice(-20); threshold = Math.min(0.6, threshold + 0.1);
    }
    switched = { from: official, to: reading.regime, fast };
    official = reading.regime; since = reading.at;
  }
  return { state: { official, since, threshold, falseSwitches, history, switches: switched ? [...state.switches, { at: reading.at, ...switched }].slice(-200) : state.switches }, switched };
}

// ---------- rule chain ----------
export type Bias = "BULLISH" | "BEARISH" | "NEUTRAL";
export type RuleFire = { id: string; at: string; rule: string; bias: Bias; baseConfidence: number; confidence: number; horizonHours: number; regime: Linkage; reason: string;
  trigger: Record<string, number | string | null>; xau0?: number; resolved?: boolean; outcomePct?: number; correct?: boolean };
export type RuleContext = {
  now: number; regime: Linkage; xau?: number;
  oil24h?: number; oilZ30?: number; fedImplied5d?: number; us10y5d?: number; us30y?: number; us30y5d?: number; dxy5d?: number;
  geoShare7d: number; geoSharePrev7d: number;
};
type RuleDef = { id: string; name: string; horizonHours: number; baseConfidence: number; when: (c: RuleContext) => { bias: Bias; reason: string } | null };
export const RULES: RuleDef[] = [
  { id: "R1", name: "oil spike → ekspektasi inflasi naik", horizonHours: 72, baseConfidence: 0.65, when: (c) =>
    c.oil24h !== undefined && c.oil24h > 3 ? (c.regime === "CB" ? { bias: "NEUTRAL", reason: `minyak +${c.oil24h.toFixed(1)}% tapi rezim CB: bank sentral menyerap` } : { bias: "BEARISH", reason: `minyak +${c.oil24h.toFixed(1)}% (z ${c.oilZ30?.toFixed(1) ?? "n/a"}) → inflasi → rate hawkish` }) : null },
  { id: "R3", name: "ekspektasi rate naik → emas turun (rezim RATE)", horizonHours: 120, baseConfidence: 0.6, when: (c) =>
    c.regime === "RATE" && (c.fedImplied5d ?? 0) > 15 ? { bias: "BEARISH", reason: `fed funds implied +${c.fedImplied5d!.toFixed(0)}bp 5 hari di rezim RATE` } : null },
  { id: "R4", name: "rate naik tapi rezim CB → rantai batal", horizonHours: 120, baseConfidence: 0.55, when: (c) =>
    c.regime === "CB" && (c.fedImplied5d ?? 0) > 15 ? { bias: "BULLISH", reason: `rate naik ${c.fedImplied5d!.toFixed(0)}bp tapi pembelian bank sentral & risiko sovereign menyerap` } : null },
  { id: "R5", name: "konflik naik: cek oil dulu", horizonHours: 48, baseConfidence: 0.55, when: (c) => {
    if (!(c.geoShare7d > Math.max(0.1, c.geoSharePrev7d * 1.2))) return null;
    if ((c.oil24h ?? 0) > 5) return c.regime === "CB" ? { bias: "NEUTRAL", reason: `konflik + oil +${c.oil24h!.toFixed(1)}%: rezim CB, turun terbatas` } : { bias: "BEARISH", reason: `konflik + oil +${c.oil24h!.toFixed(1)}% (>5%): safe haven kalah sama logika rate` };
    if (Math.abs(c.oil24h ?? 0) < 2) return { bias: "BULLISH", reason: "konflik naik tapi oil stabil: safe haven klasik" };
    return null; } },
  { id: "R8", name: "stres fiskal long-end → switch ke kredit sovereign", horizonHours: 120, baseConfidence: 0.55, when: (c) =>
    (c.us30y ?? 0) > 5.3 ? { bias: "BULLISH", reason: `30Y ${c.us30y!.toFixed(2)}% > 5.3% (${(c.us30y5d ?? 0) >= 0 ? "+" : ""}${(c.us30y5d ?? 0).toFixed(0)}bp 5h) → stres fiskal, logika switch; override rule oil` } : null },
  { id: "R9", name: "dolar trending kuat di rezim RATE", horizonHours: 72, baseConfidence: 0.55, when: (c) =>
    c.regime === "RATE" && Math.abs(c.dxy5d ?? 0) > 1 ? { bias: (c.dxy5d ?? 0) > 0 ? "BEARISH" : "BULLISH", reason: `DXY ${c.dxy5d!.toFixed(2)}% 5 hari` } : null }
];
export const UNAVAILABLE_RULES = ["R2 breakeven 10Y (tidak ada feed breakeven)", "R6 real yield (butuh breakeven/TIPS)", "R7 Fed pivot (butuh hitungan pidato hawkish + CPI 3m annualized)"];

export type RuleStats = Record<string, { n: number; hits: number; byRegime: Record<string, { n: number; hits: number }> }>;
/** Learned confidence: prior blended with the rule's own hit rate (k = 20 pseudo-observations). */
export function learnedConfidence(base: number, stats?: { n: number; hits: number }): number {
  if (!stats || !stats.n) return base;
  const k = 20;
  return +((base * k + (stats.hits / stats.n) * stats.n) / (k + stats.n)).toFixed(3);
}
export function ruleDisabled(stats?: { n: number; hits: number }): boolean { return Boolean(stats && stats.n >= 30 && stats.hits / stats.n < 0.4); }

export function fireRules(c: RuleContext, recent: RuleFire[], stats: RuleStats): RuleFire[] {
  const out: RuleFire[] = [];
  for (const r of RULES) {
    const hit = r.when(c); if (!hit) continue;
    // One fire per rule per 12 hours for the same bias.
    if (recent.some((f) => f.rule === r.id && f.bias === hit.bias && c.now - Date.parse(f.at) < 12 * 3600_000)) continue;
    const confidence = learnedConfidence(r.baseConfidence, stats[r.id]);
    out.push({ id: `${r.id}-${new Date(c.now).toISOString()}`, at: new Date(c.now).toISOString(), rule: r.id, bias: hit.bias, baseConfidence: r.baseConfidence, confidence,
      horizonHours: r.horizonHours, regime: c.regime, reason: hit.reason, xau0: c.xau,
      trigger: { oil24h: c.oil24h ?? null, oilZ30: c.oilZ30 ?? null, fedImplied5d: c.fedImplied5d ?? null, us10y5d: c.us10y5d ?? null, us30y: c.us30y ?? null, dxy5d: c.dxy5d ?? null } });
  }
  return out;
}

/** Weighted vote of the active (unresolved) fires; disabled rules are shown but do not vote. */
export function aggregate(active: RuleFire[], stats: RuleStats): { bias: Bias; confidence: number; votes: string[] } {
  // Fiscal override (owner rule): with the 30Y above 5.3% the oil→rate rule does not vote.
  const fiscal = active.some((f) => f.rule === "R8");
  const voting = active.filter((f) => !ruleDisabled(stats[f.rule]) && f.bias !== "NEUTRAL" && !(fiscal && f.rule === "R1"));
  const total = voting.reduce((a, f) => a + f.confidence, 0);
  if (!total) return { bias: "NEUTRAL", confidence: 0, votes: [] };
  const net = voting.reduce((a, f) => a + (f.bias === "BULLISH" ? 1 : -1) * f.confidence, 0) / total;
  return { bias: net > 0.3 ? "BULLISH" : net < -0.3 ? "BEARISH" : "NEUTRAL", confidence: +Math.min(1, total).toFixed(2), votes: voting.map((f) => `${f.rule}:${f.bias}:${f.confidence}`) };
}

export function resolveFire(f: RuleFire, xauNow: number | undefined, now: number): RuleFire {
  if (f.resolved || xauNow === undefined || f.xau0 === undefined || now < Date.parse(f.at) + f.horizonHours * 3600_000) return f;
  const pct = (xauNow - f.xau0) / f.xau0 * 100;
  const correct = f.bias === "NEUTRAL" ? Math.abs(pct) < 0.5 : Math.abs(pct) >= 0.2 && (f.bias === "BULLISH") === (pct > 0);
  return { ...f, resolved: true, outcomePct: +pct.toFixed(3), correct };
}
export function statsFrom(fires: RuleFire[]): RuleStats {
  const s: RuleStats = {};
  for (const f of fires) {
    if (!f.resolved) continue;
    const r = (s[f.rule] ??= { n: 0, hits: 0, byRegime: {} });
    r.n++; if (f.correct) r.hits++;
    const g = (r.byRegime[f.regime] ??= { n: 0, hits: 0 }); g.n++; if (f.correct) g.hits++;
  }
  return s;
}

// ---------- battle tracker ----------
export type Camp = { camp: string; strength: number; direction: "BULLISH" | "BEARISH" | "NEUTRAL"; note: string };
export function battle(c: RuleContext, linkage: LinkageReading, goldFlowNews30d: number, xau20d?: number, xauZ20?: number): { camps: Camp[]; net: number; leader: string } {
  const s = (v: number) => Math.round(Math.max(0, Math.min(100, v)));
  const camps: Camp[] = [
    { camp: "Bank sentral (struktural)", strength: s((linkage.score < 0 ? -linkage.score * 60 : 0) + Math.min(40, goldFlowNews30d * 5)), direction: "BULLISH",
      note: `${goldFlowNews30d} berita reserve buying 30h; skor linkage ${linkage.score}` },
    { camp: "Rate / Fed (siklikal)", strength: s(Math.abs(c.fedImplied5d ?? 0) * 2 + Math.abs(c.us10y5d ?? 0) + (linkage.score > 0 ? linkage.score * 40 : 0)),
      direction: (c.fedImplied5d ?? c.us10y5d ?? 0) > 2 ? "BEARISH" : (c.fedImplied5d ?? c.us10y5d ?? 0) < -2 ? "BULLISH" : "NEUTRAL",
      note: `fed funds implied 5h ${c.fedImplied5d?.toFixed(0) ?? "n/a"}bp, US10Y 5h ${c.us10y5d?.toFixed(0) ?? "n/a"}bp` },
    { camp: "Hedge geopolitik (intermiten)", strength: s(c.geoShare7d * 100 + Math.max(0, c.oil24h ?? 0) * 5), direction: c.geoShare7d > 0.15 ? "BULLISH" : "NEUTRAL",
      note: `porsi berita geo ${(c.geoShare7d * 100).toFixed(0)}% (sebelumnya ${(c.geoSharePrev7d * 100).toFixed(0)}%)` },
    { camp: "Spekulan / CTA (momentum)", strength: s(Math.abs(xauZ20 ?? 0) * 30), direction: (xau20d ?? 0) > 1 ? "BULLISH" : (xau20d ?? 0) < -1 ? "BEARISH" : "NEUTRAL",
      note: `XAU 20h ${xau20d?.toFixed(1) ?? "n/a"}% (z ${xauZ20?.toFixed(1) ?? "n/a"}); ekstrem = rawan berbalik` }
  ];
  const net = camps.reduce((a, x) => a + (x.direction === "BULLISH" ? 1 : x.direction === "BEARISH" ? -1 : 0) * x.strength, 0);
  const leader = [...camps].sort((a, b) => b.strength - a.strength)[0];
  return { camps, net, leader: `${leader.camp} (${leader.direction.toLowerCase()}, ${leader.strength})` };
}

/** Context numbers for rules and battle from daily bars. */
export function ruleContext(now: number, regime: Linkage, d: Partial<Record<Asset, Bar[]>>, geoShare7d: number, geoSharePrev7d: number): RuleContext & { xau20d?: number; xauZ20?: number; us30y2d?: number } {
  const wti = d.WTI ?? [];
  const oilReturns: number[] = []; for (let i = Math.max(1, wti.length - 31); i < wti.length; i++) oilReturns.push((wti[i][1] - wti[i - 1][1]) / wti[i - 1][1] * 100);
  const oil24h = changeDays(d.WTI, "WTI", 1);
  const { mean, std } = meanStd(oilReturns.slice(0, -1));
  const xauRet: number[] = []; const xb = d.XAU ?? []; for (let i = Math.max(1, xb.length - 61); i < xb.length; i++) xauRet.push((xb[i][1] - xb[i - 1][1]) / xb[i - 1][1] * 100);
  const xau20d = changeDays(d.XAU, "XAU", 20);
  const dailyStd = meanStd(xauRet).std;
  return { now, regime, xau: last(d.XAU), oil24h, oilZ30: oil24h !== undefined && std ? (oil24h - mean) / std : undefined,
    fedImplied5d: changeDays(d.FEDFUNDS, "FEDFUNDS", 5), us10y5d: changeDays(d.US10Y, "US10Y", 5), us30y: last(d.US30Y), us30y5d: changeDays(d.US30Y, "US30Y", 5),
    us30y2d: changeDays(d.US30Y, "US30Y", 2), dxy5d: changeDays(d.DXY, "DXY", 5), geoShare7d, geoSharePrev7d,
    xau20d, xauZ20: xau20d !== undefined && dailyStd ? xau20d / (dailyStd * Math.sqrt(20)) : undefined };
}

export type MacroSnapshot = { at: string; linkage: LinkageReading; official: Linkage; officialSince: string; threshold: number;
  live?: { oil24h?: number; us30y?: number; dxy24h?: number; fedImplied5d?: number };
  rules: { bias: Bias; confidence: number; votes: string[]; active: RuleFire[] }; battle: ReturnType<typeof battle>; unavailable: string[] };

export function macroBrief(m?: MacroSnapshot): string {
  if (!m) return "MACRO: belum ada pembacaan.";
  const active = m.rules.active.map((f) => `${f.rule} ${f.bias} ${Math.round(f.confidence * 100)}% (${f.reason})`).join("; ");
  return [`MACRO_LINKAGE: rezim resmi ${m.official} sejak ${m.officialSince.slice(0, 16)}Z (bacaan terbaru ${m.linkage.regime}, skor ${m.linkage.score}, keyakinan ${m.linkage.confidence}, ambang ±${m.threshold})`,
    `Sinyal: ${m.linkage.signals.map((s) => `${s.name}=${s.value === null ? "n/a" : typeof s.value === "number" ? +s.value.toFixed(2) : s.value}`).join("; ")}`,
    `RULE_CHAIN: ${m.rules.bias} ${Math.round(m.rules.confidence * 100)}%${active ? ` — ${active}` : " — tidak ada rule aktif"}`,
    `BATTLE: ${m.battle.camps.map((c) => `${c.camp} ${c.direction.toLowerCase()} ${c.strength}`).join(" | ")}; net ${m.battle.net}; pemimpin ${m.battle.leader}`,
    `Tidak tersedia: ${m.unavailable.join("; ")}`].join("\n");
}

export const MACRO_GUIDE = `${REGIME_RULES_SUMMARY}
MACRO LINKAGE REASONING (uses MACRO_LINKAGE, RULE_CHAIN and BATTLE when supplied; evidence, never rules):
Decide which logic gold is trading. In the RATE regime, higher yields, a hawkish Fed and strong data are bearish for gold. In the CB (central-bank/debasement) regime, reserve buying and sovereign/fiscal risk absorb rate-bearish news: do not call gold bearish just because yields rose; a rate-driven dip may even attract buyers. In MIXED, lower confidence, wait for confirmation and ignore small surprises. Conflict or war headlines are not automatically bullish: oil up → inflation expectations up → rate expectations up → real yields up can push gold down; say which link dominates now and why. Use the BATTLE camps to explain who is winning, and never invent data that is marked unavailable.`;

export class MacroLedger {
  private data: { state: LinkageState; fires: RuleFire[]; snapshots: MacroSnapshot[] };
  constructor(private readonly path: string) {
    backupOnce(path);
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { state: { official: "MIXED", since: new Date().toISOString(), threshold: 0.3, falseSwitches: [], history: [], switches: [] }, fires: [], snapshots: [] };
  }
  get state(): LinkageState { return this.data.state; }
  fires(): RuleFire[] { return this.data.fires; }
  current(): MacroSnapshot | undefined { return this.data.snapshots.at(-1); }
  save(state: LinkageState, fires: RuleFire[], snapshot: MacroSnapshot): void {
    this.data = { state, fires: fires.slice(-5000), snapshots: [...this.data.snapshots, snapshot].slice(-500) };
    atomicWrite(this.path, this.data);
  }
}

/** Daily bars for the macro layer. */
export async function macroBars(fetcher: typeof fetch = fetch): Promise<Partial<Record<Asset, Bar[]>>> {
  const assets: Asset[] = ["XAU", "DXY", "US10Y", "US30Y", "WTI", "FEDFUNDS", "US2Y"];
  const out: Partial<Record<Asset, Bar[]>> = {};
  await Promise.all(assets.map(async (a) => { const b = await series(a, "1d", fetcher); if (b.length) out[a] = b; }));
  return out;
}
