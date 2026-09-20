import type { NewsArticle, NewsProvider } from "../types.js";

const query = [
  'Federal Reserve OR Fed OR Powell OR CPI OR PCE OR NFP OR "Treasury yields" OR DXY OR dollar',
  'gold OR XAUUSD OR oil OR Iran OR Russia OR Ukraine OR China OR tariffs OR sanctions OR war'
].join(" OR ");

function text(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\/${tag}>`, "i"));
  return (match?.[1] ?? "").replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

export class GoogleNewsRssProvider implements NewsProvider {
  readonly name = "google-news-rss";
  constructor(readonly pollIntervalSeconds = 15 * 60) {}

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", query);
    url.searchParams.set("hl", "en-US");
    url.searchParams.set("gl", "US");
    url.searchParams.set("ceid", "US:en");
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 HitnRunNewsMonitor/1.0" } });
    if (!response.ok) throw new Error(`Google News RSS failed: ${response.status}`);
    const xml = await response.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].flatMap(([, item]) => {
      const title = text(item, "title");
      const link = text(item, "link");
      const publishedAt = new Date(text(item, "pubDate"));
      if (!title || !link || Number.isNaN(publishedAt.getTime()) || publishedAt < since) return [];
      return [{ provider: "google-news-rss", providerId: link, title, summary: text(item, "description"), url: link, publishedAt, sourceName: text(item, "source") || "Google News RSS" }];
    });
  }
}
