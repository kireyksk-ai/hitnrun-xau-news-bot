import type { NewsArticle, NewsProvider } from "../types.js";
import { runtimeActorRegistry, sourceClassFor } from "../actor-registry.js";

const WIRE_ACCOUNTS = ["DeItaone", "FirstSquawk", "LiveSquawk", "zerohedge", "unusual_whales", "financialjuice", "WatcherGuru"];

function queryFor(accounts: readonly string[]): string { return [
        `(${accounts.map((handle) => `from:${handle}`).join(" OR ")})`,
        `(Fed OR Powell OR Warsh OR Waller OR Bowman OR Cook OR Jefferson OR Williams OR Daly OR Bostic`,
        `OR Goolsbee OR Logan OR Musalem OR Schmid OR Collins OR Hammack OR Kashkari`,
        `OR CPI OR NFP OR PCE OR PPI OR FOMC OR Treasury OR Bessent OR tariff OR gold OR XAU`,
        `OR China OR Taiwan OR war OR Iran OR Israel OR Russia OR oil OR OPEC OR sanctions OR Houthi OR missile OR strike)`].join(" " ); }

type XApiTweet = { id: string; text: string; created_at: string; author_id: string; conversation_id?: string; edit_history_tweet_ids?: string[]; public_metrics?: Record<string, number> };
type XApiUser = { id: string; username: string };
type XApiSearchResponse = {
  data?: XApiTweet[];
  includes?: { users?: XApiUser[] };
  meta?: { newest_id?: string };
};

let sinceId: string | undefined;

const COST_PER_READ_USD = 0.005;
let billedMonthKey = "";
let monthlyReadsBilled = 0;
let budgetWarningLogged = false;

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
}

export class TwitterWireProvider implements NewsProvider {
  readonly name = "twitter-wire";
  readonly pollIntervalSeconds: number;
  private creditBlocked = false;

  constructor(pollIntervalSeconds = 120, readonly maxMonthlyUsd = 30) {
    this.pollIntervalSeconds = Math.max(120, pollIntervalSeconds);
  }

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
    const token = process.env.X_API_BEARER_TOKEN;
    if (!token || this.creditBlocked) return [];

    const monthKey = currentMonthKey();
    if (monthKey !== billedMonthKey) {
      billedMonthKey = monthKey;
      monthlyReadsBilled = 0;
      budgetWarningLogged = false;
    }

    const estimatedSpendUsd = monthlyReadsBilled * COST_PER_READ_USD;
    if (estimatedSpendUsd >= this.maxMonthlyUsd) {
      if (!budgetWarningLogged) {
        console.warn(`[twitter-wire] Estimated spend ~$${estimatedSpendUsd.toFixed(2)} reached the $${this.maxMonthlyUsd} monthly guard; pausing X reads until next month.`);
        budgetWarningLogged = true;
      }
      return [];
    }

    const url = new URL("https://api.x.com/2/tweets/search/recent");
    const actors = [...new Set([...WIRE_ACCOUNTS, ...runtimeActorRegistry().map((entry) => entry.username)])];
    url.searchParams.set("query", queryFor(actors));
    url.searchParams.set("max_results", "50");
    url.searchParams.set("tweet.fields", "created_at,author_id,conversation_id,edit_history_tweet_ids,public_metrics");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "username");
    if (sinceId) url.searchParams.set("since_id", sinceId);

    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 401 || response.status === 402 || response.status === 403) {
      this.creditBlocked = true;
      console.error(`[twitter-wire] X API returned ${response.status}; provider paused until the service restarts after its token/billing is fixed.`);
      return [];
    }
    if (!response.ok) throw new Error(`X API search failed: ${response.status} ${await response.text()}`);

    const payload = (await response.json()) as XApiSearchResponse;
    if (payload.meta?.newest_id) sinceId = payload.meta.newest_id;
    if (payload.data?.length) monthlyReadsBilled += payload.data.length;
    if (!payload.data?.length) return [];

    const usersById = new Map((payload.includes?.users ?? []).map((user) => [user.id, user.username]));
    return payload.data.flatMap((tweet) => {
      const publishedAt = new Date(tweet.created_at);
      if (Number.isNaN(publishedAt.getTime()) || publishedAt < since) return [];
      const username = usersById.get(tweet.author_id) ?? tweet.author_id;
      return [{
        provider: this.name,
        providerId: tweet.id,
        title: `@${username}: ${tweet.text.slice(0, 200)}`,
        summary: tweet.text,
        url: `https://x.com/${username}/status/${tweet.id}`,
        publishedAt,
        sourceName: "X / Twitter Wire"
        ,sourceMeta: { stableId: tweet.id, authorId: tweet.author_id, conversationId: tweet.conversation_id,
          editHistoryIds: tweet.edit_history_tweet_ids, publicMetrics: tweet.public_metrics, sourceClass: sourceClassFor(username) }
      }];
    });
  }
}
