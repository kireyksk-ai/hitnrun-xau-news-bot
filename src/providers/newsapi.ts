import type { NewsArticle, NewsProvider } from "../types.js";

type NewsApiResponse = { articles?: Array<{ title?: string; description?: string; url?: string; publishedAt?: string; source?: { name?: string } }> };

/** Replace or add providers without touching the editorial pipeline. */
export class NewsApiProvider implements NewsProvider {
  /**
   * NewsAPI is a licensed aggregator.  Restrict this additional discovery
   * lane to quality wire domains instead of scraping their websites.  It is
   * deliberately independent of the general RSS/social providers.
   */
  readonly name = "newsapi-wires";
  constructor(private readonly apiKey: string, readonly pollIntervalSeconds = 45) {}

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
    const query = [
      "Federal Reserve OR Fed OR CPI OR PCE OR NFP OR Treasury yields OR DXY",
      "oil OR energy OR sanctions OR tariffs OR China OR Russia OR Iran OR Hormuz OR tanker OR shipping"
    ].join(" OR ");
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("q", query);
    url.searchParams.set("from", since.toISOString());
    url.searchParams.set("sortBy", "publishedAt");
    url.searchParams.set("language", "en");
    url.searchParams.set("pageSize", "100");
    // Reuters content is consumed only through the configured NewsAPI license;
    // do not fetch Reuters, Bloomberg, AP or FT pages directly.
    url.searchParams.set("domains", "reuters.com,apnews.com,ft.com,bloomberg.com");

    const response = await fetch(url, { headers: { "X-Api-Key": this.apiKey } });
    if (!response.ok) throw new Error(`NewsAPI failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as NewsApiResponse;
    return (body.articles ?? []).flatMap((article, index) => {
      if (!article.title || !article.url || !article.publishedAt) return [];
      const publishedAt = new Date(article.publishedAt);
      if (Number.isNaN(publishedAt.getTime()) || publishedAt < since) return [];
      return [{ provider: this.name, providerId: article.url || String(index), title: article.title,
        summary: article.description ?? "", url: article.url, publishedAt: new Date(article.publishedAt), sourceName: article.source?.name }];
    });
  }
}
