import type { NewsArticle, NewsProvider } from "../types.js";

type Feed = { name: string; url: string; sourceName: string; matches: RegExp };

const feeds: Feed[] = [
  { name: "fed-rss", url: "https://www.federalreserve.gov/feeds/press_all.xml", sourceName: "Federal Reserve", matches: /fomc|monetary policy|federal funds|interest rate|powell|balance sheet|quantitative|liquidity/i },
  { name: "bls-rss", url: "https://www.bls.gov/feed/bls_latest.rss", sourceName: "U.S. Bureau of Labor Statistics", matches: /consumer price|cpi|employment situation|nonfarm|payroll|unemployment|producer price|ppi|employment cost/i },
  { name: "bea-rss", url: "https://apps.bea.gov/rss/rss.xml", sourceName: "U.S. Bureau of Economic Analysis", matches: /gross domestic product|\bgdp\b|personal income|personal consumption|\bpce\b|personal income and outlays/i }
];

function decode(value: string): string {
  return value.replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

function tag(chunk: string, name: string): string {
  const found = chunk.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\/${name}>`, "i"));
  return decode(found?.[1] ?? "");
}

function link(chunk: string): string {
  const atom = chunk.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1];
  return atom ?? tag(chunk, "link");
}

/** Direct public feeds for the US releases that most often move DXY and XAUUSD. */
export class OfficialMacroRssProvider implements NewsProvider {
  readonly name = "official-macro-rss";
  constructor(readonly pollIntervalSeconds = 5 * 60) {}

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
    const results = await Promise.all(feeds.map(async (feed) => {
      const response = await fetch(feed.url, { headers: { "User-Agent": "HitnRunMacroMonitor/1.0" } });
      if (!response.ok) throw new Error(`${feed.name} failed: ${response.status}`);
      const xml = await response.text();
      const entries = [...xml.matchAll(/<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi)];
      return entries.flatMap(([, entry]) => {
        const title = tag(entry, "title");
        const summary = tag(entry, "description") || tag(entry, "summary") || tag(entry, "content");
        const url = link(entry);
        const publishedAt = new Date(tag(entry, "pubDate") || tag(entry, "published") || tag(entry, "updated"));
        if (!title || !url || Number.isNaN(publishedAt.getTime()) || publishedAt < since) return [];
        if (!feed.matches.test(`${title} ${summary}`)) return [];
        return [{ provider: feed.name, providerId: url, title, summary, url, publishedAt, sourceName: feed.sourceName }];
      });
    }));
    return results.flat();
  }
}
