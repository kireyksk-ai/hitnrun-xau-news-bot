import type { NewsArticle, NewsProvider } from "../types.js";

// "Wire" layer -- the fastest public source for off-script Fed/Treasury
// commentary. official-macro-rss.ts and treasury-press.ts only fire once a
// press release, speech transcript, or statement page is PUBLISHED; neither
// sees live remarks during a press conference, TV interview, or Q&A. Those
// break on X within 1-3 seconds via a small set of high-signal "wire"
// accounts that live-transcribe headlines -- this provider watches exactly
// those accounts.
//
// COST MODEL: the old flat "$200/mo Basic tier" X API plan was retired
// (June 2026). New developers are pay-per-use by default: roughly $0.005
// per third-party post read, no base fee, capped at 3M post reads/month
// before an Enterprise contract is required. Cost scales with how noisy
// WIRE_ACCOUNTS/the keyword filter are, not a flat bill -- verify current
// pricing at https://developer.x.com/en/products/x-api before enabling,
// and watch the usage dashboard for the first few days.
//
// SPENDING GUARD: this provider estimates its own monthly spend (reads *
// COST_PER_READ_USD) and stops making requests once it crosses
// maxMonthlyUsd (env: TWITTER_WIRE_MAX_MONTHLY_USD, default $30). This is a
// SOFT, secondary guard only -- the estimate resets to 0 on every process
// restart (a Render redeploy/restart counts), so it can undercount in a
// crash-loop. The real, reliable cap is X's own "Spending limit" setting
// in the Developer Console (console.x.com -> your Project -> Usage and
// billing / Settings -> Spending limit): set a hard dollar cap there and X
// blocks the API itself once it is hit, no matter what this file does.
// Set both. Requires X_API_BEARER_TOKEN. Disabled (skipped, not thrown)
// when absent, so this optional paid layer never takes down the pipeline.
const WIRE_ACCOUNTS = ["DeItaone", "FirstSquawk", "LiveSquawk", "zerohedge", "unusual_whales"];

const QUERY = [
      `(${WIRE_ACCOUNTS.map((h) => `from:${h}`).join(" OR ")})`,
      `(Fed OR Powell OR Waller OR Bowman OR Barr OR Cook OR Jefferson OR "rate cut" OR "rate hike"`,
      `OR CPI OR NFP OR PCE OR PPI OR FOMC OR Treasury OR Bessent OR tariff OR gold OR XAU OR "Fed officials")`
    ].join(" ");

type XApiTweet = { id: string; text: string; created_at: string; author_id: string };
type XApiUser = { id: string; username: string };
type XApiSearchResponse = {
      data?: XApiTweet[];
      includes?: { users?: XApiUser[] };
      meta?: { newest_id?: string };
};

// In-memory cursor so we never re-read (and re-bill for) the same tweet.
// If the process restarts often, persist this instead of keeping it in memory.
let sinceId: string | undefined;

// Estimated-spend tracking for the soft budget guard described above.
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
      constructor(readonly pollIntervalSeconds = 30, readonly maxMonthlyUsd = 30) {}

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
          const token = process.env.X_API_BEARER_TOKEN;
          if (!token) return [];

        const monthKey = currentMonthKey();
          if (monthKey !== billedMonthKey) {
                    billedMonthKey = monthKey;
                    monthlyReadsBilled = 0;
                    budgetWarningLogged = false;
          }
          const estimatedSpendUsd = monthlyReadsBilled * COST_PER_READ_USD;
          if (estimatedSpendUsd >= this.maxMonthlyUsd) {
                    if (!budgetWarningLogged) {
                                console.warn(`[twitter-wire] Estimated spend ~$${estimatedSpendUsd.toFixed(2)} reached the $${this.maxMonthlyUsd} monthly guard -- pausing X reads until next month. Set X's own "Spending limit" in the Developer Console for the real hard cap.`);
                                budgetWarningLogged = true;
                    }
                    return [];
          }

        const url = new URL("https://api.x.com/2/tweets/search/recent");
          url.searchParams.set("query", QUERY);
          url.searchParams.set("max_results", "50");
          url.searchParams.set("tweet.fields", "created_at,author_id");
          url.searchParams.set("expansions", "author_id");
          url.searchParams.set("user.fields", "username");
          if (sinceId) url.searchParams.set("since_id", sinceId);

        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          if (!response.ok) throw new Error(`X API search failed: ${response.status} ${await response.text()}`);

        const payload = (await response.json()) as XApiSearchResponse;
          if (payload.meta?.newest_id) sinceId = payload.meta.newest_id;
          if (payload.data?.length) monthlyReadsBilled += payload.data.length;
          if (!payload.data?.length) return [];

        const usersById = new Map((payload.includes?.users ?? []).map((u) => [u.id, u.username]));

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
                  }];
        });
  }
}
