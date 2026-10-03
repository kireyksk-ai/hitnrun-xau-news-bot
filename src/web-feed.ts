/**
 * FastXAUNews web feed (owner, 2026-10-03): every alert and desk update that reaches Telegram is rewritten in English
 * by the cheap gate model and posted to the website's ingest endpoint. Best effort: a failure never touches Telegram.
 */
export type WebItem = { id: string; at: string; kind: "alert" | "desk"; marker: "red" | "yellow" | "white"; headline: string; note: string; category: string; impact: string; watch: string };
export const WEB_CATEGORIES = ["fed", "data", "geopolitics", "oil", "markets"] as const;
export const WEB_IMPACTS = ["bullish", "bearish", "mixed", "neutral"] as const;
/** Site languages besides English (owner, 2026-10-03: markets where Exness is available). */
export const WEB_LANGS = ["id", "ar", "hi", "ur", "vi", "th", "sw", "pt", "es", "fr", "tr", "zh"] as const;
/** Topic hubs on the website (/topic/<slug>); 0-3 per item. */
export const WEB_TOPICS = ["nfp", "cpi", "fomc", "fed-speakers", "yields", "dollar", "oil", "middle-east", "russia-ukraine", "china", "tariffs", "central-banks", "gold-demand", "us-economy"] as const;
export type WebTranslation = { h: string; n: string; w: string; y: string; s: string; d: string };

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
Return JSON {headline, summary, note, why, driver, category, impact, watch, topics, tr}.
headline: the news fact in plain English, max 110 characters, no emoji, no media or source names, no quotes around it.
summary: facts only, readable on their own by a free visitor before the gold interpretation unlocks: what happened, who said it, the actual number against forecast and previous when given. For kind "alert" one sentence (max 200 characters); for kind "desk" 1-2 sentences on what moved (max 400 characters). No effect on gold, no bullish/bearish, no causal arrows, no "which means".
note: for kind "alert" 1-2 short sentences (max 280 characters) on why it matters for gold (through yields, the dollar, oil, risk or safe-haven demand); for kind "desk" a compact summary of the update in 3-6 sentences (max 900 characters).
category: "fed" (Fed and other central banks, officials, rates), "data" (economic data releases, yields, the dollar), "geopolitics" (war, sanctions, diplomacy, trade policy), "oil" (oil, fuel, energy supply), "markets" (anything else).
impact: the potential effect on gold stated or implied by the post: "bullish", "bearish", "mixed" (forces pull both ways) or "neutral".
watch: what to watch next, max 60 characters, empty string if the post gives nothing.
why: the causal chain to gold in one line with arrows, max 120 characters, e.g. "Higher real yields → opportunity cost of holding gold rises → pressure on XAU"; empty string when the item has no clear channel.
topics: 0-3 topic hubs this item belongs to, only when clearly about them: nfp (payrolls, jobs reports, jobless claims), cpi (CPI, PCE, inflation data), fomc (Fed rate decisions, minutes, dot plot), fed-speakers (remarks by Fed officials), yields (Treasury yields, bond market), dollar (DXY, US dollar moves), oil (oil, OPEC, fuel), middle-east (Israel, Iran, Gulf, Hormuz, Red Sea), russia-ukraine, china (China economy, PBoC, US-China), tariffs (trade policy, tariffs, sanctions on trade), central-banks (non-Fed central banks, central-bank gold buying), gold-demand (ETF flows, physical demand, COMEX, imports/exports), us-economy (GDP, ISM, retail sales, other US data).
driver: the main driver of the gold move in 2-5 words, an arrow allowed (e.g. "Labor weakness → yields", "Real yields", "Safe-haven demand", "Oil supply risk"); empty string when there is none.
tr: the same headline (h), summary (s), note (n), watch (w), why (y) and driver (d) translated for these site languages: id Indonesian, ar Arabic, hi Hindi, ur Urdu, vi Vietnamese, th Thai, sw Swahili (East Africa: Kenya, Tanzania), pt Brazilian Portuguese, es Latin American Spanish, fr French, tr Turkish, zh Simplified Chinese. Natural financial-news wording; keep tickers and names (XAU, Fed, ECB, DXY, CPI, NFP) as they are; empty English fields stay empty.
Use only facts in the input. Never write price levels, zones, entries, targets, stop-loss or buy/sell calls. Never mention Telegram, bots, AI or the post itself.`;
