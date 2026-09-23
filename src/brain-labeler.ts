import { existsSync, readFileSync } from "node:fs";
import { atomicWrite, backupOnce } from "./brain-store.js";
import { MARKS, type Episode, type Label, type MarkMinute } from "./brain-episodes.js";

/**
 * Outcome labeler: decides, from the measured XAU path, whether the brain's call
 * was CORRECT, WRONG, LATE, right-direction-wrong-timing, only a SPIKE, REVERSED,
 * or produced NO_REACTION. Rejected news that was followed by a move is MISSED_MOVE.
 * Thresholds scale with realised volatility so a quiet Asian hour and a CPI minute
 * are judged on their own terms.
 */
const CAP: Record<MarkMinute, number> = { 1: 0.12, 5: 0.18, 15: 0.25, 30: 0.3, 60: 0.4, 240: 0.7, 1440: 1.1 };
export function threshold(minute: MarkMinute, vol60?: number): number {
  const sigma = vol60 && vol60 > 0 ? vol60 : 0.025;
  return +Math.max(0.08, Math.min(CAP[minute], 1.5 * sigma * Math.sqrt(minute))).toFixed(3);
}
const xau = (e: Episode, m: MarkMinute) => { const mark = e.marks[`${m}`]; return mark && !mark.unavailable ? mark.moves.XAU : undefined; };

export function labelEpisode(e: Episode, now = Date.now()): Label | undefined {
  const at = new Date(now).toISOString();
  const direction = e.decision?.direction;
  const H: MarkMinute = e.decision?.horizonMinutes ?? 60;
  const final = Boolean(e.marks["1440"]) || !e.reviewed && Boolean(e.marks["60"]);
  const early = ([1, 5, 15] as MarkMinute[]).filter((m) => xau(e, m) !== undefined);
  // Unpublished or undirected items: did gold move anyway?
  if (!e.published || direction === undefined || direction === "TWO_WAY" || direction === "UNCLEAR") {
    if (xau(e, 60) === undefined) return undefined;
    const upTo60 = ([1, 5, 15, 30, 60] as MarkMinute[]).map((m) => ({ m, v: xau(e, m) })).filter((x): x is { m: MarkMinute; v: number } => x.v !== undefined);
    const peak = upTo60.reduce((best, x) => Math.abs(x.v) / threshold(x.m, e.vol60) > Math.abs(best.v) / threshold(best.m, e.vol60) ? x : best, upTo60[0]);
    const moved = Math.abs(peak.v) >= Math.max(threshold(peak.m, e.vol60), 0.2);
    const label: Label["label"] = moved ? (e.published ? "UNCALLED_MOVE" : "MISSED_MOVE") : (e.published ? "NO_REACTION" : "CORRECT_REJECT");
    return { label, final: final || Boolean(e.marks["60"]), at, peakMove: peak.v, threshold: threshold(peak.m, e.vol60), note: `peak ${peak.v.toFixed(2)}% at ${peak.m}m` };
  }
  const rH = xau(e, H);
  if (rH === undefined) return undefined;
  const s = direction === "BULLISH" ? 1 : -1;
  const thrH = threshold(H, e.vol60);
  const pre15 = e.pre.m15.XAU ?? 0;
  const earlyPeak = early.map((m) => ({ m, v: s * xau(e, m)! })).reduce<{ m: MarkMinute; v: number } | undefined>((b, x) => !b || x.v > b.v ? x : b, undefined);
  const later = MARKS.filter((m) => m > H).map((m) => ({ m, v: xau(e, m) })).filter((x): x is { m: MarkMinute; v: number } => x.v !== undefined);
  const base = { final, at, horizonMove: rH, threshold: thrH };
  if (s * pre15 >= threshold(15, e.vol60) && s * rH < 0.5 * thrH)
    return { ...base, label: "LATE", note: `emas udah gerak ${pre15.toFixed(2)}% 15 menit sebelum keputusan, sesudahnya cuma ${rH.toFixed(2)}%` };
  if (earlyPeak && earlyPeak.v >= threshold(earlyPeak.m, e.vol60) && s * rH <= -thrH)
    return { ...base, label: "REVERSED", peakMove: s * earlyPeak.v, note: `awal searah ${earlyPeak.v.toFixed(2)}% (${earlyPeak.m}m) lalu berbalik ${rH.toFixed(2)}% di ${H}m` };
  if (earlyPeak && earlyPeak.v >= threshold(earlyPeak.m, e.vol60) && s * rH < 0.4 * earlyPeak.v && s * rH > -thrH)
    return { ...base, label: "SPIKE_ONLY", peakMove: s * earlyPeak.v, note: `spike ${earlyPeak.v.toFixed(2)}% (${earlyPeak.m}m) balik >60% sebelum ${H}m` };
  if (s * rH >= 0.5 * thrH) return { ...base, label: "CORRECT", note: `searah ${rH.toFixed(2)}% di ${H}m (ambang ${thrH}%)` };
  if (s * rH <= -0.5 * thrH) return { ...base, label: "WRONG", note: `berlawanan ${rH.toFixed(2)}% di ${H}m (ambang ${thrH}%)` };
  const lateHit = later.find((x) => s * x.v >= threshold(x.m, e.vol60));
  if (lateHit) return { ...base, label: "RIGHT_DIRECTION_WRONG_TIMING", note: `datar di ${H}m, gerak searah ${lateHit.v.toFixed(2)}% baru di ${lateHit.m}m` };
  // Only final once the later marks had their chance.
  return { ...base, final, label: "NO_REACTION", note: `gerak ${rH.toFixed(2)}% di ${H}m < setengah ambang ${thrH}%` };
}

export const ERROR_LABELS = new Set<Label["label"]>(["WRONG", "LATE", "RIGHT_DIRECTION_WRONG_TIMING", "SPIKE_ONLY", "REVERSED", "MISSED_MOVE", "UNCALLED_MOVE"]);
/** A published directional alert that moved nothing is a false alert. */
export function isFalseAlert(e: Episode): boolean { return e.published && e.label?.label === "NO_REACTION"; }

export type Lesson = {
  key: string; errorType: string; catalyst: string; regime: string; text: string; solText?: string; conditions?: string;
  support: number; contradict: number; examples: string[]; createdAt: string; updatedAt: string;
};

/** Concrete, deterministic lesson text; Sol may later add a sharper version (solText). */
export function lessonFrom(e: Episode): { key: string; text: string } | undefined {
  const l = e.label; if (!l) return undefined;
  const falseAlert = e.published && l.label === "NO_REACTION";
  if (!ERROR_LABELS.has(l.label) && !falseAlert) return undefined;
  if (l.label === "MISSED_MOVE" && (e.tier > 2 || Math.abs(l.peakMove ?? 0) < 0.3)) return undefined;
  const regime = e.regime?.primary ?? "UNCLEAR", cat = e.catalyst, dir = e.decision?.direction?.toLowerCase() ?? "-";
  const dxy = e.marks["60"]?.moves.DXY, y10 = e.marks["60"]?.moves.US10Y;
  const cross = `DXY ${dxy === undefined ? "n/a" : `${dxy.toFixed(2)}%`}, US10Y ${y10 === undefined ? "n/a" : `${y10.toFixed(1)}bp`} dalam 1 jam`;
  const texts: Record<string, string> = {
    WRONG: `Katalis ${cat} saat rezim ${regime}: arah ${dir} salah (${l.note}; ${cross}). Cek dulu driver dominan sebelum ngasih arah.`,
    LATE: `Katalis ${cat} saat rezim ${regime}: harga udah gerak duluan sebelum keputusan (${l.note}). Kalau pre-move 15 menit udah searah, anggap priced-in dan turunin keyakinan.`,
    RIGHT_DIRECTION_WRONG_TIMING: `Katalis ${cat} saat rezim ${regime}: arah benar tapi horizon kependekan (${l.note}). Pakai horizon lebih panjang buat pola ini.`,
    SPIKE_ONLY: `Katalis ${cat} saat rezim ${regime}: reaksi awal cuma spike (${l.note}). Jangan anggap reaksi 1-15 menit sebagai konfirmasi.`,
    REVERSED: `Katalis ${cat} saat rezim ${regime}: reaksi pertama berbalik (${l.note}; ${cross}). Waspada whipsaw, tunggu konfirmasi lintas pasar.`,
    MISSED_MOVE: `Katalis ${cat} saat rezim ${regime}: berita yang ditolak ternyata diikuti gerak emas ${l.peakMove?.toFixed(2)}% (${l.note}). Pola ini layak dinilai lebih material.`,
    UNCALLED_MOVE: `Katalis ${cat} saat rezim ${regime}: alert dikirim tanpa arah jelas padahal emas gerak ${l.peakMove?.toFixed(2)}% (${l.note}). Berani kasih arah kalau lintas pasar searah.`
  };
  if (falseAlert) return { key: `FALSE_ALERT|${cat}|${regime}`, text: `Katalis ${cat} saat rezim ${regime}: alert terkirim tapi emas gak bereaksi (${l.note}). Berita kayak gini kemungkinan noise di rezim ini; naikin standar materialitasnya.` };
  return { key: `${l.label}|${cat}|${regime}`, text: texts[l.label] };
}

export class LessonBook {
  private data: Record<string, Lesson>;
  constructor(private readonly path: string) { backupOnce(path); this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}; }
  all(): Lesson[] { return Object.values(this.data); }
  get(key: string): Lesson | undefined { return this.data[key]; }
  /** Stores (or reinforces) a lesson from a labeled error. Returns it and whether it is new. Lessons are never pruned. */
  learn(e: Episode, now = new Date().toISOString()): { lesson: Lesson; created: boolean } | undefined {
    const draft = lessonFrom(e); if (!draft) return undefined;
    const existing = this.data[draft.key];
    const [errorType, catalyst, regime] = draft.key.split("|");
    const lesson: Lesson = existing
      ? { ...existing, support: existing.support + 1, examples: [...existing.examples.filter((x) => x !== e.id), e.id].slice(-8), updatedAt: now, text: draft.text }
      : { key: draft.key, errorType, catalyst, regime, text: draft.text, support: 1, contradict: 0, examples: [e.id], createdAt: now, updatedAt: now };
    this.data[draft.key] = lesson; this.save();
    return { lesson, created: !existing };
  }
  /** A correct call in the same catalyst/regime weakens earlier error lessons for it (they stay, but lose weight). */
  contradict(e: Episode, now = new Date().toISOString()): void {
    if (e.label?.label !== "CORRECT") return;
    let changed = false;
    for (const l of Object.values(this.data)) if (l.catalyst === e.catalyst && l.regime === (e.regime?.primary ?? "UNCLEAR") && l.errorType !== "MISSED_MOVE") { l.contradict++; l.updatedAt = now; changed = true; }
    if (changed) this.save();
  }
  refine(key: string, solText: string, conditions: string): void { const l = this.data[key]; if (!l) return; l.solText = solText; l.conditions = conditions; l.updatedAt = new Date().toISOString(); this.save(); }
  strength(l: Lesson): number { return (l.support + 1) / (l.support + l.contradict + 2); }
  private save(): void { atomicWrite(this.path, this.data); }
}
