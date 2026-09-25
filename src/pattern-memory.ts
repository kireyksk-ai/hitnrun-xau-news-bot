import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { parseChart, type Candle } from "./candle-lab.js";
import { describeNow, reportLine, study, type StructureReport } from "./market-structure.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

/**
 * Pattern Memory — the bot memorises candle SHAPES on every timeframe (5m, 15m, 1h, 4h, daily,
 * weekly). Each closed candle becomes a shape code (type × size vs that timeframe's normal range);
 * sequences of the last 1–3 shapes are stored with what the NEXT candle did. The memory is kept on
 * disk and grows forever. Every pattern is also checked walk-forward (predicted before its next
 * candle existed), so the bot knows which memorised patterns actually held up and which are noise.
 * Measurement only: no zones, entries or orders.
 */
export type TF = "M5" | "M15" | "H1" | "H4" | "D1" | "W1";
export const TFS: TF[] = ["M5", "M15", "H1", "H4", "D1", "W1"];
type Spec = { ms: number; label: string; interval?: string; backfill?: string; refresh?: string; every?: number };
const H = 3_600_000;
export const TF_SPEC: Record<TF, Spec> = {
  M5: { ms: 5 * 60_000, label: "5 menit" },
  M15: { ms: 15 * 60_000, label: "15 menit", interval: "15m", backfill: "60d", refresh: "5d", every: 15 * 60_000 },
  H1: { ms: H, label: "1 jam", interval: "60m", backfill: "730d", refresh: "5d", every: H },
  H4: { ms: 4 * H, label: "4 jam" },
  D1: { ms: 24 * H, label: "harian", interval: "1d", backfill: "10y", refresh: "3mo", every: 6 * H },
  W1: { ms: 7 * 24 * H, label: "mingguan", interval: "1wk", backfill: "20y", refresh: "1y", every: 6 * H }
};
const ATR_N = 20, MIN_N = 30;
const TYPE: Record<string, string> = { NK: "naik", TR: "turun", nk: "naik lemah", tr: "turun lemah", EA: "ekor atas", EB: "ekor bawah", DJ: "doji" };
const SIZE: Record<string, string> = { K: "kecil", S: "sedang", B: "besar" };
const POS: Record<string, string> = { ATAS: "di atas range 20 candle", TENGAH: "di tengah range 20 candle", BAWAH: "di bawah range 20 candle" };

/** Shape of one candle relative to the timeframe's normal range (ATR of the last 20 candles). */
export function candleCode(c: Candle, atr: number): string {
  const [, o, h, l, cl] = c, r = h - l;
  if (!(r > 0) || !(atr > 0)) return "DJ.K";
  const body = Math.abs(cl - o) / r, up = (h - Math.max(o, cl)) / r, dn = (Math.min(o, cl) - l) / r;
  const type = up >= 0.5 ? "EA" : dn >= 0.5 ? "EB" : body < 0.15 ? "DJ" : body >= 0.5 ? (cl > o ? "NK" : "TR") : (cl > o ? "nk" : "tr");
  const size = r < 0.6 * atr ? "K" : r > 1.4 * atr ? "B" : "S";
  return `${type}.${size}`;
}
export const codeLabel = (code: string) => { const [t, s] = code.split("."); return `${TYPE[t] ?? t} ${SIZE[s] ?? s}`; };

/** Merge 1h candles into 4h candles aligned to 00/04/08/12/16/20 UTC; only complete buckets. */
export function aggregate(bars: Candle[], ms: number, now: number): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) {
    const t = Math.floor(b[0] / ms) * ms, last = out.at(-1);
    if (last && last[0] === t) { last[2] = Math.max(last[2], b[2]); last[3] = Math.min(last[3], b[3]); last[4] = b[4]; last[5] = (last[5] ?? 0) + (b[5] ?? 0); }
    else out.push([t, b[1], b[2], b[3], b[4], b[5] ?? 0]);
  }
  return out.filter((c) => c[0] + ms <= now);
}

type Ctx = { atr: number; codes: string[]; pos: string };
function context(bars: Candle[], i: number): Ctx | undefined {
  if (i < ATR_N + 2) return undefined;
  let sum = 0, hi = -Infinity, lo = Infinity;
  for (let k = i - ATR_N + 1; k <= i; k++) { sum += bars[k][2] - bars[k][3]; hi = Math.max(hi, bars[k][2]); lo = Math.min(lo, bars[k][3]); }
  const atr = sum / ATR_N;
  if (!(atr > 0)) return undefined;
  const p = hi > lo ? (bars[i][4] - lo) / (hi - lo) : 0.5;
  return { atr, codes: [i - 2, i - 1, i].map((k) => candleCode(bars[k], atr)), pos: p > 0.8 ? "ATAS" : p < 0.2 ? "BAWAH" : "TENGAH" };
}
/** Most specific first: 3 candles, 2 candles + position, 2 candles, 1 candle. */
export function keysOf(x: Ctx): string[] {
  const [a, b, c] = x.codes;
  return [`L3:${a}>${b}>${c}`, `L2P:${x.pos}|${b}>${c}`, `L2:${b}>${c}`, `L1:${c}`];
}
type Mem = { up: number; down: number; flat: number; move: number };
type Tally = { hit: number; miss: number };
const acc = (t: Tally) => t.hit + t.miss ? t.hit / (t.hit + t.miss) : null;
const pct = (x: number | null) => x === null ? "–" : `${Math.round(x * 100)}%`;

export class Memory {
  map = new Map<string, Mem>();
  base = { up: 0, down: 0 };
  add(keys: string[], move: number): void {
    const dir = Math.abs(move) < 0.1 ? "flat" : move > 0 ? "up" : "down";
    for (const k of keys) { const m = this.map.get(k) ?? { up: 0, down: 0, flat: 0, move: 0 }; m[dir]++; m.move += move; this.map.set(k, m); }
    if (dir !== "flat") this.base[dir]++;
  }
  /** Back-off: the most specific memorised pattern with enough samples. */
  recall(keys: string[]): { key: string; p: number; n: number; avgMove: number } | undefined {
    for (const key of keys) {
      const m = this.map.get(key), n = m ? m.up + m.down : 0;
      if (m && n >= MIN_N) return { key, p: (m.up + 1) / (n + 2), n, avgMove: m.move / (m.up + m.down + m.flat) };
    }
    return undefined;
  }
  baseline(): "UP" | "DOWN" { return this.base.up >= this.base.down ? "UP" : "DOWN"; }
}

export type TfReport = { tf: TF; candles: number; patterns: number; tested: number; scored: Tally; base: Tally; abstain: number; proven: Array<{ key: string; n: number; acc: number; lean: "UP" | "DOWN" }> };
/** Walk-forward over one timeframe: predict candle i+1 from memory of outcomes known at candle i's close, then memorise. */
export function learn(bars: Candle[], tf: TF): { report: TfReport; memory: Memory } {
  const memory = new Memory(), scored = { hit: 0, miss: 0 }, base = { hit: 0, miss: 0 };
  const perPattern = new Map<string, Tally & { up: number; halves: [Tally, Tally] }>();
  let abstain = 0, prev: Ctx | undefined;
  for (let i = 0; i < bars.length - 1; i++) {
    if (prev) memory.add(keysOf(prev), (bars[i][4] - bars[i - 1][4]) / prev.atr);
    const x = context(bars, i);
    prev = x;
    if (!x) continue;
    const move = (bars[i + 1][4] - bars[i][4]) / x.atr;
    if (Math.abs(move) < 0.1) continue;
    const out = move > 0 ? "UP" : "DOWN", r = memory.recall(keysOf(x));
    if (memory.base.up + memory.base.down >= MIN_N) { if (memory.baseline() === out) base.hit++; else base.miss++; }
    if (!r || Math.abs(r.p - 0.5) < 0.03) { abstain++; continue; }
    const call = r.p > 0.5 ? "UP" : "DOWN", hit = call === out;
    if (hit) scored.hit++; else scored.miss++;
    const t = perPattern.get(r.key) ?? { hit: 0, miss: 0, up: 0, halves: [{ hit: 0, miss: 0 }, { hit: 0, miss: 0 }] };
    const half = t.halves[i < bars.length / 2 ? 0 : 1];
    if (hit) { t.hit++; half.hit++; } else { t.miss++; half.miss++; } if (call === "UP") t.up++;
    perPattern.set(r.key, t);
  }
  const b = acc(base) ?? 0.5;
  // "Proven" must survive chance: hundreds of patterns are tested, so a few look good by luck.
  // Require a clear statistical margin (z >= 2.5) AND the edge in both halves of the history.
  const proven = [...perPattern].filter(([, t]) => {
    const n = t.hit + t.miss, a = acc(t) ?? 0, z = (a - b) / Math.sqrt(b * (1 - b) / Math.max(n, 1));
    return n >= 50 && z >= 2.5 && t.halves.every((h) => h.hit + h.miss >= 15 && (acc(h) ?? 0) >= b + 0.03);
  })
    .map(([key, t]) => ({ key, n: t.hit + t.miss, acc: acc(t)!, lean: (t.up * 2 >= t.hit + t.miss ? "UP" : "DOWN") as "UP" | "DOWN" }))
    .sort((x, y) => y.acc - x.acc).slice(0, 8);
  return { report: { tf, candles: bars.length, patterns: memory.map.size, tested: perPattern.size, scored, base, abstain, proven }, memory };
}

export function describeKey(key: string): string {
  const [level, rest] = key.split(":");
  if (level === "L2P") { const [pos, seq] = rest.split("|"); return `${seq.split(">").map(codeLabel).join(" → ")} (${POS[pos] ?? pos})`; }
  return rest.split(">").map(codeLabel).join(" → ");
}

type Live = { tf: TF; at: number; close: number; atr: number; dir: "UP" | "DOWN" | "ABSTAIN"; base: "UP" | "DOWN"; result?: "HIT" | "MISS" | "FLAT"; baseResult?: "HIT" | "MISS" | "FLAT" };
type PState = { last: Partial<Record<TF, number>>; fetched: Partial<Record<TF, number>>; backfilled: Partial<Record<TF, boolean>>; learnedAt: Partial<Record<TF, number>>; reports: Partial<Record<TF, TfReport>>; structure?: Partial<Record<TF, StructureReport>> };
function atomicWrite(path: string, data: unknown): void { const tmp = `${path}.tmp`; writeFileSync(tmp, JSON.stringify(data)); renameSync(tmp, path); }

export class PatternMemory {
  private state: PState;
  private bars: Partial<Record<TF, Candle[]>> = {};
  private mem: Partial<Record<TF, Memory>> = {};
  private live: Live[];
  constructor(private dir: string, private net: typeof fetch, private symbol = "GC=F") {
    mkdirSync(dir, { recursive: true });
    this.state = this.read<PState>("patterns-state.json") ?? { last: {}, fetched: {}, backfilled: {}, learnedAt: {}, reports: {} };
    for (const tf of ["M15", "H1", "D1", "W1"] as TF[]) {
      const p = join(dir, `XAU-${tf}.jsonl`), map = new Map<number, Candle>();
      if (existsSync(p)) for (const line of readFileSync(p, "utf8").split("\n")) { if (!line) continue; try { const c = JSON.parse(line) as Candle; map.set(c[0], c); } catch { /* torn line */ } }
      this.bars[tf] = [...map.values()].sort((a, b) => a[0] - b[0]);
    }
    this.live = this.read<Live[]>("patterns-live.json") ?? [];
  }
  private read<T>(name: string): T | undefined { const p = join(this.dir, name); if (!existsSync(p)) return undefined; try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return undefined; } }
  private async yahoo(interval: string, range: string, ms: number, now: number): Promise<Candle[]> {
    const r = await this.net(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(this.symbol)}?range=${range}&interval=${interval}`);
    if (!r.ok) throw new Error(`yahoo ${interval} ${range} ${r.status}`);
    return parseChart(await r.json(), ms, now);
  }
  series(tf: TF, m5: Candle[], now: number): Candle[] {
    if (tf === "M5") return m5;
    if (tf === "H4") return aggregate(this.bars.H1 ?? [], TF_SPEC.H4.ms, now);
    return this.bars[tf] ?? [];
  }

  /** Call every minute with the 5m candles from Candle Lab. liveOn = past the practice week. */
  async tick(now: number, m5: Candle[], liveOn: boolean): Promise<void> {
    const s = this.state;
    for (const tf of ["M15", "H1", "D1", "W1"] as TF[]) {
      const spec = TF_SPEC[tf];
      if (s.backfilled[tf] && now - (s.fetched[tf] ?? 0) < spec.every!) continue;
      try {
        const got = await this.yahoo(spec.interval!, s.backfilled[tf] ? spec.refresh! : spec.backfill!, spec.ms, now);
        s.fetched[tf] = now;
        const fresh = got.filter((c) => c[0] > (s.last[tf] ?? 0));
        if (fresh.length) {
          appendFileSync(join(this.dir, `XAU-${tf}.jsonl`), `${fresh.map((c) => JSON.stringify(c)).join("\n")}\n`);
          this.bars[tf] = [...(this.bars[tf] ?? []), ...fresh]; s.last[tf] = fresh.at(-1)![0];
        }
        if (!s.backfilled[tf]) { s.backfilled[tf] = true; log.info({ tf, candles: this.bars[tf]!.length }, "Pattern memory backfilled"); }
      } catch (error) { s.fetched[tf] = now; log.warn({ err: error, tf }, "Pattern memory fetch failed"); }
    }
    for (const tf of TFS) {
      const bars = this.series(tf, m5, now), lastT = bars.at(-1)?.[0] ?? 0;
      if (bars.length < ATR_N + 60) continue;
      // Re-learn when this timeframe has a new closed candle (M5 at most every 30 minutes).
      const learnedT = s.learnedAt[tf] ?? 0;
      if (!this.mem[tf] || (lastT > learnedT && (tf !== "M5" || lastT - learnedT >= 30 * 60_000))) {
        const { report, memory } = learn(bars, tf);
        this.mem[tf] = memory; s.reports[tf] = report; s.learnedAt[tf] = lastT;
        (s.structure ??= {})[tf] = study(bars);
        atomicWrite(join(this.dir, `patterns-${tf}.json`), { tf, updatedAt: new Date(now).toISOString(), candles: bars.length, base: memory.base, patterns: Object.fromEntries(memory.map) });
      }
      this.scoreAndPredict(tf, bars, liveOn);
    }
    if (this.live.length > 40_000) this.live = this.live.slice(-40_000);
    atomicWrite(join(this.dir, "patterns-live.json"), this.live);
    atomicWrite(join(this.dir, "patterns-state.json"), s);
  }
  private scoreAndPredict(tf: TF, bars: Candle[], liveOn: boolean): void {
    const lastT = bars.at(-1)?.[0];
    if (lastT === undefined) return;
    for (const p of this.live) {
      if (p.tf !== tf || p.result) continue;
      const next = bars.find((c) => c[0] > p.at);
      if (!next) continue;
      const move = (next[4] - p.close) / p.atr;
      if (Math.abs(move) < 0.1) { p.result = "FLAT"; p.baseResult = "FLAT"; continue; }
      const out = move > 0 ? "UP" : "DOWN";
      p.result = p.dir === "ABSTAIN" ? "FLAT" : p.dir === out ? "HIT" : "MISS";
      p.baseResult = p.base === out ? "HIT" : "MISS";
    }
    const memory = this.mem[tf];
    if (!liveOn || !memory || this.live.some((p) => p.tf === tf && p.at === lastT)) return;
    const x = context(bars, bars.length - 1);
    if (!x) return;
    const r = memory.recall(keysOf(x));
    this.live.push({ tf, at: lastT, close: bars.at(-1)![4], atr: x.atr, dir: !r || Math.abs(r.p - 0.5) < 0.03 ? "ABSTAIN" : r.p > 0.5 ? "UP" : "DOWN", base: memory.baseline() });
  }
  liveScore(tf: TF): { n: number; acc: number | null; base: number | null } {
    const xs = this.live.filter((p) => p.tf === tf && (p.result === "HIT" || p.result === "MISS"));
    return { n: xs.length, acc: xs.length ? xs.filter((p) => p.result === "HIT").length / xs.length : null, base: xs.length ? xs.filter((p) => p.baseResult === "HIT").length / xs.length : null };
  }
  /** Earned label per timeframe: proven walk-forward AND (after the practice week) holding up live. */
  label(tf: TF, p: number, key?: string): "TINGGI" | "SEDANG" | "RENDAH" {
    const rep = this.state.reports[tf], live = this.liveScore(tf);
    if (!rep) return "RENDAH";
    const n = rep.scored.hit + rep.scored.miss, edge = (acc(rep.scored) ?? 0) - (acc(rep.base) ?? 0.5), strength = Math.abs(p - 0.5);
    const liveEdge = live.acc !== null && live.base !== null ? live.acc - live.base : null;
    // A single memorised pattern that passed the strict test can carry the call even when the timeframe overall cannot.
    if (key && strength >= 0.06 && rep.proven.some((x) => x.key === key && x.lean === (p > 0.5 ? "UP" : "DOWN")))
      return live.n >= 50 && (liveEdge ?? -1) >= 0.03 ? "TINGGI" : live.n >= 50 && (liveEdge ?? 0) < 0 ? "RENDAH" : "SEDANG";
    if (n >= 300 && edge >= 0.04 && live.n >= 50 && (liveEdge ?? -1) >= 0.03 && strength >= 0.06) return "TINGGI";
    if (n >= 300 && edge >= 0.02 && (live.n < 50 || (liveEdge ?? 0) >= 0) && strength >= 0.03) return "SEDANG";
    return "RENDAH";
  }

  /** What the last candles on every timeframe look like and what memory says came next. */
  context(now: number, m5: Candle[]): string {
    const lines: string[] = [];
    for (const tf of TFS) {
      const bars = this.series(tf, m5, now), memory = this.mem[tf];
      if (!memory || bars.length < ATR_N + 3 || now - bars.at(-1)![0] > TF_SPEC[tf].ms * 3 + 3 * 24 * H) continue;
      const x = context(bars, bars.length - 1);
      if (!x) continue;
      const r = memory.recall(keysOf(x)), rep = this.state.reports[tf]!;
      const shape = x.codes.map(codeLabel).join(" → ");
      lines.push(!r ? `- ${TF_SPEC[tf].label}: ${shape}; pola ini belum cukup sering muncul di hafalan.`
        : `- ${TF_SPEC[tf].label}: ${shape} (${POS[x.pos]}). Hafalan: muncul ${r.n}x, candle berikutnya naik ${pct(r.p)} / turun ${pct(1 - r.p)}. ` +
          `${rep.proven.some((x) => x.key === r.key) ? "Pola ini TERBUKTI di uji-maju. " : ""}Uji-maju TF ini ${pct(acc(rep.scored))} vs dasar ${pct(acc(rep.base))}. Keyakinan: ${this.label(tf, r.p, r.key)}.`);
      const st = this.state.structure?.[tf];
      const now2 = st && tf !== "W1" ? describeNow(bars, st, TF_SPEC[tf].ms) : "";
      if (now2) lines.push(`  struktur ${TF_SPEC[tf].label}: ${now2}.`);
    }
    return lines.length ? ["POLA BENTUK & STRUKTUR CANDLE PER TIMEFRAME (hafalan + uji-maju; ukuran relatif, tanpa level harga):", ...lines].join("\n") : "";
  }
  status(): string {
    return ["HAFALAN POLA PER TIMEFRAME:", ...TFS.map((tf) => {
      const r = this.state.reports[tf], live = this.liveScore(tf);
      if (!r) return `${TF_SPEC[tf].label}: belum ada data`;
      const best = r.proven[0];
      return `${TF_SPEC[tf].label}: ${r.candles} candle, ${r.patterns} pola dihafal; uji-maju ${pct(acc(r.scored))} vs dasar ${pct(acc(r.base))} (n=${r.scored.hit + r.scored.miss})` +
        ` | live ${pct(live.acc)} vs ${pct(live.base)} (n=${live.n}) | pola terbukti: ${r.proven.length} dari ${r.tested ?? 0} yang dites${best ? ` (terbaik: ${describeKey(best.key)} → ${best.lean === "UP" ? "naik" : "turun"} ${pct(best.acc)}, n=${best.n})` : ""}` + (this.state.structure?.[tf] ? `\n  struktur: ${reportLine(this.state.structure[tf]!)}` : "");
    })].join("\n");
  }
}
