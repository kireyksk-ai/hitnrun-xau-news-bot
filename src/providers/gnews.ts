import type { NewsArticle, NewsProvider } from "../types.js";

type GNewsResponse = {
  articles?: Array<{
    title?: string;
    description?: string;
    content?: string;
    url?: string;
    publishedAt?: string;
    source?: { name?: string };
  }>;
};

/** Local safeguard kept below the GNews Essential 1,000-request daily allowance. */
export class GNewsDailyLimitError extends Error {
  constructor() {
    super("GNews local daily safety limit reached");
    this.name = "GNewsDailyLimitError";
  }
}

export class GNewsProvider implements NewsProvider {
  readonly name = "gnews";
  private requestDay = "";
  private requestsToday = 0;
  private readonly maxRequestsPerDay = 900;

  constructor(private readonly apiKey: string, readonly pollIntervalSeconds = 120) {}

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
    const utcDay = new Date().toISOString().slice(0, 10);
    if (utcDay !== this.requestDay) {
      this.requestDay = utcDay;
      this.requestsToday = 0;
    }
    if (this.requestsToday >= this.maxRequestsPerDay) throw new GNewsDailyLimitError();
    this.requestsToday += 1;

    const url = new URL("https://gnews.io/api/v4/search");
    url.searchParams.set("q", 'gold OR XAUUSD OR "Federal Reserve" OR Powell OR CPI OR PCE OR NFP OR DXY OR "Treasury yields" OR Iran OR oil OR sanctions OR tariffs');
    url.searchParams.set("lang", "en");
    url.searchParams.set("max", "10");
    url.searchParams.set("apikey", this.apiKey);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GNews failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as GNewsResponse;
    return (body.articles ?? []).flatMap((article, index) => {
      if (!article.title || !article.url || !article.publishedAt) return [];
      const publishedAt = new Date(article.publishedAt);
      if (Number.isNaN(publishedAt.getTime()) || publishedAt < since) return [];
      return [{
        provider: this.name,
        providerId: article.url || String(index),
        title: article.title,
        summary: article.content ?? article.description ?? "",
        url: article.url,
        publishedAt,
        sourceName: article.source?.name
      }];
    });
  }
}
