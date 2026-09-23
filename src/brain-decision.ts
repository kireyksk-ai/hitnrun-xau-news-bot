import type { DataHealth } from "./brain-market.js";
import type { Action, CriticResult, Episode, InternalAssessment } from "./brain-episodes.js";

/**
 * Deterministic guardrails over Sol's internal action. Sol is never forced to take
 * a position: missing, stale, late or conflicting evidence always ends in WAIT or
 * NO_TRADE. The result is the brain's own assessment and is never published.
 */
export type Knobs = {
  minTradeConfidence: number;   // below this a BUY/SELL becomes WAIT
  preMoveWaitPct: number;       // XAU already moved this much in the call direction in 15m → WAIT (priced in)
  waitOnCriticDowngrade: boolean;
  costPct: number;              // spread + slippage per round trip, % of price
  halfLifeDays: number;         // retrieval recency half-life
  regimeBoost: number;          // retrieval weight for same-regime episodes
};
export const DEFAULT_KNOBS: Knobs = { minTradeConfidence: 62, preMoveWaitPct: 0.25, waitOnCriticDowngrade: true, costPct: 0.03, halfLifeDays: 30, regimeBoost: 1.5 };

export type Finalized = { action: Action; guardrails: string[] };
export function finalizeAction(input: { published: boolean; decision?: InternalAssessment; critic?: CriticResult; health?: DataHealth; preMove15?: number; killSwitch?: boolean; halted?: string }, k: Knobs): Finalized {
  const g: string[] = [];
  const d = input.decision;
  if (input.killSwitch) return { action: "NO_TRADE", guardrails: ["KILL_SWITCH aktif"] };
  if (input.halted) return { action: "NO_TRADE", guardrails: [`RISK_HALT: ${input.halted}`] };
  if (!d) return { action: "NO_TRADE", guardrails: ["tidak ada penilaian Sol"] };
  let action: Action = d.action;
  const confidence = input.critic?.adjustedConfidence ?? d.confidence;
  if (input.critic?.adjustedAction && input.critic.verdict !== "PASS") action = input.critic.adjustedAction;
  if (action === "BUY" && d.direction !== "BULLISH" || action === "SELL" && d.direction !== "BEARISH") { g.push(`aksi ${action} tidak cocok dengan arah ${d.direction}`); action = "WAIT"; }
  if ((action === "BUY" || action === "SELL") && !input.published) { g.push("berita tidak material/terkirim"); action = "NO_TRADE"; }
  if ((action === "BUY" || action === "SELL") && input.health && !input.health.ok) { g.push(`data pasar bermasalah: ${input.health.note}`); action = "WAIT"; }
  if ((action === "BUY" || action === "SELL") && confidence < k.minTradeConfidence) { g.push(`keyakinan ${confidence} < ${k.minTradeConfidence}`); action = "WAIT"; }
  const s = action === "BUY" ? 1 : action === "SELL" ? -1 : 0;
  if (s && input.preMove15 !== undefined && s * input.preMove15 >= k.preMoveWaitPct) { g.push(`emas udah gerak ${input.preMove15.toFixed(2)}% searah dalam 15 menit (priced-in)`); action = "WAIT"; }
  if (s && input.critic?.crossMarketConflict) { g.push("pemeriksa: konflik lintas pasar"); action = "WAIT"; }
  if (s && input.critic?.verdict === "DOWNGRADE" && k.waitOnCriticDowngrade) { g.push(`pemeriksa menurunkan: ${input.critic.reasons.slice(0, 2).join("; ")}`); action = "WAIT"; }
  if (s && input.critic?.verdict === "BLOCK") { g.push("pemeriksa memblokir"); action = "NO_TRADE"; }
  return { action, guardrails: g };
}

/** Re-applies knobs to an already-recorded episode (historical replay of a candidate policy). */
export function replayAction(e: Episode, k: Knobs): Action {
  return finalizeAction({ published: e.published, decision: e.decision, critic: e.critic, health: e.health, preMove15: e.pre.m15.XAU }, k).action;
}
