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
};

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

