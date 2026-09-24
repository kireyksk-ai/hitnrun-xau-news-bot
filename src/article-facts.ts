import * as cheerio from "cheerio";
import type { CalendarEvent } from "./economic-calendar.js";

/**
 * Gives Sol the facts a headline leaves out: the sentences of the source page that carry
 * numbers, comparisons and policy changes, plus the calendar actual/forecast/prior when the
 * headline is about a scheduled release. Never invents: only text found on the page or feed.
 */
const SKIP_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.co|truthsocial\.com|news\.google\.com|bloomberg\.com|wsj\.com|ft\.com|barrons\.com)$/i;
const KEY = /\b(expected|forecast|consensus|estimate|economists|previous|prior|revised|rose|fell|increase|decrease|jumped|slowed|accelerat|percent|basis points?|bps?|year-on-year|annual|monthly|rate|yield|inflation|tariff|sanction|barrel|ounce|tonnes?|billion|million|cut|hike|hold)\b/i;

export function extractFacts(html: string, maxChars = 900): string {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, aside, header, form, noscript").remove();
  const scope = $("article").length ? $("article") : $("main").length ? $("main") : $("body");
  let text = scope.find("p").map((_, p) => $(p).text().replace(/\s+/g, " ").trim()).get().filter((p) => p.length > 40).join(" ");
  if (!text) text = ($('meta[property="og:description"]').attr("content") ?? $('meta[name="description"]').attr("content") ?? "").trim();
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z"“])/).map((s) => s.trim()).filter((s) => s.length > 30 && s.length < 400);
  const scored = sentences.map((s, i) => ({ s, i, score: (/\d/.test(s) ? 2 : 0) + (KEY.test(s) ? 1 : 0) })).filter((x) => x.score >= 2);
  const picked: typeof scored = [];
  let len = 0;
  for (const x of [...scored].sort((a, b) => b.score - a.score || a.i - b.i)) { if (len + x.s.length > maxChars) continue; picked.push(x); len += x.s.length + 1; }
  return picked.sort((a, b) => a.i - b.i).map((x) => x.s).join(" ");
}

/** Headline/summary already rich enough (long, with numbers)? Then no page fetch is needed. */
export function needsFacts(title: string, summary: string): boolean {
  const body = summary.split("\n\nMARKET_CONTEXT_PACK")[0];
  return body.length < 400 || !/\d/.test(`${title} ${body}`);
}

export async function fetchFacts(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  let host = "";
  try { host = new URL(url).hostname; } catch { return ""; }
  if (!/^https?:/.test(url) || SKIP_HOSTS.test(host)) return "";
  const r = await fetcher(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; HitnRunMarketMonitor/1.0)", Accept: "text/html" }, signal: AbortSignal.timeout(4000), redirect: "follow" });
  if (!r.ok || !/html/i.test(r.headers.get("content-type") ?? "html")) return "";
  const html = (await r.text()).slice(0, 1_500_000);
  return extractFacts(html);
}

const NAME_STOP = new Set(["index", "rate", "change", "final", "prelim", "flash", "the", "and", "m/m", "y/y", "q/q", "mom", "yoy"]);
/** The calendar row a headline is about (same release words, released within the last 12 hours or due within 3). */
export function calendarMatch(text: string, events: CalendarEvent[], now = Date.now()): string {
  const t = text.toLowerCase();
  const hits = events.filter((e) => {
    const at = Date.parse(e.releaseAt);
    if (now - at > 12 * 3600_000 || at - now > 3 * 3600_000) return false;
    const words = e.name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !NAME_STOP.has(w));
    return words.length > 0 && words.filter((w) => t.includes(w)).length >= Math.min(2, words.length);
  }).slice(0, 3);
  return hits.map((e) => `${e.country} ${e.name}: aktual ${e.actual ?? "belum rilis"}, perkiraan ${e.consensus ?? "n/a"}, sebelumnya ${e.prior ?? "n/a"} (rilis ${e.releaseAt})`).join("; ");
}
