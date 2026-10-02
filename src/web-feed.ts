/**
 * FastXAUNews web feed (owner, 2026-10-03): every alert and desk update that reaches Telegram is rewritten in English
 * by the cheap gate model and posted to the website's ingest endpoint. Best effort: a failure never touches Telegram.
 */
export type WebItem = { id: string; at: string; kind: "alert" | "desk"; marker: "red" | "yellow" | "white"; headline: string; note: string; category: string; impact: string; watch: string };
export const WEB_CATEGORIES = ["fed", "data", "geopolitics", "oil", "markets"] as const;
export const WEB_IMPACTS = ["bullish", "bearish", "mixed", "neutral"] as const;

/** Telegram HTML to plain text. */
export function plainPost(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Importance marker of a Telegram post (🔴 / 🟡 / ⚪), yellow when absent. */
export function webMarker(text: string): WebItem["marker"] {
  const head = plainPost(text).slice(0, 8);
  return head.includes("🔴") ? "red" : head.includes("⚪") ? "white" : "yellow";
}

/** Final guard on the English rewrite: no levels, trade calls, links or media names may reach the public page. */
export function webSafe(text: string): boolean {
  return !/https?:\/\/|www\.|\b(?:BUY|SELL)\b|\bentry\b|stop[- ]?loss|take[- ]profit|\btarget\b|\bbot\b|\bAI\b|Telegram|Reuters|Bloomberg|\$\s?\d{1,2},?\d{3}(?:\.\d+)?\b/i.test(text);
}

export const WEB_REWRITE_GUIDE = `You rewrite a gold (XAUUSD) news post written in Indonesian for an international English-speaking audience of a public gold news website.
Return JSON {headline, note, category, impact, watch}.
headline: the news fact in plain English, max 110 characters, no emoji, no media or source names, no quotes around it.
note: for kind "alert" 1-2 short sentences (max 280 characters) on why it matters for gold (through yields, the dollar, oil, risk or safe-haven demand); for kind "desk" a compact summary of the update in 3-6 sentences (max 900 characters).
category: "fed" (Fed and other central banks, officials, rates), "data" (economic data releases, yields, the dollar), "geopolitics" (war, sanctions, diplomacy, trade policy), "oil" (oil, fuel, energy supply), "markets" (anything else).
impact: the potential effect on gold stated or implied by the post: "bullish", "bearish", "mixed" (forces pull both ways) or "neutral".
watch: what to watch next, max 60 characters, empty string if the post gives nothing.
Use only facts in the input. Never write price levels, zones, entries, targets, stop-loss or buy/sell calls. Never mention Telegram, bots, AI or the post itself.`;
