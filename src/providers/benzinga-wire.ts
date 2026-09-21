import type { NewsArticle, NewsProvider } from "../types.js";

// Benzinga News API -- the closest thing to a real prop-desk newswire this repo can
// reach programmatically. Benzinga Pro (the $37-197/mo terminal with audio "squawk")
// is a human UI product with no documented API; this instead uses Benzinga's actual
// News REST API (docs.benzinga.com, distributed via the Massive marketplace),
// Individual plan $99/mo, real-time in-house-reported headlines -- not an aggregator
// repackaging other outlets, which is what makes it faster than GNews/Marketaux for
// breaking macro and gold-moving headlines.
//
// Requires BENZINGA_API_KEY. Disabled (skipped, not thrown) when absent, same pattern
// as every other optional provider in this repo -- this layer never takes down the
// rest of the pipeline.
//
// UNVERIFIED AGAINST A LIVE KEY: built from Benzinga's published API docs
// (api.benzinga.com/api/v2/news), not tested end-to-end, because getting an API key
// requires signing up and paying for a plan -- that account/billing step is the
// user's own action, not something done on their behalf. Once BENZINGA_API_KEY is
// set, watch Render's Logs tab for "Provider polling failed" with provider=benzinga
// to catch any param mismatch, and for how many benzinga-sourced items reach
// "Article sent to Telegram" to judge whether the topics list below is too noisy or
// too quiet.
//
// No documented hard rate limit as of writing; default poll is 30s to stay well
// clear of anything reasonable for a $99/mo individual plan. Raise
// BENZINGA_POLL_SECONDS if Benzinga ever pushes back with 429s.
const TOPICS = ["gold", "XAUUSD", "DXY", "Bullion", "Safe haven", "Federal Reserve", "FOMC", "Powell", "Warsh", "Waller", "Bowman", "Barr", "Cook", "Jefferson", "Williams", "Daly", "Bostic", "Goolsbee", "Logan", "Musalem", "Schmid", "Collins", "Hammack", "Kashkari", "CPI", "PCE", "NFP", "PPI", "GDP", "Treasury yields", "Treasury", "Bessent", "tariffs", "ECB", "BOE", "BOJ", "PBOC", "China", "Taiwan", "war", "Iran", "Israel", "Russia", "oil", "WTI", "Brent", "Crude Oil", "OPEC", "sanctions", "Houthi", "missile", "strike", "Trump", "Vance", "Lutnick", "Hassett", "Navarro", "Miran", "Lagarde", "Bailey", "Ueda", "Putin", "Zelenskiy", "central bank gold buying", "gold reserves", "World Gold Council", "gold demand", "gold ETF", "GLD", "COMEX gold", "gold futures positioning", "CFTC gold positioning", "de-dollarization", "gold supply", "gold premium", "gold net short", "gold net long", "XAU net short", "XAU net long", "COMEX gold net short", "COMEX gold net long", "oil net short", "oil net long", "crude net short", "crude net long", "WGC", "COT", "Commitments of Traders", "CFTC", "XAU", "XAU/USD", "COMEX", "LBMA", "Shanghai Gold Exchange", "EIA", "API crude", "OPEC+", "Aramco", "Saudi Aramco", "crude inventories", "oil inventories", "GBP", "pound sterling", "Bank of England", "CAD", "Bank of Canada", "BOC", "Macklem", "EUR", "euro", "Eurozone", "European Central Bank"].join(",");
type BenzingaArticle = {
            id?: number | string;
    created?: string;
    title?: string;
    teaser?: string;
    body?: string;
    url?: string;
};

export class BenzingaWireProvider implements NewsProvider {
    readonly name = "benzinga";

  constructor(private readonly apiKey: string, readonly pollIntervalSeconds = 30) {}

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
        const url = new URL("https://api.benzinga.com/api/v2/news");
        url.searchParams.set("token", this.apiKey);
        url.searchParams.set("topics", TOPICS);
        url.searchParams.set("topic_group_by", "or");
        url.searchParams.set("displayOutput", "abstract");
        url.searchParams.set("pageSize", "50");
        url.searchParams.set("sort", "created:desc");
        url.searchParams.set("publishedSince", String(Math.floor(since.getTime() / 1000)));

      const response = await fetch(url, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`Benzinga failed: ${response.status} ${await response.text()}`);
        const raw = (await response.json()) as unknown;
        const list: BenzingaArticle[] = Array.isArray(raw) ? (raw as BenzingaArticle[]) : Array.isArray((raw as { data?: unknown })?.data) ? ((raw as { data: BenzingaArticle[] }).data) : [];

      return list.flatMap((article) => {
              if (!article.title || !article.url || !article.created) return [];
              const publishedAt = new Date(article.created);
              if (Number.isNaN(publishedAt.getTime()) || publishedAt < since) return [];
              return [
                {
                            provider: this.name,
                            providerId: String(article.id ?? article.url),
                            title: article.title,
                            summary: article.teaser ?? "",
                            url: article.url,
                            publishedAt,
                            sourceName: "Benzinga"
                } satisfies NewsArticle
                      ];
      });
  }
}
