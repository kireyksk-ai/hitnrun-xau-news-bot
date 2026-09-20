import type { NewsArticle, NewsProvider } from "../types.js";

type TruthStatus = { id?: string; content?: string; url?: string; created_at?: string; reblog?: unknown };
const accountId = "107780257626128497";

function toText(html: string): string {
  return html.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

/** Public Mastodon-compatible timeline for @realDonaldTrump; no credential is stored. */
export class TruthSocialTrumpProvider implements NewsProvider {
  readonly name = "truth-social-trump";
  constructor(readonly pollIntervalSeconds: number) {}

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
    const endpoint = new URL(`https://truthsocial.com/api/v1/accounts/${accountId}/statuses`);
    endpoint.searchParams.set("limit", "40");
    endpoint.searchParams.set("exclude_replies", "true");
    const response = await fetch(endpoint, { headers: { Accept: "application/json", "User-Agent": "HitnRun-XAU-News/1.0" } });
    if (!response.ok) throw new Error(`Truth Social feed failed: ${response.status}`);
    const statuses = await response.json() as TruthStatus[];
    return statuses.flatMap((status) => {
      if (!status.id || !status.content || !status.created_at || status.reblog) return [];
      const publishedAt = new Date(status.created_at);
      if (publishedAt < since) return [];
      const text = toText(status.content);
      if (!text) return [];
      return [{ provider: this.name, providerId: status.id, title: "Donald Trump — Truth Social", summary: text,
        url: status.url ?? `https://truthsocial.com/@realDonaldTrump/${status.id}`, publishedAt, sourceName: "Truth Social @realDonaldTrump" }];
    });
  }
}
