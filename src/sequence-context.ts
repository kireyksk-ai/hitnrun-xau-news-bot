import type { Prediction } from "./predictions.js";
import { scorecard } from "./predictions.js";
import { rejectedButMoved, similarPast, type ShadowItem } from "./shadow-outcomes.js";

/**
 * Sequence memory for Sol: the chain of alerts already sent (with the measured
 * XAU reaction) and the bot's own track record per theme. This is evidence in the
 * prompt, never a rule change: it cannot send, block or re-route anything.
 */
export type SentItem = { sentAt: string; storyKey: string; title: string; eventKey: string };

const themeOf = (storyKey: string) => storyKey.replace(/^(iran-gulf-conflict)(?:-.+)?$/, "$1").replace(/^us-macro-.+$/, "us-macro");
const wib = (iso: string) => new Date(Date.parse(iso) + 7 * 3600_000).toISOString().slice(11, 16);
const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

export function recentChain(sent: SentItem[], predictions: Prediction[], now: Date, hours = 6, limit = 8): string[] {
  const since = now.getTime() - hours * 3600_000;
  const byEvent = new Map(predictions.map((item) => [item.eventId, item]));
  return sent
    .filter((item) => Date.parse(item.sentAt) >= since && Date.parse(item.sentAt) <= now.getTime())
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt))
    .slice(-limit)
    .map((item) => {
      const call = byEvent.get(item.eventKey);
      const reaction = call ? (["15", "60", "240"] as const).filter((m) => call.marks[m]).map((m) => `${m === "15" ? "15m" : m === "60" ? "1j" : "4j"} ${signed(call.marks[m]!.returnPct)}`).join(", ") : "";
      const direction = call ? ` | arah dicatat ${call.direction}${call.direction === "BULLISH" || call.direction === "BEARISH" ? ` ${call.confidence}%` : ""}` : "";
      return `${wib(item.sentAt)} WIB | ${item.storyKey} | ${item.title.replace(/\s+/g, " ").slice(0, 140)}${direction}${reaction ? ` | reaksi XAU ${reaction}` : ""}`;
    });
}

/** Only themes with enough scored calls are reported; small samples are withheld. */
export function trackRecord(predictions: Prediction[], storyKey: string, now: Date, minCalls = 8): string[] {
  const card = scorecard(predictions, now.getTime() - 30 * 86400_000);
  const lines: string[] = [];
  const theme = themeOf(storyKey);
  const inTheme = predictions.filter((item) => themeOf(item.storyKey) === theme);
  const themeCard = scorecard(inTheme, now.getTime() - 30 * 86400_000);
  const themeScored = themeCard.atHorizon.hit + themeCard.atHorizon.miss;
  if (themeScored >= minCalls) lines.push(`tema ${theme}: arah tepat ${Math.round(themeCard.atHorizon.hit / themeScored * 100)}% dari ${themeScored} panggilan (30 hari)`);
  const overall = card.atHorizon.hit + card.atHorizon.miss;
  if (overall >= minCalls) lines.push(`semua tema: arah tepat ${Math.round(card.atHorizon.hit / overall * 100)}% dari ${overall} panggilan`);
  for (const band of card.calibration) if (band.calls >= minCalls && band.hitRate !== null) lines.push(`keyakinan ${band.band}: kenyataannya tepat ${Math.round(band.hitRate * 100)}% (${band.calls})`);
  return lines;
}

export function sequenceContext(sent: SentItem[], predictions: Prediction[], storyKey: string, now: Date,
  memory?: { shadow: ShadowItem[]; fact: string }): string {
  const chain = recentChain(sent, predictions, now);
  const record = trackRecord(predictions, storyKey, now);
  const similar = memory ? similarPast(memory.shadow, memory.fact, now) : [];
  const moved = memory ? rejectedButMoved(memory.shadow, now) : [];
  if (!chain.length && !record.length && !similar.length && !moved.length) return "";
  return [
    chain.length ? `SEQUENCE_CONTEXT (alert yang sudah terkirim, lama→baru):\n${chain.join("\n")}` : "SEQUENCE_CONTEXT: belum ada alert dalam 6 jam terakhir.",
    record.length ? `TRACK_RECORD:\n${record.join("\n")}` : "TRACK_RECORD: sampel belum cukup; jangan menyimpulkan apa pun darinya.",
    ...(similar.length ? [`SIMILAR_PAST:\n${similar.join("\n")}`] : []),
    ...(moved.length ? [`REJECTED_BUT_MOVED (6 jam):\n${moved.join("\n")}`] : [])
  ].join("\n");
}

export const SEQUENCE_REASONING_GUIDE = `SEQUENCE REASONING (uses SEQUENCE_CONTEXT and TRACK_RECORD when supplied; both are evidence, never rules):
Read the new item as the next link in the chain of alerts already sent. Decide whether it CONTINUES the prevailing impulse (same direction, adds conviction), ACCELERATES it (larger, more official or more concrete), or REVERSES/CONTRADICTS it. Cumulative same-direction impulses across linked themes (for example strong data -> hawkish Fed speaker -> higher yields -> stronger dollar) strengthen the case; a fact whose effect already shows in the listed XAU reaction is weaker news and should say so. A reversal of the chain is high-value news even when the headline looks small. When material, dampakEmas may name the link naturally in Indonesian (e.g. melanjutkan tekanan dari data dan komentar Fed sebelumnya) without listing times or sources.
TRACK_RECORD shows how often past potential directions in a theme proved right at the stated horizon. When a theme is below about 55% on the listed sample, lower keyakinan or use TWO_WAY; when a confidence band proves overconfident, stay below it. Never raise confidence because of a small or missing sample, never invent reactions or records that are not listed, and never let the record decide materiality.`;
