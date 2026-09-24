import pino from "pino";
import type { NewsArticle, NewsProvider } from "./types.js";
import { realisedVol, series } from "./brain-market.js";
import { tokens } from "./shadow-outcomes.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

/**
 * News hunter: the bot chases news instead of only waiting for it.
 *  - When gold moves abnormally and no alert explains it, it searches for the cause
 *    (gold + whichever of dollar / yields / oil moved with it).
 *  - After every published alert it follows the developing story for two hours
 *    (confirmations, denials, details, reactions).
 *  - Around every high-impact release it searches for the print itself.
 *  - When the regime shifts it searches for what drove the shift.
 * Everything found goes through the normal pipeline, so duplicates are dropped
 * and only genuinely new facts can be published.
 */
export type HuntTarget = { key: string; query: string; reason: string; until: number; everyMs: number; lastRunAt: number; hits: number };

const STOP = new Set(["says", "said", "will", "would", "could", "after", "with", "from", "that", "this", "have", "been", "more", "than", "into", "over", "amid"]);
/** Search terms for a follow-up of a published headline: the most distinctive words. */
export function followUpQuery(title: string): string | undefined {
  const words = [...tokens(title.replace(/^@\w+:\s*/, ""))].filter((w) => w.length > 3 && !STOP.has(w) && !/^\d/.test(w)).slice(0, 4);
  return words.length >= 2 ? words.join(" ") : undefined;
}

/** Abnormal XAU move over the last 15 minutes (vs realised volatility), with the assets that moved with it. */
export async function abnormalMove(now = Date.now(), fetcher: typeof fetch = fetch): Promise<{ xau: number; drivers: string[] } | undefined> {
  const xau = await series("XAU", "1m", fetcher);
  if (xau.length < 30 || now - xau[xau.length - 1][0] > 10 * 60_000) return undefined;
  const end = xau[xau.length - 1], start = [...xau].reverse().find(([t]) => t <= end[0] - 15 * 60_000);
  if (!start) return undefined;
  const move = (end[1] - start[1]) / start[1] * 100;
  const sigma = realisedVol(xau, start[0], 120) ?? 0.03;
  if (Math.abs(move) < Math.max(0.3, 3 * sigma * Math.sqrt(15))) return undefined;
  const drivers: string[] = [];
  for (const [asset, term, min] of [["DXY", "dollar", 0.15], ["US10Y", "Treasury yields", 3], ["WTI", "oil prices", 0.8]] as const) {
    const bars = await series(asset, "1m", fetcher); if (bars.length < 2) continue;
    const e = bars[bars.length - 1], s = [...bars].reverse().find(([t]) => t <= e[0] - 15 * 60_000); if (!s) continue;
    const m = asset === "US10Y" ? (e[1] - s[1]) * 100 : (e[1] - s[1]) / s[1] * 100;
    if (Math.abs(m) >= min) drivers.push(term);
  }
  return { xau: +move.toFixed(2), drivers };
}

export function parseRss(xml: string, since: Date): NewsArticle[] {
  const text = (item: string, tag: string) => (item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ?? "")
    .replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").trim();
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].flatMap(([, item]) => {
    const title = text(item, "title"), link = text(item, "link") || text(item, "guid"), publishedAt = new Date(text(item, "pubDate"));
    if (!title || !link || Number.isNaN(publishedAt.getTime()) || publishedAt < since) return [];
    return [{ provider: "news-hunter", providerId: link, title, summary: text(item, "description"), url: link, publishedAt, sourceName: text(item, "source") || "Google News RSS" }];
  });
}

export class NewsHunter implements NewsProvider {
  readonly name = "news-hunter";
  private targets = new Map<string, HuntTarget>();
  constructor(readonly pollIntervalSeconds = 30, private readonly maxQueriesPerPoll = 3, private readonly fetcher: typeof fetch = fetch) {}

  /** Adds (or extends) a hunt. */
  hunt(key: string, query: string, reason: string, minutes: number, everySeconds: number, now = Date.now()): void {
    const existing = this.targets.get(key);
    this.targets.set(key, existing ? { ...existing, until: Math.max(existing.until, now + minutes * 60_000) }
      : { key, query, reason, until: now + minutes * 60_000, everyMs: everySeconds * 1000, lastRunAt: 0, hits: 0 });
    if (!existing) log.info({ key, query, reason, minutes }, "Brain hunt started");
  }
  active(now = Date.now()): HuntTarget[] { for (const [k, t] of this.targets) if (t.until < now) this.targets.delete(k); return [...this.targets.values()]; }

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
    const now = Date.now();
    const due = this.active(now).filter((t) => now - t.lastRunAt >= t.everyMs).sort((a, b) => a.lastRunAt - b.lastRunAt).slice(0, this.maxQueriesPerPoll);
    const out: NewsArticle[] = [];
    for (const t of due) {
      t.lastRunAt = now;
      try {
        const url = new URL("https://news.google.com/rss/search");
        url.searchParams.set("q", `${t.query} when:1h`); url.searchParams.set("hl", "en-US"); url.searchParams.set("gl", "US"); url.searchParams.set("ceid", "US:en");
        const r = await this.fetcher(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; HitnRunMarketMonitor/1.0)", Accept: "application/rss+xml, application/xml" }, signal: AbortSignal.timeout(12_000) });
        if (!r.ok) throw new Error(`hunt RSS ${r.status}`);
        const items = parseRss(await r.text(), new Date(Math.max(since.getTime(), now - 90 * 60_000))).slice(0, 15);
        t.hits += items.length;
        if (items.length) log.info({ key: t.key, query: t.query, reason: t.reason, found: items.length }, "Brain hunt result");
        out.push(...items);
      } catch (error) { log.warn({ err: error, key: t.key }, "Brain hunt failed"); }
    }
    return out;
  }
}

/** Keys make sure one situation is hunted once, not every minute. */
export function huntKeys(now = Date.now()): { move: string } { return { move: `move-${Math.floor(now / (30 * 60_000))}` }; }
