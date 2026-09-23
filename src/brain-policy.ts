import { existsSync, readFileSync } from "node:fs";
import { atomicWrite, backupOnce } from "./brain-store.js";
import { DEFAULT_KNOBS, replayAction, type Knobs } from "./brain-decision.js";
import { tradeStats, tradesOf } from "./brain-eval.js";
import type { Episode } from "./brain-episodes.js";

/**
 * Policy versions. Sol may propose changes to knobs and to a short prompt addendum,
 * but a proposal is only a CANDIDATE: it is replayed on labeled history, run in
 * shadow on new episodes, compared with the active version, and promoted only when
 * it is measurably better AND the owner approves (AGENTS.md: rule changes from
 * market outcomes need samples plus user approval). Every version is kept and any
 * version can be rolled back to.
 */
export type PolicyStatus = "ACTIVE" | "CANDIDATE" | "READY_FOR_APPROVAL" | "REJECTED" | "RETIRED";
export type Evaluation = { at: string; replayTrades: number; replayExpectancy: number | null; replayMaxDD: number; replayWinRate: number | null;
  activeExpectancy: number | null; activeMaxDD: number; shadowSamples: number; shadowHitRate: number | null; activeHitRateSameSample: number | null; verdict: string };
export type PolicyVersion = { id: string; parent?: string; createdAt: string; status: PolicyStatus; knobs: Knobs; notes: string; rationale: string; evaluations: Evaluation[]; promotedAt?: string; retiredAt?: string };
type State = { active: string; versions: PolicyVersion[]; log: Array<{ at: string; event: string; version: string; detail: string }> };

export const MIN_REPLAY_TRADES = 40;
export const MIN_SHADOW_SAMPLES = 20;

export class PolicyRegistry {
  private s: State;
  constructor(private readonly path: string) {
    backupOnce(path);
    this.s = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {
      active: "v1", versions: [{ id: "v1", createdAt: new Date().toISOString(), status: "ACTIVE", knobs: DEFAULT_KNOBS, notes: "", rationale: "baseline", evaluations: [] }], log: []
    };
    // New knobs added in later releases are filled from defaults without changing existing values.
    for (const v of this.s.versions) v.knobs = { ...DEFAULT_KNOBS, ...v.knobs };
    this.save();
  }
  private save(): void { atomicWrite(this.path, this.s); }
  private note(event: string, version: string, detail: string): void { this.s.log.push({ at: new Date().toISOString(), event, version, detail }); this.s.log = this.s.log.slice(-500); }
  active(): PolicyVersion { return this.s.versions.find((v) => v.id === this.s.active)!; }
  versions(): PolicyVersion[] { return this.s.versions; }
  log(): State["log"] { return this.s.log; }
  candidate(): PolicyVersion | undefined { return this.s.versions.find((v) => v.status === "CANDIDATE" || v.status === "READY_FOR_APPROVAL"); }

  propose(knobs: Partial<Knobs>, notes: string, rationale: string): PolicyVersion | undefined {
    if (this.candidate()) return undefined; // one candidate at a time
    const base = this.active();
    const v: PolicyVersion = { id: `v${this.s.versions.length + 1}`, parent: base.id, createdAt: new Date().toISOString(), status: "CANDIDATE",
      knobs: sanitize({ ...base.knobs, ...knobs }), notes: notes.slice(0, 1200), rationale: rationale.slice(0, 800), evaluations: [] };
    this.s.versions.push(v); this.note("PROPOSED", v.id, rationale.slice(0, 200)); this.save();
    return v;
  }

  /** Replay (deterministic knobs) + shadow (prompt notes) comparison against the active version. */
  evaluate(episodes: Episode[]): Evaluation | undefined {
    const cand = this.candidate(); if (!cand) return undefined;
    const active = this.active();
    const labeled = episodes.filter((e) => e.reviewed && e.decision && e.label);
    const candTrades = tradesOf(labeled, cand.knobs.costPct, (e) => replayAction(e, cand.knobs));
    const actTrades = tradesOf(labeled, active.knobs.costPct, (e) => replayAction(e, active.knobs));
    const c = tradeStats(candTrades), a = tradeStats(actTrades);
    const shadow = labeled.filter((e) => e.candidate?.policyVersion === cand.id && e.decision && (e.candidate.direction === "BULLISH" || e.candidate.direction === "BEARISH"));
    const hit = (dir: string | undefined, e: Episode) => { const r = e.marks[`${e.decision!.horizonMinutes}`]?.moves.XAU; return r !== undefined && Math.abs(r) >= 0.05 && (dir === "BULLISH") === (r > 0); };
    const shadowHit = shadow.length ? shadow.filter((e) => hit(e.candidate!.direction, e)).length / shadow.length : null;
    const activeHit = shadow.length ? shadow.filter((e) => hit(e.decision!.direction, e)).length / shadow.length : null;
    const needsShadow = cand.notes.trim().length > 0 && cand.notes !== active.notes;
    const enoughReplay = candTrades.length >= MIN_REPLAY_TRADES;
    const enoughShadow = !needsShadow || shadow.length >= MIN_SHADOW_SAMPLES;
    const better = (c.expectancy ?? -Infinity) > (a.expectancy ?? -Infinity) + 0.005 && c.maxDrawdown <= a.maxDrawdown * 1.1 + 0.05 &&
      (!needsShadow || (shadowHit ?? 0) >= (activeHit ?? 0));
    const verdict = !enoughReplay || !enoughShadow ? `SAMPLE_KURANG (replay ${candTrades.length}/${MIN_REPLAY_TRADES}, shadow ${shadow.length}/${needsShadow ? MIN_SHADOW_SAMPLES : 0})`
      : better ? "LEBIH_BAIK" : "TIDAK_LEBIH_BAIK";
    const ev: Evaluation = { at: new Date().toISOString(), replayTrades: candTrades.length, replayExpectancy: c.expectancy, replayMaxDD: c.maxDrawdown, replayWinRate: c.winRate,
      activeExpectancy: a.expectancy, activeMaxDD: a.maxDrawdown, shadowSamples: shadow.length, shadowHitRate: shadowHit, activeHitRateSameSample: activeHit, verdict };
    cand.evaluations.push(ev); cand.evaluations = cand.evaluations.slice(-30);
    if (verdict === "LEBIH_BAIK" && cand.status === "CANDIDATE") { cand.status = "READY_FOR_APPROVAL"; this.note("READY_FOR_APPROVAL", cand.id, JSON.stringify(ev)); }
    if (verdict === "TIDAK_LEBIH_BAIK" && Date.now() - Date.parse(cand.createdAt) > 14 * 86400_000) { cand.status = "REJECTED"; this.note("REJECTED", cand.id, "tidak lebih baik setelah 14 hari"); }
    this.save();
    return ev;
  }

  /** Owner-approved promotion (POLICY_APPROVE=<id>). Only a READY candidate can be promoted. */
  approve(id: string): string {
    const v = this.s.versions.find((x) => x.id === id);
    if (!v) return `versi ${id} tidak ada`;
    if (v.status !== "READY_FOR_APPROVAL") return `versi ${id} belum lolos uji (status ${v.status})`;
    const old = this.active(); old.status = "RETIRED"; old.retiredAt = new Date().toISOString();
    v.status = "ACTIVE"; v.promotedAt = new Date().toISOString(); this.s.active = v.id;
    this.note("PROMOTED", v.id, `menggantikan ${old.id}`); this.save();
    return `versi ${id} aktif (menggantikan ${old.id})`;
  }
  /** Rollback to any earlier version (POLICY_ROLLBACK_TO=<id>). */
  rollback(id: string, reason: string): string {
    const v = this.s.versions.find((x) => x.id === id);
    if (!v) return `versi ${id} tidak ada`;
    if (v.id === this.s.active) return `versi ${id} sudah aktif`;
    const old = this.active(); old.status = "RETIRED"; old.retiredAt = new Date().toISOString();
    v.status = "ACTIVE"; v.promotedAt = new Date().toISOString(); this.s.active = v.id;
    this.note("ROLLBACK", v.id, `dari ${old.id}: ${reason}`); this.save();
    return `rollback ke ${id} (dari ${old.id})`;
  }
  /** Automatic safety rollback: after 40 trades, a promoted version whose live expectancy is negative and worse than its parent's replay goes back. */
  guard(episodes: Episode[]): string | undefined {
    const v = this.active(); if (!v.parent || !v.promotedAt) return undefined;
    const since = episodes.filter((e) => e.policyVersion === v.id && e.reviewed && e.label);
    const live = tradeStats(tradesOf(since, v.knobs.costPct));
    const parent = this.s.versions.find((x) => x.id === v.parent);
    if (!parent || tradesOf(since, v.knobs.costPct).length < 40) return undefined;
    const parentReplay = tradeStats(tradesOf(since, parent.knobs.costPct, (e) => replayAction(e, parent.knobs)));
    if ((live.expectancy ?? 0) < 0 && (live.expectancy ?? 0) < (parentReplay.expectancy ?? 0) - 0.01) return this.rollback(parent.id, "auto: versi aktif memburuk setelah dipromosikan");
    return undefined;
  }
}

function sanitize(k: Knobs): Knobs {
  const c = (v: number, lo: number, hi: number, d: number) => Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  return { minTradeConfidence: c(k.minTradeConfidence, 55, 85, 62), preMoveWaitPct: c(k.preMoveWaitPct, 0.1, 0.6, 0.25), waitOnCriticDowngrade: Boolean(k.waitOnCriticDowngrade),
    costPct: c(k.costPct, 0.01, 0.2, 0.03), halfLifeDays: c(k.halfLifeDays, 7, 120, 30), regimeBoost: c(k.regimeBoost, 1, 3, 1.5) };
}

/** Autonomy ladder. Anything beyond SHADOW needs the performance standard; LIVE is not available (no execution adapter). */
export type AutonomyLevel = "OBSERVER" | "SHADOW" | "DEMO" | "ADVISORY" | "LIVE";
export const STANDARDS: Record<Exclude<AutonomyLevel, "OBSERVER" | "SHADOW">, { trades: number; expectancy: number; profitFactor: number; maxDD: number }> = {
  DEMO: { trades: 100, expectancy: 0, profitFactor: 1.1, maxDD: 6 },
  ADVISORY: { trades: 300, expectancy: 0.02, profitFactor: 1.25, maxDD: 5 },
  LIVE: { trades: 500, expectancy: 0.03, profitFactor: 1.35, maxDD: 4 }
};
export function effectiveAutonomy(requested: AutonomyLevel, stats: { trades: number; expectancy: number | null; profitFactor: number | null; maxDrawdown: number }): { level: AutonomyLevel; note: string } {
  if (requested === "OBSERVER" || requested === "SHADOW") return { level: requested, note: "ok" };
  if (requested === "LIVE") return { level: effectiveAutonomy("ADVISORY", stats).level, note: "LIVE ditolak: tidak ada adaptor eksekusi broker; butuh keputusan pemilik + limit risiko terpisah" };
  const need = STANDARDS[requested];
  const pass = stats.trades >= need.trades && (stats.expectancy ?? -1) > need.expectancy && (stats.profitFactor ?? 0) >= need.profitFactor && stats.maxDrawdown <= need.maxDD;
  return pass ? { level: requested, note: "standar terpenuhi" } : { level: "SHADOW", note: `${requested} belum memenuhi standar (${stats.trades}/${need.trades} keputusan, expectancy ${stats.expectancy?.toFixed(3) ?? "–"}%, PF ${stats.profitFactor?.toFixed(2) ?? "–"}, DD ${stats.maxDrawdown.toFixed(2)}%)` };
}

/** Paper risk guard: daily loss limit, max drawdown, kill switch. Halts internal BUY/SELL (→ NO_TRADE), never alerts. */
export function riskHalt(trades: Array<{ at: string; net: number }>, now: number, limits: { dailyLossPct: number; maxDrawdownPct: number }): string | undefined {
  const day = new Date(now + 7 * 3600_000).toISOString().slice(0, 10);
  const today = trades.filter((t) => new Date(Date.parse(t.at) + 7 * 3600_000).toISOString().slice(0, 10) === day).reduce((s, t) => s + t.net, 0);
  if (today <= -limits.dailyLossPct) return `rugi harian paper ${today.toFixed(2)}% ≥ batas ${limits.dailyLossPct}%`;
  let eq = 0, peak = 0, dd = 0; for (const t of trades) { eq += t.net; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const current = peak - eq;
  if (current >= limits.maxDrawdownPct) return `drawdown paper ${current.toFixed(2)}% ≥ batas ${limits.maxDrawdownPct}%`;
  return undefined;
}
