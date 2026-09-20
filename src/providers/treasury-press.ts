import type { NewsArticle, NewsProvider } from "../types.js";

// Treasury killed its public RSS feed (now GovDelivery email-only), but
// home.treasury.gov's own site search is backed by a clean per-year JSON
// index at /news-data/<category>/search/<year>.json -- this reads that
// directly instead of scraping rendered HTML. If Treasury restructures
// their site, this JSON path is the first thing to re-check.
type Feed = { name: string; category: string; sourceName: string };

const feeds: Feed[] = [
  { name: "treasury-statements", category: "statements-remarks", sourceName: "U.S. Treasury (Statements & Remarks)" },
  { name: "treasury-press", category: "press-releases", sourceName: "U.S. Treasury (Press Releases)" }
  ];

type TreasuryItem = { datetime: string; title: string; url: string };
type TreasuryYearIndex = { items?: TreasuryItem[] };

async function readFeed(feed: Feed, since: Date): Promise<NewsArticle[]> {
    const year = new Date().getUTCFullYear();
    const response = await fetch(`https://home.treasury.gov/news-data/${feed.category}/search/${year}.json`, {
          headers: {
                  Accept: "application/json",
                  "User-Agent": "Mozilla/5.0 (compatible; HitnRunFX/1.0; +https://github.com/kireyksk-ai/hitnrun-xau-news-bot)"
          }
    });
    if (!response.ok) throw new Error(feed.name + " failed: " + response.status);

  const payload = (await response.json()) as TreasuryYearIndex;
    return (payload.items ?? []).flatMap((item) => {
          const publishedAt = new Date(item.datetime);
          if (!item.title || !item.url || Number.isNaN(publishedAt.getTime()) || publishedAt < since) return [];
          const url = new URL(item.url, "https://home.treasury.gov").toString();
          return [{
                  provider: feed.name,
                  providerId: url,
                  title: item.title,
                  summary: item.title,
                  url,
                  publishedAt,
                  sourceName: feed.sourceName
          }];
    });
}

/** Official U.S. Treasury statements/press releases. Treasury has no public RSS
 *  anymore (GovDelivery email-only), so this reads the JSON index behind their
 *  own site search instead. */
export class TreasuryPressProvider implements NewsProvider {
    readonly name = "treasury-press";
    constructor(readonly pollIntervalSeconds = 3 * 60) {}

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
        const settled = await Promise.allSettled(feeds.map((feed) => readFeed(feed, since)));
        const successes = settled.filter((result): result is PromiseFulfilledResult<NewsArticle[]> => result.status === "fulfilled");
        if (successes.length === 0) throw new Error("All Treasury feeds are unavailable");
        return successes.flatMap((result) => result.value);
  }
}
