import pino from "pino";
import type { NewsArticle, NewsProvider } from "../types.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

// Benzinga News API -- the closest thing to a real prop-desk newswire this repo can
// reach programmatically. Benzinga Pro (the $37-197/mo terminal with audio "squawk")
// is a human UI product with no documented API; this instead uses Benzinga's News
// REST API as resold through the Massive marketplace (massive.com), Individual plan
// $99/mo, real-time in-house-reported headlines -- not an aggregator repackaging
// other outlets, which is what makes it faster than GNews/Marketaux for breaking
// macro and gold-moving headlines.
//
// IMPORTANT: a Massive-purchased subscription is NOT the same product as a key from
// Benzinga's own developer console. This was originally built against Benzinga's
// direct API (api.benzinga.com, token= query param, topics= server-side OR filter)
// because that's what docs.benzinga.com documents -- but a Massive-issued key is
// rejected by that endpoint ("401 Access denied for user 0 anonymous"), because it's
// only valid against Massive's own proxy at api.massive.com. Verified live against
// docs.massive.com/docs/rest/partners/benzinga/news on 2026-09-21 after the first
// version of this file failed 100% of polls since it was deployed:
//   - base URL: https://api.massive.com/benzinga/v2/news
//   - auth: apiKey= query param (not token=)
//   - response: { count, request_id, results: [...], status } (not a bare array)
//   - article fields: benzinga_id, title, teaser, body, url, published (not id/created)
//   - NO free-text/keyword search param exists at all (no topics=, no q=, no search=).
//     Filtering is only possible via tags=/channels=/tickers=/stocks=/author=, all of
//     which match Benzinga's own fixed editorial taxonomy (e.g. "earnings", "movers",
//     "why it's moving"), not free text -- so the 124-term keyword list below, sent
//     as a query param, would have matched nothing even with correct auth.
//
// Fix: fetch the most recent articles unfiltered (limit=50, sort=published.desc) and
// apply the same curated keyword list CLIENT-SIDE against title+teaser+body before
// handing an article to the shared GPT editor (src/editor.ts). This keeps all the
// precision of the curated list (kept in sync with editor.ts's MANDATORY COVERAGE)
// without depending on a server-side filter Massive's API doesn't offer. Relevance is
// still ultimately decided by editor.assess() downstream, same as every other
// provider in this repo -- this keyword gate only exists to stop a high-volume general
// wire from burning through MAX_AI_ARTICLES_PER_DAY on stock-earnings noise.
//
// A previous version of this file was silent on every poll unless something failed or
// an article was material enough to send to Telegram -- that made it impossible to
// tell, from Render logs alone, whether Benzinga was succeeding-but-filtering-out
// everything, or the request was hanging with no timeout. Fixed below: every poll now
// logs a one-line summary (fetched vs matched count), and the fetch has a 15s
// AbortSignal timeout (same pattern already used in google-news-rss.ts) so a stalled
// request surfaces as a normal "Provider polling failed" error instead of hanging
// silently past the 30s poll interval.
//
// Requires BENZINGA_API_KEY. Disabled (skipped, not thrown) when absent, same pattern
// as every other optional provider in this repo -- this layer never takes down the
// rest of the pipeline.
//
// No documented hard rate limit as of writing; default poll is 30s to stay well
// clear of anything reasonable for a $99/mo individual plan. Raise
// BENZINGA_POLL_SECONDS if Benzinga/Massive ever pushes back with 429s.
const TOPICS = ["gold", "XAUUSD", "DXY", "Bullion", "Safe haven", "Federal Reserve", "FOMC", "Powell", "Warsh", "Waller", "Bowman", "Barr", "Cook", "Jefferson", "Williams", "Daly", "Bostic", "Goolsbee", "Logan", "Musalem", "Schmid", "Collins", "Hammack", "Kashkari", "CPI", "PCE", "NFP", "PPI", "GDP", "PMI", "purchasing managers", "business activity", "S&P Global US", "Treasury yields", "Treasury", "Bessent", "tariffs", "ECB", "BOE", "BOJ", "PBOC", "China", "Taiwan", "war", "Iran", "Israel", "Russia", "oil", "WTI", "Brent", "Crude Oil", "OPEC", "sanctions", "Houthi", "missile", "strike", "Trump", "Vance", "Lutnick", "Hassett", "Navarro", "Miran", "Lagarde", "Bailey", "Ueda", "Putin", "Zelenskiy", "central bank gold buying", "gold reserves", "World Gold Council", "gold demand", "gold ETF", "GLD", "COMEX gold", "gold futures positioning", "CFTC gold positioning", "de-dollarization", "gold supply", "gold premium", "gold net short", "gold net long", "XAU net short", "XAU net long", "COMEX gold net short", "COMEX gold net long", "oil net short", "oil net long", "crude net short", "crude net long", "WGC", "COT", "Commitments of Traders", "CFTC", "XAU", "XAU/USD", "COMEX", "LBMA", "Shanghai Gold Exchange", "EIA", "API crude", "OPEC+", "Aramco", "Saudi Aramco", "crude inventories", "oil inventories", "GBP", "pound sterling", "Bank of England", "CAD", "Bank of Canada", "BOC", "Macklem", "EUR", "euro", "Eurozone", "European Central Bank", "Swiss National Bank", "SNB", "ISM", "ISM Manufacturing", "ISM Services", "Retail Sales", "jobless claims", "initial claims", "housing starts", "consumer confidence", "Michigan consumer sentiment", "rig count"];
const TOPICS_LOWER = [...TOPICS, "OECD", "mortgage rates", "mortgage applications", "Treasury buyback", "debt buyback"].map((topic) => topic.toLowerCase());

type BenzingaArticle = {
      benzinga_id?: number | string;
      published?: string;
      title?: string;
      teaser?: string;
      body?: string;
      url?: string;
      last_updated?: string;
      author?: string;
      channels?: Array<{ name?: string } | string>;
      tags?: Array<{ name?: string } | string>;
      tickers?: Array<{ symbol?: string } | string>;
};

export class BenzingaWireProvider implements NewsProvider {
      readonly name = "benzinga";

    constructor(private readonly apiKey: string, readonly pollIntervalSeconds = 30) {}

    async fetchLatest(since: Date): Promise<NewsArticle[]> {
              const url = new URL("https://api.massive.com/benzinga/v2/news");
              url.searchParams.set("apiKey", this.apiKey);
              url.searchParams.set("limit", "200");
              url.searchParams.set("sort", "published.desc");

          const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
              if (!response.ok) throw new Error(`Benzinga failed: ${response.status} ${await response.text()}`);
              const raw = (await response.json()) as unknown;
              const list: BenzingaArticle[] = Array.isArray((raw as { results?: unknown })?.results) ? ((raw as { results: BenzingaArticle[] }).results) : Array.isArray(raw) ? (raw as BenzingaArticle[]) : [];

          const matched = list.flatMap((article) => {
                        if (!article.title || !article.url || !article.published) return [];
                        const publishedAt = new Date(article.published);
                        if (Number.isNaN(publishedAt.getTime()) || publishedAt < since) return [];
                        const haystack = `${article.title} ${article.teaser ?? ""} ${article.body ?? ""}`.toLowerCase();
                        if (!TOPICS_LOWER.some((topic) => haystack.includes(topic))) return [];
                        return [
                          {
                                                provider: this.name,
                                                providerId: String(article.benzinga_id ?? article.url),
                                                title: article.title,
                                                // Full bodies are transient only: useful for the deterministic topic gate,
                                                // never persisted or exposed to Telegram by default.
                                                summary: article.teaser ?? "",
                                                url: article.url,
                                                publishedAt,
                                                sourceName: "Benzinga",
                                                author: article.author,
                                                sourceMeta: { stableId: String(article.benzinga_id ?? article.url), updatedAt: article.last_updated,
                                                  authorId: article.author, channels: (article.channels ?? []).map((x) => typeof x === "string" ? x : x.name ?? "").filter(Boolean),
                                                  tags: (article.tags ?? []).map((x) => typeof x === "string" ? x : x.name ?? "").filter(Boolean),
                                                  tickers: (article.tickers ?? []).map((x) => typeof x === "string" ? x : x.symbol ?? "").filter(Boolean), sourceClass: "CREDIBLE_REPORTER" }
                          } satisfies NewsArticle
                                      ];
          });

          log.info({ provider: this.name, fetched: list.length, matched: matched.length }, "Benzinga poll summary");
              return matched;
    }
}
