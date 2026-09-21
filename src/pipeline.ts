import type { NewsArticle, EditorialDecision } from "./types.js";
import { assessEvent, highPriorityFallback, shouldReview } from "./event-intelligence.js";
import type { EventAssessment } from "./event-intelligence.js";
import { IntelligenceStore } from "./intelligence-store.js";
import type { ReviewRecord } from "./intelligence-store.js";

export type PipelineDeps = {
  store: IntelligenceStore;
  analyze: (article: NewsArticle, event: EventAssessment) => Promise<EditorialDecision>;
  shadow: (article: NewsArticle, event: EventAssessment) => Promise<{ material: boolean; score: number; reason: string }>;
  deliver: (message: string, id: string) => Promise<Record<string, number>>;
  snapshot?: () => Promise<string | null>;
  now?: () => Date;
};

export async function processArticle(article: NewsArticle, deps: PipelineDeps): Promise<ReviewRecord> {
  const now = deps.now?.() ?? new Date();
  deps.store.increment("ingested");
  const prior = deps.store.getStory(assessEvent(article).storyKey);
  const event = assessEvent(article, prior, now);
  const previous = deps.store.getRecord(event.key);
  if ((previous && !(previous.stage === "SOURCE" && event.sourceTier <= 2)) || event.informationDelta === 0) {
    deps.store.increment("duplicatesRemoved");
    return previous ?? { id: event.key, article, event, stage: "DUPLICATE", primaryDecision: "DROP", reason: "No information delta" };
  }
  deps.store.increment("uniqueEvents");
  let record: ReviewRecord = { id: event.key, article, event, stage: "SCORE", primaryDecision: "REVIEW",
    reason: event.reasons.join("; ") };
  deps.store.record(record);
  if (!shouldReview(event, prior)) {
    record = { ...record, stage: "SCORE", primaryDecision: "DROP", reason: "Importance/delta below threshold" };
    deps.store.record(record); deps.store.increment("lowValueRejected"); return record;
  }
  let enriched = article;
  try {
    const market = await deps.snapshot?.();
    const context = { event, prior, market: market ?? "unavailable",
      instruction: "State what changed, first-order and second-order effects, counterfactual novelty, source uncertainty and whether the market confirms or resists the event. Do not infer direction from the candle alone." };
    enriched = { ...article, summary: `${article.summary}\n\nMARKET_INTELLIGENCE_CONTEXT: ${JSON.stringify(context)}` };
  } catch { /* Snapshot is context only and never blocks an event. */ }

  let primary: EditorialDecision | undefined;
  let shadow: { material: boolean; score: number; reason: string } | undefined;
  try { primary = await deps.analyze(enriched, event); }
  catch { deps.store.increment("aiFailures"); }
  try { shadow = await deps.shadow(enriched, event); }
  catch { deps.store.increment("aiFailures"); }
  const highRiskMiss = !primary?.material && (event.highPriority || (shadow?.material && shadow.score >= 80));
  if (highRiskMiss) deps.store.increment("highRiskMisses");
  const shadowSupports = Boolean(shadow?.material && shadow.score >= 80);
  const corroborated = event.sourceTier <= 2;
  const aiSupports = Boolean(primary?.material || shadowSupports);
  const aiUnavailable = !primary && !shadow;
  const publish = corroborated && (aiSupports || (event.highPriority && aiUnavailable));
  record = { ...record, stage: highRiskMiss ? "SHADOW" : "AI", primaryDecision: publish ? "SEND" : "DROP",
    reason: primary?.reason ?? "Primary AI unavailable", shadowDecision: shadow?.material ? "SEND" : "DROP", shadowScore: shadow?.score };
  if (!corroborated) {
    record = { ...record, stage: "SOURCE", primaryDecision: "REVIEW", reason: "Tier-3 source needs independent corroboration" };
    deps.store.record(record); deps.store.increment("unverifiedRejected"); return record;
  }
  if (!publish) {
    deps.store.record(record);
    deps.store.increment("lowValueRejected");
    return record;
  }
  const message = primary?.material && primary.telegramMessage ? primary.telegramMessage : highPriorityFallback(article, event);
  if (deps.store.safeMode) {
    record = { ...record, stage: "ROUTING", primaryDecision: "REVIEW", reason: "Safe mode: queued for replay", renderedMessage: message };
    deps.store.record(record); return record;
  }
  try {
    const ids = await deps.deliver(message, event.key);
    const delivered = Object.keys(ids).length > 0;
    record = { ...record, stage: delivered ? "SENT" : "ROUTING", primaryDecision: delivered ? "SEND" : "REVIEW",
      reason: delivered ? record.reason : "No Telegram destination accepted message",
      sentAt: delivered ? (deps.now?.() ?? new Date()).toISOString() : undefined, telegramMessageIds: ids, renderedMessage: message };
    deps.store.record(record);
    if (delivered) {
      deps.store.rememberStory(event, true);
      deps.store.increment("alertsSent");
      deps.store.deliveryLatency(Math.max(0, (deps.now?.() ?? new Date()).getTime() - now.getTime()));
    }
    return record;
  } catch {
    record = { ...record, stage: "ROUTING", primaryDecision: "REVIEW", reason: "Telegram delivery failed; queued for replay", renderedMessage: message };
    deps.store.record(record); return record;
  }
}

