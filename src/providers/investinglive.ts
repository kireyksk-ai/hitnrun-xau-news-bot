import pino from "pino";
import type { NewsArticle, NewsProvider } from "../types.js";
import { benzingaTopicHits } from "./benzinga-wire.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

/**
 * investingLive (formerly ForexLive): a macro/FX desk that posts Fed speaker lines, data prints and
 * central-bank headlines within minutes ("Fed's Williams: ...", "US durable goods 0.0% vs -0.4% expected").
 * Benzinga via Massive carries editorial articles (mostly equities) and missed these, e.g. no Schmid line
 * on 2026-09-25 while he was speaking. Public RSS, no key. Education, crypto and pure technical-analysis
 * posts are dropped by the same macro topic gate Benzinga uses.
 */
const FEED = "https://investinglive.com/feed";
// A data print ("... 0.0% vs -0.4% expected") or any central-banker line is in scope even without a listed topic word.
const PRINT_OR_OFFICIAL = /\bvs\.?\s[^,;]*\b(expected|estimate|exp|prior)\b|\b(Fed|ECB|BOE|BOJ|SNB|RBA|BOC|PBOC)(?:'s|\s+(?:chair|governor|president))\b/i;
const SKIP = /\b(technical analysis|how to|why risk management|trading psychology|ethereum|bitcoin|crypto|solana|xrp|blockchain|webinar|podcast|session wrap|morning kickstart|option expiries)\b/i;

function decode(value: string): string {
  return value.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&#8217;|&rsquo;/g, "'").replace(/&#8216;|&lsquo;/g, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
}
const tag = (chunk: string, name: string) => decode(chunk.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? "");

export function parseInvestingLive(xml: string, since: Date): NewsArticle[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].flatMap(([, item]) => {
    const title = tag(item, "title"), url = tag(item, "link"), publishedAt = new Date(tag(item, "pubDate"));
    if (!title || !url || Number.isNaN(publishedAt.getTime()) || publishedAt < since) return [];
    const summary = (tag(item, "description") || tag(item, "content:encoded")).slice(0, 600);
    if (SKIP.test(title) || (!PRINT_OR_OFFICIAL.test(title) && !benzingaTopicHits(`${title} ${summary.slice(0, 300)}`).length)) return [];
    return [{ provider: "investinglive", providerId: url, title, summary, url, publishedAt, sourceName: "investingLive",
      sourceMeta: { stableId: url, sourceClass: "FAST_WIRE" as const } } satisfies NewsArticle];
  });
}

export class InvestingLiveProvider implements NewsProvider {
  readonly name = "investinglive";
  constructor(readonly pollIntervalSeconds = 60) {}
  async fetchLatest(since: Date): Promise<NewsArticle[]> {
    const response = await fetch(FEED, { headers: { Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`investingLive failed: ${response.status}`);
    const xml = await response.text();
    const items = parseInvestingLive(xml, since);
    log.info({ provider: this.name, inFeed: (xml.match(/<item>/gi) ?? []).length, matched: items.length }, "investingLive poll summary");
    return items;
  }
}
