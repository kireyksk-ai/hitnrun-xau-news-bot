import type { NewsArticle, NewsProvider } from "../types.js";

const query = [
  'Federal Reserve OR Fed OR Powell OR CPI OR PCE OR NFP OR "Treasury yields" OR DXY OR dollar',
  'gold OR XAUUSD OR oil OR Brent OR WTI OR Iran OR Israel OR Houthi OR Russia OR Ukraine OR China OR tariffs OR sanctions OR war'
].join(" OR ");

const fallbackFeeds = [
  { url: "https://www.aljazeera.com/xml/rss/all.xml", source: "Al Jazeera" },
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml", source: "BBC Business" },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", source: "BBC World" }
];

const relevantHeadline = /\b(gold|xau|dollar|dxy|fed|fomc|powell|inflation|cpi|pce|ppi|nfp|payroll|treasury|yield|oil|brent|wti|iran|israel|houthi|russia|ukraine|china|taiwan|sanction|tariff|war|missile|ceasefire)\b/i;

function text(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return (match?.[1] ?? "")
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " " )
    .trim();
}

function parseFeed(xml: string, since: Date, provider: string, fallbackSource?: string): NewsArticle[] {
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].flatMap(([, item]) => {
    const title = text(item, "title");
    const summary = text(item, "description");
    const link = text(item, "link") || text(item, "guid");
    const publishedAt = new Date(text(item, "pubDate") || text(item, "published"));
    if (!title || !link || Number.isNaN(publishedAt.getTime()) || publishedAt < since || (fallbackSource && !relevantHeadline.test(`${title} ${summary}`))) return [];
    return [{ provider, providerId: link, title, summary, url: link, publishedAt, sourceName: text(item, "source") || fallbackSource || "Google News RSS" }];
  });
}

async function fetchXml(url: URL | string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; HitnRunMarketMonitor/1.0)",
      Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7"
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`RSS request failed: ${response.status}`);
  return response.text();
}

/** Google discovery with direct, free publisher feeds as a Render-safe fallback. */
export class GoogleNewsRssProvider implements NewsProvider {
  readonly name = "google-news-rss";
  constructor(readonly pollIntervalSeconds = 5 * 60) {}

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
    const googleUrl = new URL("https://news.google.com/rss/search");
    googleUrl.searchParams.set("q", query);
    googleUrl.searchParams.set("hl", "en-US");
    googleUrl.searchParams.set("gl", "US");
    googleUrl.searchParams.set("ceid", "US:en");
    try {
      return parseFeed(await fetchXml(googleUrl), since, this.name);
    } catch (googleError) {
      const results = await Promise.allSettled(fallbackFeeds.map(async (feed) => parseFeed(await fetchXml(feed.url), since, this.name, feed.source)));
      const articles = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      if (articles.length || results.some((result) => result.status === "fulfilled")) {
        console.warn(`[google-news-rss] Google unavailable; using direct publisher RSS fallback: ${String(googleError)}`);
        return articles;
      }
      throw googleError;
    }
  }
}
