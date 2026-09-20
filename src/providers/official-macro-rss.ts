import type { NewsArticle, NewsProvider } from "../types.js";

type Feed = { name: string; url: string; sourceName: string; matches: RegExp };

const feeds: Feed[] = [
  { name: "fed-rss", url: "https://www.federalreserve.gov/feeds/press_all.xml", sourceName: "Federal Reserve", matches: /fomc|monetary policy|federal funds|interest rate|powell|balance sheet|quantitative|liquidity/i },
  { name: "bls-rss", url: "https://www.bls.gov/feed/bls_latest.rss", sourceName: "U.S. Bureau of Labor Statistics", matches: /consumer price|cpi|employment situation|nonfarm|payroll|unemployment|producer price|ppi|employment cost/i },
  { name: "bea-rss", url: "https://apps.bea.gov/rss/rss.xml", sourceName: "U.S. Bureau of Economic Analysis", matches: /gross domestic product|\bgdp\b|personal income|personal consumption|\bpce\b|personal income and outlays/i }
];

function decode(value: string): string {
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(chunk: string, name: string): string {
  const found = chunk.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i"));
  return decode(found?.[1] ?? "");
}

function link(chunk: string): string {
  const atom = chunk.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1];
  return atom ?? tag(chunk, "link");
}

async function readFeed(feed: Feed, since: Date): Promise<NewsArticle[]> {
  const response = await fetch(feed.url, {
    redirect: "follow",
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; HitnRunFX/1.0; +https://github.com/kireyksk-ai/hitnrun-xau-news-bot)"
    }
  });
  if (!response.ok) throw new Error(feed.name + " failed: " + response.status);

  const xml = await response.text();
  const entries = [...xml.matchAll(/<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi)];
  return entries.flatMap(([, entry]) => {
    const title = tag(entry, "title");
    const summary = tag(entry, "description") || tag(entry, "summary") || tag(entry, "content");
    const url = link(entry);
    const published = tag(entry, "pubDate") || tag(entry, "updated") || tag(entry, "published");
    const publishedAt = new Date(published);

    if (!title || !url || Number.isNaN(publishedAt.getTime()) || publishedAt < since || !feed.matches.test(title + " " + summary)) return [];
    return [{
      provider: feed.name,
      providerId: url,
      title,
      summary,
      url,
      publishedAt,
      sourceName: feed.sourceName
    }];
  });
}

/** Direct public feeds for the US releases that most often move DXY and XAUUSD. */
export class OfficialMacroRssProvider implements NewsProvider {
  readonly name = "official-macro-rss";
  constructor(readonly pollIntervalSeconds = 5 * 60) {}

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
    const settled = await Promise.allSettled(feeds.map((feed) => readFeed(feed, since)));
    const successes = settled.filter((result): result is PromiseFulfilledResult<NewsArticle[]> => result.status === "fulfilled");
    if (successes.length === 0) throw new Error("All official macro feeds are unavailable");
    return successes.flatMap((result) => result.value);
  }
}
