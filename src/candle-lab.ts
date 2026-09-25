import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { gated } from "./yahoo.js";
import { PatternMemory } from "./pattern-memory.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

/**
 * Candle Lab — the bot's own candle experience. It records full gold OHLC candles 24/7,
 * replays the whole history walk-forward (it only ever "sees" candles before the moment it
 * predicts), and from day 8 makes live predictions every 15 minutes that are scored against
 * candles that had not happened yet. The measured track record — never a feeling — decides how
 * confident the news narrative may sound. Measurement only: no zones, entries or orders, and it
 * never changes production rules on its own.
 */
/** [time, open, high, low, close, volume?] — volume is futures contracts traded (0/absent when unknown). */
export type Candle = [t: number, o: number, h: number, l: number, c: number, v?: number];
export type Horizon = 3 | 12 | 48;
export const HORIZONS: Horizon[] = [3, 12, 48];
export const HORIZON_LABEL: Record<Horizon, string> = { 3: "15 menit", 12: "1 jam", 48: "4 jam" };
const BAR = 5 * 60_000, DAY_BARS = 288, MIN_N = 40, MIN_SCORED = 100;
type Dir = "UP" | "DOWN";
type Outcome = Dir | "FLAT" | "SKIP";

export type Features = { session: string; mom: string; vol: string; pos: string; shape: string; breakout: string; news: string; atr: number };
type FeatureKey = Exclude<keyof Features, "atr">;
export const LENSES: Array<{ id: string; name: string; keys: FeatureKey[] }> = [
  { id: "sesi-momentum", name: "sesi × momentum 1 jam", keys: ["session", "mom"] },
  { id: "posisi-vol", name: "posisi di range 24 jam × volatilitas × sesi", keys: ["pos", "vol", "session"] },
  { id: "bentuk-momentum", name: "bentuk candle 15 menit × momentum", keys: ["shape", "mom"] },
  { id: "tembus-sesi", name: "tembus high/low 24 jam × sesi", keys: ["breakout", "session"] },
  { id: "berita-momentum", name: "berita 60 menit × momentum × volatilitas", keys: ["news", "mom", "vol"] }
];
const LABEL: Record<string, string> = {
  ASIA: "sesi Asia", LONDON: "sesi London", NEWYORK: "sesi New York", SORE: "akhir sesi AS",
  TURUN_KUAT: "momentum 1 jam turun kuat", TURUN: "momentum 1 jam turun", DATAR: "momentum 1 jam datar", NAIK: "momentum 1 jam naik", NAIK_KUAT: "momentum 1 jam naik kuat",
  SEPI: "volatilitas sepi", NORMAL: "volatilitas normal", RAMAI: "volatilitas ramai",
  BAWAH: "harga dekat low 24 jam", TENGAH: "harga di tengah range 24 jam", ATAS: "harga dekat high 24 jam",
  EKOR_ATAS: "candle 15 menit berekor atas panjang (ditolak dari atas)", EKOR_BAWAH: "candle 15 menit berekor bawah panjang (ditolak dari bawah)",
  BODY_NAIK: "candle 15 menit badan naik tebal", BODY_TURUN: "candle 15 menit badan turun tebal", DOJI: "candle 15 menit doji (ragu)", BIASA: "candle 15 menit biasa",
  TEMBUS_ATAS: "baru menembus high 24 jam", TEMBUS_BAWAH: "baru menembus low 24 jam", DALAM: "masih di dalam range 24 jam",
  BERITA: "ada berita terkirim 60 menit terakhir", TANPA: "tanpa berita 60 menit terakhir"
};

export function sessionOf(t: number): string {
  const h = new Date(t).getUTCHours();
  return h >= 22 || h < 7 ? "ASIA" : h < 12 ? "LONDON" : h < 17 ? "NEWYORK" : "SORE";
}
function hasNews(sorted: number[], t: number, windowMs = 3_600_000): boolean {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo > 0 && t - sorted[lo - 1] < windowMs;
}

/** Features at candle i from candles 0..i only (no look-ahead). Needs 24h of history. */
export function features(bars: Candle[], i: number, news: number[] = []): Features | undefined {
  if (i < DAY_BARS - 1) return undefined;
  let rangeSum = 0, dayHigh = -Infinity, dayLow = Infinity, prevHigh = -Infinity, prevLow = Infinity, recentHigh = -Infinity, recentLow = Infinity, recentRange = 0;
  for (let k = i - DAY_BARS + 1; k <= i; k++) {
    const [, , h, l] = bars[k];
    rangeSum += h - l; dayHigh = Math.max(dayHigh, h); dayLow = Math.min(dayLow, l);
    if (k <= i - 12) { prevHigh = Math.max(prevHigh, h); prevLow = Math.min(prevLow, l); }
    else { recentHigh = Math.max(recentHigh, h); recentLow = Math.min(recentLow, l); recentRange += h - l; }
  }
  const atr = rangeSum / DAY_BARS;
  if (!(atr > 0)) return undefined;
  const c = bars[i][4];
  const m = (c - bars[i - 12][4]) / (atr * Math.sqrt(12));
  const mom = m <= -1.5 ? "TURUN_KUAT" : m <= -0.5 ? "TURUN" : m < 0.5 ? "DATAR" : m < 1.5 ? "NAIK" : "NAIK_KUAT";
  const v = recentRange / 12 / atr;
  const vol = v < 0.7 ? "SEPI" : v > 1.5 ? "RAMAI" : "NORMAL";
  const p = dayHigh > dayLow ? (c - dayLow) / (dayHigh - dayLow) : 0.5;
  const pos = p < 0.2 ? "BAWAH" : p > 0.8 ? "ATAS" : "TENGAH";
  const o = bars[i - 2][1], h3 = Math.max(bars[i - 2][2], bars[i - 1][2], bars[i][2]), l3 = Math.min(bars[i - 2][3], bars[i - 1][3], bars[i][3]);
  const r = h3 - l3;
  let shape = "DOJI";
  if (r > 0) {
    const body = Math.abs(c - o) / r, up = (h3 - Math.max(o, c)) / r, down = (Math.min(o, c) - l3) / r;
    shape = up >= 0.5 ? "EKOR_ATAS" : down >= 0.5 ? "EKOR_BAWAH" : body >= 0.6 ? (c > o ? "BODY_NAIK" : "BODY_TURUN") : body < 0.15 ? "DOJI" : "BIASA";
  }
  const breakout = recentHigh > prevHigh ? "TEMBUS_ATAS" : recentLow < prevLow ? "TEMBUS_BAWAH" : "DALAM";
  return { session: sessionOf(bars[i][0]), mom, vol, pos, shape, breakout, news: hasNews(news, bars[i][0]) ? "BERITA" : "TANPA", atr };
}

/** What gold did h candles later. Moves under a quarter of a normal move are FLAT; weekend gaps are SKIP. */
export function outcome(bars: Candle[], i: number, h: Horizon, atr: number): Outcome | undefined {
  const j = i + h;
  if (j >= bars.length) return undefined;
  if (bars[j][0] - bars[i][0] > h * BAR * 1.5) return "SKIP";
  const move = bars[j][4] - bars[i][4];
  if (Math.abs(move) < 0.25 * atr * Math.sqrt(h)) return "FLAT";
  return move > 0 ? "UP" : "DOWN";
}

const keyOf = (lens: (typeof LENSES)[number], f: Features) => lens.keys.map((k) => f[k]).join("|");
type Count = { up: number; down: number };
type Tally = { hit: number; miss: number };
const acc = (t: Tally) => t.hit + t.miss ? t.hit / (t.hit + t.miss) : null;

export class PatternModel {
  stats = new Map<string, Count>();
  base: Record<Horizon, Count> = { 3: { up: 0, down: 0 }, 12: { up: 0, down: 0 }, 48: { up: 0, down: 0 } };
  add(f: Features, h: Horizon, o: Dir): void {
    for (const lens of LENSES) {
      const k = `${lens.id}|${h}|${keyOf(lens, f)}`, c = this.stats.get(k) ?? { up: 0, down: 0 };
      if (o === "UP") c.up++; else c.down++;
      this.stats.set(k, c);
    }
    if (o === "UP") this.base[h].up++; else this.base[h].down++;
  }
  lens(lensId: string, f: Features, h: Horizon): { p: number; n: number } | undefined {
    const lens = LENSES.find((l) => l.id === lensId)!;
    const c = this.stats.get(`${lens.id}|${h}|${keyOf(lens, f)}`);
    const n = c ? c.up + c.down : 0;
    return c && n >= MIN_N ? { p: (c.up + 1) / (n + 2), n } : undefined;
  }
  baseline(h: Horizon): Dir { return this.base[h].up >= this.base[h].down ? "UP" : "DOWN"; }
  /** Weighted by each lens's proven edge. With no proven edge the call is still made but marked edge=false. */
  predict(f: Features, h: Horizon, weights: Record<string, number>): { p: number; n: number; edge: boolean; parts: Array<{ lens: string; p: number; n: number }> } | undefined {
    const parts = LENSES.map((l) => ({ lens: l.id, ...this.lens(l.id, f, h) })).filter((x): x is { lens: string; p: number; n: number } => x.p !== undefined);
    if (!parts.length) return undefined;
    const weighted = parts.filter((x) => (weights[`${x.lens}|${h}`] ?? 0) > 0);
    const use = weighted.length ? weighted : parts;
    const w = (x: { lens: string }) => weighted.length ? weights[`${x.lens}|${h}`] : 1;
    const total = use.reduce((s, x) => s + w(x), 0);
    return { p: use.reduce((s, x) => s + w(x) * x.p, 0) / total, n: Math.max(...use.map((x) => x.n)), edge: weighted.length > 0, parts };
  }
}

export type HorizonScore = { base: Tally; ens: Tally & { abstain: number }; lens: Record<string, Tally>; bands: Array<{ band: string; hit: number; miss: number }> };
export type ReplayResult = { candles: number; from: number; to: number; perH: Record<Horizon, HorizonScore>; weights: Record<string, number> };
const BANDS = [{ band: "50–55%", lo: 0.5, hi: 0.55 }, { band: "55–60%", lo: 0.55, hi: 0.6 }, { band: "60%+", lo: 0.6, hi: 1.01 }];
function weightsFrom(perH: Record<Horizon, HorizonScore>): Record<string, number> {
  const w: Record<string, number> = {};
  for (const h of HORIZONS) {
    const base = acc(perH[h].base) ?? 0.5;
    for (const lens of LENSES) {
      const t = perH[h].lens[lens.id];
      w[`${lens.id}|${h}`] = t.hit + t.miss >= MIN_SCORED ? Math.max(0, (acc(t) ?? 0) - base) : 0;
    }
  }
  return w;
}

/**
 * Walk-forward replay: at every candle the model predicts with only what it had learned from
 * candles whose outcome was already known at that moment, then learns from the outcome later.
 * This is the "practice" loop; running it again on the same data teaches nothing new, so it is
 * rerun as new candles arrive.
 */
export function replay(bars: Candle[], news: number[] = []): { result: ReplayResult; model: PatternModel } {
  const model = new PatternModel();
  const perH = Object.fromEntries(HORIZONS.map((h) => [h, { base: { hit: 0, miss: 0 }, ens: { hit: 0, miss: 0, abstain: 0 }, lens: Object.fromEntries(LENSES.map((l) => [l.id, { hit: 0, miss: 0 }])), bands: BANDS.map((b) => ({ band: b.band, hit: 0, miss: 0 })) }])) as Record<Horizon, HorizonScore>;
  const feats: Array<Features | undefined> = new Array(bars.length);
  type Call = { base: Dir; ens?: { dir: Dir; conf: number }; lens: Record<string, Dir> };
  const calls: Record<Horizon, Array<Call | undefined>> = { 3: [], 12: [], 48: [] };
  let weights: Record<string, number> = {};
  for (let i = 0; i < bars.length; i++) {
    for (const h of HORIZONS) {
      const r = i - h, f = r >= 0 ? feats[r] : undefined;
      if (!f) continue;
      const o = outcome(bars, r, h, f.atr);
      if (o !== "UP" && o !== "DOWN") continue;
      const call = calls[h][r], s = perH[h];
      if (call) {
        if (call.base === o) s.base.hit++; else s.base.miss++;
        for (const [id, d] of Object.entries(call.lens)) { if (d === o) s.lens[id].hit++; else s.lens[id].miss++; }
        if (call.ens) {
          const hit = call.ens.dir === o; if (hit) s.ens.hit++; else s.ens.miss++;
          const band = s.bands[BANDS.findIndex((b) => call.ens!.conf >= b.lo && call.ens!.conf < b.hi)];
          if (band) { if (hit) band.hit++; else band.miss++; }
        }
      }
      model.add(f, h, o);
    }
    if (i % 288 === 0) weights = weightsFrom(perH);
    const f = features(bars, i, news);
    feats[i] = f;
    if (!f) continue;
    for (const h of HORIZONS) {
      if (model.base[h].up + model.base[h].down < MIN_N) continue;
      const lens: Record<string, Dir> = {};
      for (const l of LENSES) { const x = model.lens(l.id, f, h); if (x && Math.abs(x.p - 0.5) >= 0.02) lens[l.id] = x.p > 0.5 ? "UP" : "DOWN"; }
      const pr = model.predict(f, h, weights);
      const conf = pr ? Math.max(pr.p, 1 - pr.p) : 0.5;
      if (!pr || conf < 0.52) perH[h].ens.abstain++;
      calls[h][i] = { base: model.baseline(h), lens, ens: pr && conf >= 0.52 ? { dir: pr.p > 0.5 ? "UP" : "DOWN", conf } : undefined };
    }
  }
  return { result: { candles: bars.length, from: bars[0]?.[0] ?? 0, to: bars.at(-1)?.[0] ?? 0, perH, weights: weightsFrom(perH) }, model };
}

export type LivePrediction = { at: number; price: number; h: Horizon; dir: Dir | "ABSTAIN"; p: number; base: Dir; atr: number; edge: boolean; result?: "HIT" | "MISS" | "FLAT" | "SKIP"; baseResult?: "HIT" | "MISS" | "FLAT" | "SKIP" };
export function scoreLive(pred: LivePrediction, bars: Candle[]): LivePrediction {
  if (pred.result) return pred;
  const due = pred.at + pred.h * BAR;
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid][0] < due) lo = mid + 1; else hi = mid; }
  const j = lo;
  if (j >= bars.length) return pred;
  if (bars[j][0] - due > 2 * BAR) return { ...pred, result: "SKIP", baseResult: "SKIP" };
  const move = bars[j][4] - pred.price;
  if (Math.abs(move) < 0.25 * pred.atr * Math.sqrt(pred.h)) return { ...pred, result: "FLAT", baseResult: "FLAT" };
  const o: Dir = move > 0 ? "UP" : "DOWN";
  return { ...pred, result: pred.dir === "ABSTAIN" ? "SKIP" : pred.dir === o ? "HIT" : "MISS", baseResult: pred.base === o ? "HIT" : "MISS" };
}
export function liveScore(preds: LivePrediction[], h: Horizon, sinceMs = 0): { n: number; acc: number | null; base: number | null } {
  const xs = preds.filter((p) => p.h === h && p.at >= sinceMs && (p.result === "HIT" || p.result === "MISS"));
  const hit = xs.filter((p) => p.result === "HIT").length, baseHit = xs.filter((p) => p.baseResult === "HIT").length;
  return { n: xs.length, acc: xs.length ? hit / xs.length : null, base: xs.length ? baseHit / xs.length : null };
}

export type Confidence = "TINGGI" | "SEDANG" | "RENDAH";
/** Earned confidence: proven in the replay AND (from day 8) holding up live, and the current setup must lean clearly. */
export function confidence(replayScore: HorizonScore | undefined, live: { n: number; acc: number | null; base: number | null }, p: number): Confidence {
  const n = replayScore ? replayScore.ens.hit + replayScore.ens.miss : 0;
  const edge = n ? (acc(replayScore!.ens) ?? 0) - (acc(replayScore!.base) ?? 0.5) : 0;
  const liveEdge = live.acc !== null && live.base !== null ? live.acc - live.base : null;
  const strength = Math.abs(p - 0.5);
  if (n >= 300 && edge >= 0.04 && live.n >= 100 && liveEdge !== null && liveEdge >= 0.03 && strength >= 0.06) return "TINGGI";
  if (n >= 300 && edge >= 0.02 && (live.n < 100 || (liveEdge ?? 0) >= 0) && strength >= 0.03) return "SEDANG";
  return "RENDAH";
}

const pct = (x: number | null | undefined) => x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`;
export function describe(f: Features): string {
  return [f.session, f.mom, f.pos, f.vol, f.shape, f.breakout, f.news].map((k) => LABEL[k] ?? k).join(", ");
}

type State = { startedAt: number; backfilled: boolean; replays: number; lastReplayAt: number; last5m: number; last1m: number; lastFetch5m: number; lastFetch1m: number; lastLiveAt: number; replay?: ReplayResult };
type ChartJson = { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Partial<Record<"open" | "high" | "low" | "close" | "volume", Array<number | null>>>> } }> } };
/** Yahoo chart JSON → complete candles only (a candle still forming at `now` is dropped). */
export function parseChart(json: unknown, stepMs: number, now: number): Candle[] {
  const res = (json as ChartJson).chart?.result?.[0], q = res?.indicators?.quote?.[0];
  const out: Candle[] = [];
  (res?.timestamp ?? []).forEach((t, i) => {
    const o = q?.open?.[i], h = q?.high?.[i], l = q?.low?.[i], c = q?.close?.[i], v = q?.volume?.[i];
    if ([o, h, l, c].every((x) => typeof x === "number" && Number.isFinite(x)) && t * 1000 + stepMs <= now)
      out.push([t * 1000, Math.round(o! * 100) / 100, Math.round(h! * 100) / 100, Math.round(l! * 100) / 100, Math.round(c! * 100) / 100, typeof v === "number" && v > 0 ? v : 0]);
  });
  return out;
}
const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
function atomicWrite(path: string, data: unknown): void { const tmp = `${path}.tmp`; writeFileSync(tmp, JSON.stringify(data)); renameSync(tmp, path); }

export class CandleLab {
  private state: State;
  private bars: Candle[] = [];
  private live: LivePrediction[] = [];
  private model?: PatternModel;
  readonly patterns: PatternMemory;
  constructor(private dir: string, private news: () => number[] = () => [], private learnDays = 7, private net: typeof fetch = gated(), private symbol = "GC=F") {
    mkdirSync(dir, { recursive: true });
    this.patterns = new PatternMemory(dir, net, symbol);
    const s = this.read<State>("state.json");
    this.state = s ?? { startedAt: Date.now(), backfilled: false, replays: 0, lastReplayAt: 0, last5m: 0, last1m: 0, lastFetch5m: 0, lastFetch1m: 0, lastLiveAt: 0 };
    const map = new Map<number, Candle>();
    for (const file of readdirSync(dir).filter((f) => /^XAU-5m-\d{4}-\d{2}\.jsonl$/.test(f)).sort())
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) { if (!line) continue; try { const c = JSON.parse(line) as Candle; map.set(c[0], c); } catch { /* torn line */ } }
    this.bars = [...map.values()].sort((a, b) => a[0] - b[0]);
    this.live = this.read<LivePrediction[]>("live.json") ?? [];
    if (!s) this.save();
  }
  private read<T>(name: string): T | undefined { const p = join(this.dir, name); if (!existsSync(p)) return undefined; try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return undefined; } }
  private save(): void { atomicWrite(join(this.dir, "state.json"), this.state); }
  day(now = Date.now()): number { return Math.floor((now - this.state.startedAt) / 86400_000) + 1; }
  candles(): Candle[] { return this.bars; }

  private async yahoo(range: string, interval: "1m" | "5m", now: number): Promise<Candle[]> {
    const r = await this.net(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(this.symbol)}?range=${range}&interval=${interval}`);
    if (!r.ok) throw new Error(`yahoo ${interval} ${range} ${r.status}`);
    const step = interval === "1m" ? 60_000 : BAR;
    return parseChart(await r.json(), step, now);
  }
  /** Append candles newer than the last stored one; returns how many were new. */
  private store(candles: Candle[], interval: "1m" | "5m"): number {
    const lastKey = interval === "1m" ? "last1m" : "last5m";
    const fresh = candles.filter((c) => c[0] > this.state[lastKey]).sort((a, b) => a[0] - b[0]);
    if (!fresh.length) return 0;
    const byMonth = new Map<string, string[]>();
    for (const c of fresh) { const m = monthOf(c[0]); byMonth.set(m, [...(byMonth.get(m) ?? []), JSON.stringify(c)]); }
    for (const [m, lines] of byMonth) appendFileSync(join(this.dir, `XAU-${interval}-${m}.jsonl`), `${lines.join("\n")}\n`);
    this.state[lastKey] = fresh.at(-1)![0];
    if (interval === "5m") this.bars.push(...fresh);
    return fresh.length;
  }

  /** Call every minute. Cheap when there is nothing to do. */
  async tick(now = Date.now()): Promise<void> {
    const s = this.state;
    if (!s.backfilled) {
      const five = await this.yahoo("60d", "5m", now).catch(() => this.yahoo("1mo", "5m", now));
      const one = await this.yahoo("5d", "1m", now).catch(() => [] as Candle[]);
      this.store(five, "5m"); this.store(one, "1m");
      s.backfilled = true; s.lastFetch5m = s.lastFetch1m = now;
      log.info({ candles5m: this.bars.length, candles1m: one.length, symbol: this.symbol }, "Candle lab backfilled");
    } else {
      if (now - s.lastFetch5m >= 5 * 60_000) {
        s.lastFetch5m = now;
        const gapH = (now - s.last5m) / 3_600_000;
        const added = this.store(await this.yahoo(gapH > 100 ? "60d" : gapH > 20 ? "5d" : "1d", "5m", now), "5m");
        if (added) this.onNewCandles(now);
      }
      if (now - s.lastFetch1m >= 2 * 60_000) {
        s.lastFetch1m = now;
        this.store(await this.yahoo((now - s.last1m) / 3_600_000 > 20 ? "5d" : "1d", "1m", now), "1m");
      }
    }
    const every = this.day(now) <= this.learnDays ? 3_600_000 : 3 * 3_600_000;
    if (this.bars.length > DAY_BARS + 200 && (now - s.lastReplayAt >= every || !this.model)) this.runReplay(now);
    this.save();
    await this.patterns.tick(now, this.bars, this.day(now) > this.learnDays);
  }
  runReplay(now = Date.now()): ReplayResult {
    const news = [...this.news()].sort((a, b) => a - b);
    const { result, model } = replay(this.bars, news);
    this.model = model; this.state.replay = result; this.state.replays++; this.state.lastReplayAt = now;
    const one = result.perH[12];
    log.info({ replay: this.state.replays, day: this.day(now), candles: result.candles, acc1h: acc(one.ens), base1h: acc(one.base), scored1h: one.ens.hit + one.ens.miss,
      acc4h: acc(result.perH[48].ens), base4h: acc(result.perH[48].base) }, "Candle lab replay");
    return result;
  }
  private onNewCandles(now: number): void {
    let scored = 0;
    this.live = this.live.map((p) => { if (p.result) return p; const x = scoreLive(p, this.bars); if (x.result) scored++; return x; });
    if (scored) { const l = liveScore(this.live, 12); log.info({ scored, live1hN: l.n, live1hAcc: l.acc, live1hBase: l.base }, "Candle lab live scored"); }
    // From day 8: one prediction per horizon every 15 minutes, made before the outcome exists.
    const last = this.bars.at(-1)!, i = this.bars.length - 1;
    if (this.day(now) > this.learnDays && this.model && last[0] % (15 * 60_000) === 0 && last[0] > this.state.lastLiveAt && now - last[0] < 15 * 60_000) {
      const f = features(this.bars, i, [...this.news()].sort((a, b) => a - b));
      if (f) for (const h of HORIZONS) {
        const pr = this.model.predict(f, h, this.state.replay?.weights ?? {});
        const conf = pr ? Math.max(pr.p, 1 - pr.p) : 0.5;
        this.live.push({ at: last[0], price: last[4], h, dir: !pr || conf < 0.52 ? "ABSTAIN" : pr.p > 0.5 ? "UP" : "DOWN", p: pr?.p ?? 0.5, base: this.model.baseline(h), atr: f.atr, edge: pr?.edge ?? false });
      }
      this.state.lastLiveAt = last[0];
    }
    if (this.live.length > 40_000) this.live = this.live.slice(-40_000);
    atomicWrite(join(this.dir, "live.json"), this.live);
  }

  /** Context for Sol when judging a news item: the current candle setup and how much its record deserves trust. */
  experience(now = Date.now()): string {
    const blocks = [this.setupBlock(now), this.patterns.context(now, this.bars)].filter(Boolean);
    if (!blocks.length) return "";
    return ["KONTEKS INTERNAL (RAHASIA, HANYA UNTUK PERTIMBANGANMU — jangan dikutip, diringkas, atau disinggung di pesan grup):", ...blocks,
      "Pakai ini HANYA untuk mengatur ketegasan narasi: tegas bila TINGGI dan searah dengan berita, hati-hati bila RENDAH, berlawanan, atau breakout BELUM DINILAI. Pesan grup tidak boleh menyebut candle, timeframe, breakout, sideways, support/resisten, statistik, zona, entry, atau perintah trading dari konteks ini."].join("\n");
  }
  private setupBlock(now: number): string {
    if (!this.model || !this.state.replay || this.bars.length < DAY_BARS) return "";
    if (now - this.bars.at(-1)![0] > 30 * 60_000) return "";
    const f = features(this.bars, this.bars.length - 1, [...this.news()].sort((a, b) => a - b));
    if (!f) return "";
    const lines = ([12, 48] as Horizon[]).map((h) => {
      const pr = this.model!.predict(f, h, this.state.replay!.weights);
      if (!pr) return `- ${HORIZON_LABEL[h]}: pola ini belum cukup sampel. Keyakinan: RENDAH.`;
      const r = this.state.replay!.perH[h], live = liveScore(this.live, h);
      const lean = pr.p > 0.5 ? `naik ${pct(pr.p)}` : `turun ${pct(1 - pr.p)}`;
      return `- ${HORIZON_LABEL[h]}: kondisi serupa historis ${lean} (n=${pr.n}${pr.edge ? "" : ", lensa belum terbukti unggul"}). Uji-maju: ${pct(acc(r.ens))} vs tebakan dasar ${pct(acc(r.base))}` +
        `${live.n ? `; live ${pct(live.acc)} vs ${pct(live.base)} (n=${live.n})` : "; live belum mulai"}. Keyakinan: ${confidence(r, live, pr.p)}.`;
    });
    return [`PENGALAMAN CANDLE EMAS (hari latihan ke-${this.day(now)}, replay ${this.state.replays}x atas ${this.bars.length} candle 5 menit):`,
      `Kondisi sekarang: ${describe(f)}.`, ...lines].join("\n");
  }
  status(now = Date.now()): string {
    const r = this.state.replay;
    const rows = HORIZONS.map((h) => {
      const s = r?.perH[h], live = liveScore(this.live, h), live7 = liveScore(this.live, h, now - 7 * 86400_000);
      const best = s ? LENSES.map((l) => ({ name: l.name, a: acc(s.lens[l.id]), n: s.lens[l.id].hit + s.lens[l.id].miss })).filter((x) => x.n >= MIN_SCORED).sort((a, b) => (b.a ?? 0) - (a.a ?? 0))[0] : undefined;
      return `${HORIZON_LABEL[h]}: replay ${pct(s ? acc(s.ens) : null)} vs dasar ${pct(s ? acc(s.base) : null)} (n=${s ? s.ens.hit + s.ens.miss : 0}, abstain ${s?.ens.abstain ?? 0})` +
        ` | live ${pct(live.acc)} vs ${pct(live.base)} (n=${live.n}; 7 hari ${pct(live7.acc)}, n=${live7.n})` + (best ? ` | lensa terbaik: ${best.name} ${pct(best.a)}` : "") +
        (s ? `\n  kalibrasi: ${s.bands.map((b) => `${b.band} → ${pct(acc(b))} (n=${b.hit + b.miss})`).join("; ")}` : "");
    });
    const day = this.day(now);
    return [`CANDLE LAB — hari ke-${day} (${day <= this.learnDays ? `fase latihan, prediksi live mulai hari ke-${this.learnDays + 1}` : "fase prediksi live"})`,
      `Candle 5m tersimpan: ${this.bars.length}${this.bars.length ? ` (${new Date(this.bars[0][0]).toISOString().slice(0, 10)} s/d ${new Date(this.bars.at(-1)![0]).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}; replay ${this.state.replays}x.`,
      ...rows, this.patterns.status()].join("\n");
  }
}
