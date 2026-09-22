export type NewsArticle = {
  provider: string;
  providerId: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: Date;
  sourceName?: string;
  author?: string;
  postId?: string;
  /** Compact source metadata for audit/story fusion; never rendered to NEWS. */
  sourceMeta?: { stableId?: string; updatedAt?: string; authorId?: string; channels?: string[]; tags?: string[]; tickers?: string[];
    conversationId?: string; editHistoryIds?: string[]; publicMetrics?: Record<string, number>; sourceClass?: SourceClass };
};

export type SourceClass = "OFFICIAL_DIRECT_STATEMENT" | "CREDIBLE_REPORTER" | "FAST_WIRE" | "SECONDARY_REPORT" | "UNVERIFIED_CLAIM" | "OPINION" | "NOISE";

export interface NewsProvider {
  readonly name: string;
  readonly pollIntervalSeconds?: number;
  fetchLatest(since: Date): Promise<NewsArticle[]>;
}

export type EditorialDecision = {
  material: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
  telegramMessage: string | null;
};

