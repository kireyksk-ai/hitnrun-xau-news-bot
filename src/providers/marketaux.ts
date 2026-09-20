import type { NewsArticle, NewsProvider } from "../types.js";

// Marketaux -- finance-specific news aggregator, meant to replace GNews as the
// "general market news" discovery layer. NOT a Fed/Treasury speed fix -- that
// gap is already closed for free by official-macro-rss.ts and
// treasury-press.ts, which hit government sources directly instead of waiting
// to be indexed. No aggregator API (Marketaux, Benzinga, Polygon included)
// specializes in central-bank/Treasury statements -- they're all
// equity/company-news-centric with the same inherent indexing lag GNews has.
// This provider exists to give broader/better-tagged general market-news
// coverage than the free Google News RSS fallback, nothing more.
//
// FREE TIER: 100 requests/day, 3 articles/request (marketaux.com/pricing).
// The local daily counter below keeps this well under that even if
// MARKETAUX_POLL_SECONDS is set too aggressively -- default is a 20-minute
// poll (~72 requests/day), leaving headroom. Paid plans start at $29/mo for
// higher daily limits -- verify current pricing yourself before upgrading.
//
// Requires MARKETAUX_API_KEY. Disabled (skipped, not thrown) when absent, so
// this optional layer never takes down the rest of the pipeline -- same
// pattern as every other optional provider in this repo.
const QUERY = 'gold OR XAUUSD OR "Federal Reserve" OR Powell OR CPI OR PCE OR NFP OR DXY OR "Treasury yields" OR Iran OR oil OR sanctions OR tariffs';

type MarketauxResponse = {
    data?: Array<{
          uuid?: string;
          title?: string;
          description?: string;
          snippet?: string;
          url?: string;
          published_at?: string;
          source?: string;
    }>;
};

/** Local safeguard kept below the Marketaux free-tier 100-request daily allowance. */
export class MarketauxDailyLimitError extends Error {
    constructor() {
          super("Marketaux local daily safety limit reached");
          this.name = "MarketauxDailyLimitError";
    }
}

export class MarketauxProvider implements NewsProvider {
    readonly name = "marketaux";
    private requestDay = "";
    private requestsToday = 0;
    private readonly maxRequestsPerDay = 90;

  constructor(private readonly apiKey: string, readonly pollIntervalSeconds = 20 * 60) {}

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
        const utcDay = new Date().toISOString().slice(0, 10);
        if (utcDay !== this.requestDay) {
                this.requestDay = utcDay;
                this.requestsToday = 0;
        }
        if (this.requestsToday >= this.maxRequestsPerDay) throw new MarketauxDailyLimitError();
        this.requestsToday += 1;

      const url = new URL("https://api.marketaux.com/v1/news/all");
        url.searchParams.set("search", QUERY);
        url.searchParams.set("language", "en");
        url.searchParams.set("limit", "3");
        url.searchParams.set("sort", "published_desc");
        url.searchParams.set("api_token", this.apiKey);

      const response = await fetch(url);
        if (!response.ok) throw new Error(`Marketaux failed: ${response.status} ${await response.text()}`);
        const body = (await response.json()) as MarketauxResponse;

      return (body.data ?? []).flatMap((article) => {
              if (!article.title || !article.url || !article.published_at) return [];
              const publishedAt = new Date(article.published_at);
              if (Number.isNaN(publishedAt.getTime()) || publishedAt < since) return [];
              return [
                {
                            provider: this.name,
                            providerId: article.uuid ?? article.url,
                            title: article.title,
                            summary: article.snippet ?? article.description ?? "",
                            url: article.url,
                            publishedAt,
                            sourceName: article.source
                } satisfies NewsArticle
                      ];
      });
  }
}
