import type { Candle } from "./candle-lab.js";

/**
 * Market Structure — reads HOW price moves, not just which way:
 *  - strength of every candle (body vs normal range × volume vs normal volume) and whether a push is gaining or fading;
 *  - sideways boxes: how long price has been ranging and how tight;
 *  - support / resistance from swing points: how long a level has held and how many times it was tested;
 *  - breakouts (close outside the box) and whether they turned out real or false;
 *  - stop hunts / "manipulation": a wick through the box that closes back inside.
 * Every event is predicted at the moment it happens from statistics of EARLIER events only, then scored
 * when its outcome is known (walk-forward). Nothing here gives levels, zones or orders to the group.
 */
const ATR_N = 20, VOL_N = 20, BOX_MIN = 12, BOX_W = 3, BOX_LOOKBACK = 240, BREAK = 0.2, HORIZON = 24;
const LEVEL_TOL = 0.25, LEVEL_BREAK = 0.3, BOUNCE = 1.5, PIVOT = 3, MAX_LEVELS = 30;

export type Prep = { atr: number[]; vavg: number[]; hasVolume: boolean };
export function prep(bars: Candle[]): Prep {
  const atr: number[] = new Array(bars.length).fill(NaN), vavg: number[] = new Array(bars.length).fill(NaN);
  let rs = 0, vs = 0, vn = 0;
  for (let i = 0; i < bars.length; i++) {
    rs += bars[i][2] - bars[i][3]; if (i >= ATR_N) rs -= bars[i - ATR_N][2] - bars[i - ATR_N][3];
    if (i >= ATR_N - 1) atr[i] = rs / ATR_N;
    const v = bars[i][5] ?? 0; vs += v; vn += v > 0 ? 1 : 0;
    if (i >= VOL_N) { const old = bars[i - VOL_N][5] ?? 0; vs -= old; vn -= old > 0 ? 1 : 0; }
    // Average of the PREVIOUS candles, so a volume spike is measured against what came before it.
    if (i >= VOL_N) vavg[i] = vn >= VOL_N * 0.8 ? (vs - v) / Math.max(1, vn - (v > 0 ? 1 : 0)) : NaN;
  }
  return { atr, vavg, hasVolume: bars.slice(-200).filter((b) => (b[5] ?? 0) > 0).length > 150 };
}

export type Strength = { body: number; relVol: number | null; score: number; label: "LEMAH" | "NORMAL" | "KUAT" | "SANGAT_KUAT"; trend: "MENGUAT" | "MELEMAH" | "CAMPUR" };
export function strength(bars: Candle[], i: number, p: Prep): Strength | undefined {
  const atr = p.atr[i];
  if (!(atr > 0)) return undefined;
  const [, o, , , c, v] = bars[i];
  const body = (c - o) / atr, relVol = p.vavg[i] > 0 && (v ?? 0) > 0 ? v! / p.vavg[i] : null;
  const score = Math.abs(body) * (relVol === null ? 1 : Math.min(Math.max(relVol, 0.3), 3));
  const label = score < 0.4 ? "LEMAH" : score < 1 ? "NORMAL" : score < 1.8 ? "KUAT" : "SANGAT_KUAT";
  let trend: Strength["trend"] = "CAMPUR";
  if (i >= 2) {
    const b = [i - 2, i - 1, i].map((k) => (bars[k][4] - bars[k][1]) / atr);
    if (b.every((x) => x > 0) || b.every((x) => x < 0)) {
      const a = b.map(Math.abs);
      trend = a[2] > a[1] && a[1] > a[0] ? "MENGUAT" : a[2] < a[1] && a[1] < a[0] ? "MELEMAH" : "CAMPUR";
    }
  }
  return { body, relVol, score, label, trend };
}

export type Box = { hi: number; lo: number; len: number; width: number; topTests: number; bottomTests: number; sweptTop: boolean; sweptBottom: boolean };
/** The sideways box that ended at candle `end` (inclusive): the longest stretch whose range stays within BOX_W × ATR. */
export function boxBefore(bars: Candle[], end: number, p: Prep): Box | undefined {
  const atr = p.atr[end];
  if (!(atr > 0)) return undefined;
  let hi = -Infinity, lo = Infinity, len = 0;
  for (let k = end; k >= Math.max(0, end - BOX_LOOKBACK); k--) {
    const h = Math.max(hi, bars[k][2]), l = Math.min(lo, bars[k][3]);
    if (h - l > BOX_W * atr) break;
    hi = h; lo = l; len++;
  }
  if (len < BOX_MIN) return undefined;
  let topTests = 0, bottomTests = 0, lastTop = -9, lastBottom = -9, sweptTop = false, sweptBottom = false;
  for (let k = end - len + 1; k <= end; k++) {
    if (bars[k][2] >= hi - LEVEL_TOL * atr && k - lastTop >= 3) { topTests++; lastTop = k; }
    if (bars[k][3] <= lo + LEVEL_TOL * atr && k - lastBottom >= 3) { bottomTests++; lastBottom = k; }
  }
  // A recent wick beyond an earlier part of the box that closed back inside = a sweep inside the range.
  const mid = end - Math.floor(len / 2);
  let hiA = -Infinity, loA = Infinity;
  for (let k = end - len + 1; k <= mid; k++) { hiA = Math.max(hiA, bars[k][2]); loA = Math.min(loA, bars[k][3]); }
  for (let k = mid + 1; k <= end; k++) {
    if (bars[k][2] > hiA + BREAK * atr && bars[k][4] < hiA) sweptTop = true;
    if (bars[k][3] < loA - BREAK * atr && bars[k][4] > loA) sweptBottom = true;
  }
  return { hi, lo, len, width: (hi - lo) / atr, topTests, bottomTests, sweptTop, sweptBottom };
}

export type EventKind = "BREAKOUT" | "SWEEP";
export type BoxEvent = { i: number; kind: EventKind; side: "UP" | "DOWN"; box: Box; str: Strength; keys: string[]; traps: string[] };
/**
 * Every move is a suspect. Signs that a breakout may be a trap, read from the breakout candle and its box only.
 * (For a sweep the same signs describe how convincing the rejection is.)
 */
export function trapSigns(bars: Candle[], i: number, side: "UP" | "DOWN", box: Box, str: Strength): string[] {
  const [t, o, h, l, c] = bars[i], r = h - l, signs: string[] = [];
  if (str.relVol !== null && str.relVol < 1) signs.push("volume tipis");
  if (r > 0 && (side === "UP" ? h - Math.max(o, c) : Math.min(o, c) - l) / r >= 0.4) signs.push("ekor penolakan panjang");
  if (Math.abs(str.body) < 0.6) signs.push("badan candle kecil");
  if (box.len < 24) signs.push("range baru sebentar");
  if ((side === "UP" ? box.topTests : box.bottomTests) <= 1) signs.push("level belum teruji");
  if (str.trend === "MELEMAH") signs.push("dorongan melemah");
  const hr = new Date(t).getUTCHours();
  if (hr >= 22 || hr < 6) signs.push("sesi sepi (Asia awal)");
  return signs;
}
const trapB = (n: number) => n <= 1 ? "TANDA_0-1" : n === 2 ? "TANDA_2" : "TANDA_3+";
const durB = (len: number) => len < 24 ? "PENDEK" : len < 72 ? "SEDANG" : "PANJANG";
const testB = (n: number) => n <= 1 ? "1x" : n === 2 ? "2x" : n === 3 ? "3x" : "4x+";
const volB = (v: number | null) => v === null ? "VOL_NA" : v < 1 ? "VOL_RENDAH" : v < 1.8 ? "VOL_NORMAL" : "VOL_TINGGI";
/** Breakout or sweep at candle i against the box that ended at i-1. */
export function eventAt(bars: Candle[], i: number, p: Prep): BoxEvent | undefined {
  const box = i > 0 ? boxBefore(bars, i - 1, p) : undefined, str = strength(bars, i, p), atr = p.atr[i - 1];
  if (!box || !str || !(atr > 0)) return undefined;
  const [, , h, l, c] = bars[i];
  let kind: EventKind | undefined, side: "UP" | "DOWN" | undefined;
  if (c > box.hi + BREAK * atr) { kind = "BREAKOUT"; side = "UP"; }
  else if (c < box.lo - BREAK * atr) { kind = "BREAKOUT"; side = "DOWN"; }
  else if (h > box.hi + BREAK * atr && c < box.hi) { kind = "SWEEP"; side = "UP"; }
  else if (l < box.lo - BREAK * atr && c > box.lo) { kind = "SWEEP"; side = "DOWN"; }
  if (!kind || !side) return undefined;
  const tests = side === "UP" ? box.topTests : box.bottomTests;
  const priorSweep = side === "UP" ? box.sweptBottom : box.sweptTop;
  const d = durB(box.len), t = testB(tests), v = volB(str.relVol), s = str.label, sw = priorSweep ? "ADA_SAPU_SEBERANG" : "TANPA_SAPU";
  const k = `${kind}`, traps = trapSigns(bars, i, side, box, str), tb = trapB(traps.length);
  return { i, kind, side, box, str, traps, keys: [`${k}|${d}|${t}|${s}|${v}`, `${k}|${t}|${v}`, `${k}|${s}|${v}`, `${k}|${tb}`, `${k}|${d}|${sw}`, `${k}|${t}`, `${k}|${d}`, k] };
}
/**
 * Outcome within HORIZON candles. Breakout: REAL if price extends a further 1 ATR beyond the breakout candle's
 * CLOSE before closing back inside the box, FALSE if it closes back inside first (measured from the close so a
 * big breakout candle is not "real" just because it is already far from the edge). Sweep: REVERSAL if price travels 1 ATR the other way before
 * exceeding the sweep wick, FAIL otherwise.
 */
export function eventOutcome(bars: Candle[], e: BoxEvent, p: Prep, limit = bars.length - 1): "REAL" | "FALSE" | undefined {
  const atr = p.atr[e.i - 1], up = e.side === "UP";
  const edge = up ? e.box.hi : e.box.lo, wick = up ? bars[e.i][2] : bars[e.i][3], from = bars[e.i][4];
  for (let k = e.i + 1; k <= Math.min(limit, e.i + HORIZON); k++) {
    const [, , h, l, c] = bars[k];
    if (e.kind === "BREAKOUT") {
      if (up ? h >= from + atr : l <= from - atr) return "REAL";
      if (up ? c < edge : c > edge) return "FALSE";
    } else {
      if (up ? l <= from - atr : h >= from + atr) return "REAL";
      if (up ? h > wick : l < wick) return "FALSE";
    }
  }
  return e.i + HORIZON <= limit ? "FALSE" : undefined;
}

/** Candles the bot waits before judging a breakout: it thinks while the market shows its hand. */
export const CONFIRM = [1, 2, 3] as const;
export type ConfirmState = "GAGAL" | "RETEST_OK" | "MELAJU" | "DIAM";
/** How the breakout behaved during the first c candles after it (only candles up to e.i + c are used). */
export function confirmState(bars: Candle[], e: BoxEvent, c: number, p: Prep): ConfirmState {
  const atr = p.atr[e.i - 1], up = e.side === "UP", edge = up ? e.box.hi : e.box.lo, from = bars[e.i][4];
  let retest = false;
  for (let k = e.i + 1; k <= e.i + c; k++) {
    const [, , h, l, cl] = bars[k];
    if (up ? cl < edge : cl > edge) return "GAGAL";
    if (up ? l <= edge + LEVEL_TOL * atr : h >= edge - LEVEL_TOL * atr) retest = true;
  }
  const now = bars[e.i + c][4];
  if (up ? now > from + 0.3 * atr : now < from - 0.3 * atr) return "MELAJU";
  return retest ? "RETEST_OK" : "DIAM";
}
/** Outcome judged from the moment of the confirmed judgement (candle e.i + c): the late entry must still pay 1 ATR. */
export function confirmOutcome(bars: Candle[], e: BoxEvent, c: number, p: Prep, limit = bars.length - 1): "REAL" | "FALSE" | undefined {
  const atr = p.atr[e.i - 1], up = e.side === "UP", edge = up ? e.box.hi : e.box.lo, from = bars[e.i + c][4];
  for (let k = e.i + c + 1; k <= Math.min(limit, e.i + c + HORIZON); k++) {
    const [, , h, l, cl] = bars[k];
    if (up ? h >= from + atr : l <= from - atr) return "REAL";
    if (up ? cl < edge : cl > edge) return "FALSE";
  }
  return e.i + c + HORIZON <= limit ? "FALSE" : undefined;
}
export const confirmKeys = (c: number, st: ConfirmState, e: BoxEvent) => [`CONF${c}|${st}|${trapB(e.traps.length)}`, `CONF${c}|${st}`, `CONF${c}`];

type Level = { price: number; kind: "SUPPORT" | "RESISTANCE"; born: number; touches: number; lastTouch: number; pending?: { touch: number; at: number; keys: string[]; call?: "HOLD" | "BREAK" } };
const ageB = (n: number) => n < 24 ? "MUDA" : n < 96 ? "MATANG" : "TUA";
function touchKeys(l: Level, i: number, str?: Strength): string[] {
  const t = testB(l.touches), a = ageB(i - l.born), v = volB(str?.relVol ?? null);
  return [`TOUCH|${l.kind}|${t}|${a}|${v}`, `TOUCH|${l.kind}|${t}|${a}`, `TOUCH|${t}|${a}`, `TOUCH|${t}`, "TOUCH"];
}

export type Tally = { a: number; b: number };
export type StructureReport = {
  candles: number; hasVolume: boolean;
  events: Record<string, Tally>; // key → a = REAL/HOLD, b = FALSE/BREAK
  calls: { breakout: { hit: number; miss: number; base: number }; sweep: { hit: number; miss: number; base: number }; touch: { hit: number; miss: number; base: number } };
  breaksAfter: number[]; // how many tests a level took before it gave way (index = tests, value = count)
  holdsAt: number[]; // how many tests at which a level bounced
  boxLens: number[]; // lengths of boxes that ended in a real breakout
  /** Judging immediately (c=0) vs after waiting c candles: accuracy of the call and how many breakouts were already exposed as false. */
  confirm?: Record<string, { hit: number; miss: number; base: number; exposed: number; total: number }>;
};
const MIN_N = 20;
const rate = (t?: Tally) => t && t.a + t.b ? t.a / (t.a + t.b) : null;
/** Most specific statistic with enough samples. */
export function recall(events: Record<string, Tally>, keys: string[]): { key: string; rate: number; n: number } | undefined {
  for (const key of keys) { const t = events[key]; if (t && t.a + t.b >= MIN_N) return { key, rate: (t.a + 1) / (t.a + t.b + 2), n: t.a + t.b }; }
  return undefined;
}

/** One walk-forward pass over a timeframe's candles: events and level tests are predicted before their outcome is known. */
export function study(bars: Candle[]): StructureReport {
  const p = prep(bars);
  const rep: StructureReport = { candles: bars.length, hasVolume: p.hasVolume, events: {},
    calls: { breakout: { hit: 0, miss: 0, base: 0 }, sweep: { hit: 0, miss: 0, base: 0 }, touch: { hit: 0, miss: 0, base: 0 } }, breaksAfter: [], holdsAt: [], boxLens: [], confirm: {} };
  const add = (keys: string[], good: boolean) => { for (const k of keys) { const t = rep.events[k] ?? { a: 0, b: 0 }; if (good) t.a++; else t.b++; rep.events[k] = t; } };
  const pendingEvents: Array<{ e: BoxEvent; call?: boolean; baseCall?: boolean }> = [];
  let pendingConf: Array<{ e: BoxEvent; c: number; keys: string[]; call?: boolean; baseCall?: boolean; done?: boolean }> = [];
  let levels: Level[] = [];
  for (let i = ATR_N + 1; i < bars.length; i++) {
    const atr = p.atr[i];
    if (!(atr > 0)) continue;
    // 0) Confirmation first (so a breakout that fails on this very candle is counted as exposed): wait c candles, then judge.
    for (const pc of pendingConf) {
      if (pc.done) continue;
      const out = confirmOutcome(bars, pc.e, pc.c, p, i);
      if (!out) continue;
      pc.done = true;
      const good = out === "REAL", t = rep.confirm![`${pc.c}`];
      if (pc.call !== undefined) { if (pc.call === good) t.hit++; else t.miss++; if (pc.baseCall === good) t.base++; }
      add(pc.keys, good);
    }
    for (const pe of pendingEvents) {
      if (pe.e.kind !== "BREAKOUT") continue;
      const c = i - pe.e.i;
      if (!(CONFIRM as readonly number[]).includes(c)) continue;
      const t = rep.confirm![`${c}`] ??= { hit: 0, miss: 0, base: 0, exposed: 0, total: 0 };
      t.total++;
      const st = confirmState(bars, pe.e, c, p);
      if (st === "GAGAL") { t.exposed++; continue; }
      const keys = confirmKeys(c, st, pe.e), r = recall(rep.events, keys), overall = rate(rep.events[`CONF${c}`]);
      pendingConf.push({ e: pe.e, c, keys, call: r ? r.rate >= 0.5 : undefined, baseCall: overall === null ? undefined : overall >= 0.5 });
    }
    if (pendingConf.length > 500) pendingConf = pendingConf.filter((x) => !x.done);
    // 1) Resolve box events whose outcome is now known (only candles up to i are used).
    for (let x = pendingEvents.length - 1; x >= 0; x--) {
      const pe = pendingEvents[x];
      const out = eventOutcome(bars, pe.e, p, i);
      if (!out) continue;
      const good = out === "REAL", c = pe.e.kind === "BREAKOUT" ? rep.calls.breakout : rep.calls.sweep;
      if (pe.call !== undefined) { if (pe.call === good) c.hit++; else c.miss++; if (pe.baseCall === good) c.base++; }
      if (pe.e.kind === "BREAKOUT") { const t = rep.confirm!["0"] ??= { hit: 0, miss: 0, base: 0, exposed: 0, total: 0 }; t.total++; if (pe.call !== undefined) { if (pe.call === good) t.hit++; else t.miss++; if (pe.baseCall === good) t.base++; } }
      add(pe.e.keys, good);
      if (good && pe.e.kind === "BREAKOUT") rep.boxLens.push(pe.e.box.len);
      pendingEvents.splice(x, 1);
    }
    // 2) New box event at i, predicted from earlier events only.
    const e = eventAt(bars, i, p);
    if (e) {
      const r = recall(rep.events, e.keys), overall = rate(rep.events[e.kind]);
      pendingEvents.push({ e, call: r ? r.rate >= 0.5 : undefined, baseCall: overall === null ? undefined : overall >= 0.5 });
    }
    // 3) Support / resistance tests.
    const [, , h, l, c] = bars[i], str = strength(bars, i, p);
    const next: Level[] = [];
    for (const lv of levels) {
      const sup = lv.kind === "SUPPORT";
      const broke = sup ? c < lv.price - LEVEL_BREAK * atr : c > lv.price + LEVEL_BREAK * atr;
      if (lv.pending) {
        const bounced = sup ? h >= lv.price + BOUNCE * atr : l <= lv.price - BOUNCE * atr;
        if (broke || bounced) {
          const held = !broke;
          const call = lv.pending.call;
          if (call) { if ((call === "HOLD") === held) rep.calls.touch.hit++; else rep.calls.touch.miss++; const o = rate(rep.events.TOUCH); if (o !== null && (o >= 0.5) === held) rep.calls.touch.base++; }
          add(lv.pending.keys, held);
          (held ? rep.holdsAt : rep.breaksAfter)[lv.pending.touch] = ((held ? rep.holdsAt : rep.breaksAfter)[lv.pending.touch] ?? 0) + 1;
          lv.pending = undefined;
        } else if (i - lv.pending.at > HORIZON * 2) lv.pending = undefined;
      }
      if (broke) continue; // a level that gave way is gone
      const touched = sup ? l <= lv.price + LEVEL_TOL * atr : h >= lv.price - LEVEL_TOL * atr;
      if (touched && !lv.pending && i - lv.lastTouch >= 3) {
        lv.touches++; lv.lastTouch = i;
        const keys = touchKeys(lv, i, str), r = recall(rep.events, keys);
        lv.pending = { touch: lv.touches, at: i, keys, call: r ? (r.rate >= 0.5 ? "HOLD" : "BREAK") : undefined };
      }
      next.push(lv);
    }
    levels = next;
    // 4) New swing point confirmed PIVOT candles later becomes a level (merged into a nearby one if it exists).
    const k = i - PIVOT;
    if (k >= PIVOT) {
      let low = true, high = true;
      // Equal lows/highs are common (shared open/close); the first of a tie counts as the pivot.
      for (let j = k - PIVOT; j <= k + PIVOT; j++) {
        if (j === k) continue;
        if (j < k ? bars[j][3] <= bars[k][3] : bars[j][3] < bars[k][3]) low = false;
        if (j < k ? bars[j][2] >= bars[k][2] : bars[j][2] > bars[k][2]) high = false;
      }
      for (const [is, price, kind] of [[low, bars[k][3], "SUPPORT"], [high, bars[k][2], "RESISTANCE"]] as const) {
        if (!is) continue;
        if (!levels.some((lv) => lv.kind === kind && Math.abs(lv.price - price) < LEVEL_TOL * atr)) levels.push({ price, kind, born: k, touches: 0, lastTouch: k });
      }
      if (levels.length > MAX_LEVELS) levels = levels.slice(-MAX_LEVELS);
    }
  }
  return rep;
}

const pct = (x: number | null) => x === null ? "–" : `${Math.round(x * 100)}%`;
/** Is this feature combination really different from the average event of its kind, or just noise? */
export function significance(events: Record<string, Tally>, r: { key: string; rate: number; n: number }, overallKey: string): string {
  const base = rate(events[overallKey]);
  if (base === null || r.key === overallKey) return "rata-rata umum";
  const z = (r.rate - base) / Math.sqrt(base * (1 - base) / r.n);
  return Math.abs(z) >= 2.5 ? `TERBUKTI beda dari rata-rata ${pct(base)}` : `tidak beda nyata dari rata-rata ${pct(base)}`;
}
const LBL: Record<string, string> = { LEMAH: "lemah", NORMAL: "normal", KUAT: "kuat", SANGAT_KUAT: "sangat kuat", MENGUAT: "dorongan makin kuat", MELEMAH: "dorongan melemah", CAMPUR: "" };
function duration(len: number, tfMs: number): string {
  const m = len * tfMs / 60_000;
  return m < 120 ? `${Math.round(m)} menit` : m < 48 * 60 ? `${Math.round(m / 60)} jam` : `${Math.round(m / 1440)} hari`;
}
/** Live read of the current structure on one timeframe, with the historical odds of what is happening now. */
export function describeNow(bars: Candle[], rep: StructureReport, tfMs: number): string {
  if (bars.length < 60) return "";
  const p = prep(bars), i = bars.length - 1, atr = p.atr[i], str = strength(bars, i, p);
  if (!str || !(atr > 0)) return "";
  const parts: string[] = [];
  const dir = str.body > 0 ? "naik" : str.body < 0 ? "turun" : "datar";
  parts.push(`candle terakhir ${dir} ${LBL[str.label]} (badan ${Math.abs(str.body).toFixed(1)}x normal${str.relVol === null ? "" : `, volume ${str.relVol.toFixed(1)}x rata-rata`})${LBL[str.trend] ? `, ${LBL[str.trend]}` : ""}`);
  // An event on one of the last 3 candles.
  for (let k = i; k >= i - 2; k--) {
    const e = eventAt(bars, k, p);
    if (!e) continue;
    const r = recall(rep.events, e.keys);
    const what = e.kind === "BREAKOUT" ? `breakout ${e.side === "UP" ? "ke atas" : "ke bawah"} dari sideways ${duration(e.box.len, tfMs)} (sisi itu dites ${e.side === "UP" ? e.box.topTests : e.box.bottomTests}x)`
      : `sapu likuiditas ${e.side === "UP" ? "di atas" : "di bawah"} range lalu balik masuk (pola manipulasi/stop hunt)`;
    const suspect = e.traps.length ? `dicurigai: ${e.traps.join(", ")}` : "tanda jebakan tidak terlihat, tetap dicurigai sampai terbukti";
    const c = i - k;
    if (e.kind === "BREAKOUT" && c === 0) {
      parts.push(`baru saja ${what}; ${suspect}. BELUM DINILAI: tunggu 1–3 candle konfirmasi dulu (historis langsung ditebak: asli ${r ? `${pct(r.rate)} (n=${r.n})` : "belum cukup sampel"})`);
    } else if (e.kind === "BREAKOUT") {
      const st = confirmState(bars, e, c, p);
      if (st === "GAGAL") parts.push(`${c} candle lalu ${what}, tapi sudah ditutup balik ke dalam range = BREAKOUT PALSU/JEBAKAN`);
      else {
        const rc = recall(rep.events, confirmKeys(c, st, e));
        const stLabel = st === "MELAJU" ? "bertahan dan melaju" : st === "RETEST_OK" ? "dites balik ke tepi range dan bertahan" : "bertahan tapi diam";
        parts.push(`${c} candle lalu ${what}; ${suspect}. Setelah menunggu ${c} candle: ${stLabel}; historis kondisi ini jadi asli ${rc ? `${pct(rc.rate)} (n=${rc.n}, ${significance(rep.events, rc, `CONF${c}`)})` : "belum cukup sampel"}`);
      }
    } else {
      parts.push(`${c === 0 ? "baru saja" : `${c} candle lalu`} ${what}; ${suspect}; historis berbalik arah ${r ? `${pct(r.rate)} (n=${r.n}, ${significance(rep.events, r, e.kind)})` : "belum cukup sampel"}`);
    }
    break;
  }
  const box = boxBefore(bars, i, p);
  if (box) parts.push(`sideways ${duration(box.len, tfMs)} dengan lebar ${box.width.toFixed(1)}x candle normal; atas dites ${box.topTests}x, bawah dites ${box.bottomTests}x${box.sweptTop || box.sweptBottom ? `, sudah ada sapu ${[box.sweptTop ? "atas" : "", box.sweptBottom ? "bawah" : ""].filter(Boolean).join(" & ")}` : ""}`);
  const holdsTotal = rep.holdsAt.reduce((s, x) => s + (x ?? 0), 0), breaksTotal = rep.breaksAfter.reduce((s, x) => s + (x ?? 0), 0);
  if (holdsTotal + breaksTotal >= 40) {
    const byTest = [1, 2, 3, 4].map((t) => {
      const hold = t < 4 ? rep.holdsAt[t] ?? 0 : rep.holdsAt.slice(4).reduce((s, x) => s + (x ?? 0), 0), brk = t < 4 ? rep.breaksAfter[t] ?? 0 : rep.breaksAfter.slice(4).reduce((s, x) => s + (x ?? 0), 0);
      return hold + brk >= 10 ? `tes ke-${t}${t === 4 ? "+" : ""} mantul ${pct(hold / (hold + brk))}` : "";
    }).filter(Boolean);
    if (byTest.length) parts.push(`support/resisten historis: ${byTest.join(", ")}`);
  }
  return parts.join("; ");
}
export function reportLine(rep: StructureReport): string {
  const c = rep.calls, f = (x: { hit: number; miss: number; base: number }) => x.hit + x.miss ? `${pct(x.hit / (x.hit + x.miss))} vs dasar ${pct(x.base / (x.hit + x.miss))} (n=${x.hit + x.miss})` : "–";
  const real = rate(rep.events.BREAKOUT), sweep = rate(rep.events.SWEEP), hold = rate(rep.events.TOUCH);
  const avgBox = rep.boxLens.length ? Math.round(rep.boxLens.reduce((s, x) => s + x, 0) / rep.boxLens.length) : null;
  return `breakout asli ${pct(real)} (tebakan ${f(c.breakout)}), sapu berbalik ${pct(sweep)} (tebakan ${f(c.sweep)}), level mantul ${pct(hold)} (tebakan ${f(c.touch)})` +
    `${avgBox ? `, sideways sebelum breakout asli rata-rata ${avgBox} candle` : ""}${rep.hasVolume ? "" : ", volume tidak tersedia"}` +
    (rep.confirm ? `; menunggu konfirmasi: ${["0", "1", "2", "3"].filter((c) => rep.confirm![c]).map((c) => { const t = rep.confirm![c]; return `${c} candle → tebakan ${t.hit + t.miss ? pct(t.hit / (t.hit + t.miss)) : "–"}${c !== "0" ? `, ${pct(t.total ? t.exposed / t.total : null)} sudah ketahuan palsu` : ""}`; }).join("; ")}` : "");
}
