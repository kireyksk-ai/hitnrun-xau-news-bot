import type { NewsArticle, EditorialDecision } from "./types.js";
import { assessEvent, shouldReview } from "./event-intelligence.js";
import type { EventAssessment } from "./event-intelligence.js";
import { validateNewsOutput } from "./news-output.js";
import { IntelligenceStore } from "./intelligence-store.js";
import type { ReviewRecord } from "./intelligence-store.js";
import { AIContractFailure } from "./editor.js";

export type PipelineDeps = {
  store: IntelligenceStore;
  analyze: (article: NewsArticle, event: EventAssessment) => Promise<EditorialDecision>;
  shadow: (article: NewsArticle, event: EventAssessment) => Promise<{ material: boolean; score: number; reason: string }>;
  deliver: (message: string, id: string, article: NewsArticle) => Promise<Record<string, number>>;
  snapshot?: () => Promise<string | null>;
  now?: () => Date;
};

export async function processArticle(article: NewsArticle, deps: PipelineDeps): Promise<ReviewRecord> {
  const now = deps.now?.() ?? new Date();
  deps.store.increment("ingested");
  const prior = deps.store.getStory(assessEvent(article).storyKey);
  const event = assessEvent(article, prior, now);
  const previous = deps.store.getRecord(event.key);
  if (deps.store.hasProcessedIdentity(article) || deps.store.hasDeliveredIdentity(article, event.key)) {
    deps.store.increment("duplicatesRemoved");
    return { id: event.key, article, event, stage: "DUPLICATE", primaryDecision: "DROP", reason: "Source/author/post/content identity already processed" };
  }
  if ((previous && !(previous.stage === "SOURCE" && event.sourceTier <= 2)) || event.informationDelta === 0) {
    deps.store.increment("duplicatesRemoved");
    return { id: event.key, article, event, stage: "DUPLICATE", primaryDecision: "DROP", reason: "No information delta or event already processed" };
  }
  deps.store.increment("uniqueEvents");
  const auditBase = { provider: article.provider, normalizedEvent: event.key, prefilter: "REVIEW" as const, storyMatch: prior ? prior.key : "NONE",
    aiCalled: false, schema: "NOT_CALLED" as const, repairAttempted: false, fallbackAttempted: false, outcome: "PENDING" as const };
  let record: ReviewRecord = { id: event.key, article, event, stage: "SCORE", primaryDecision: "REVIEW",
    reason: event.reasons.join("; "), audit: auditBase };
  deps.store.record(record);
  if (!shouldReview(event, prior)) {
    record = { ...record, stage: "SCORE", primaryDecision: "DROP", reason: "HARD_FILTER_REJECT: Importance/delta below threshold", audit: { ...auditBase, prefilter: "REJECT", outcome: "INTELLIGENCE_NOT_MATERIAL" } };
    deps.store.observeMarketEvent(article, event);
    deps.store.record(record); deps.store.markProcessedIdentity(article, event.key); deps.store.increment("lowValueRejected"); return record;
  }
  let enriched = article;
  try {
    const market = await deps.snapshot?.();
    const context = deps.store.marketContext(event, article, market);
    enriched = { ...article, summary: `${article.summary}\n\nMARKET_CONTEXT_PACK: ${JSON.stringify(context)}` };
  } catch { /* Snapshot is context only and never blocks an event. */ }
  // Persist after building the context pack: the model sees the state that
  // existed immediately before this candidate, not a state overwritten by it.
  deps.store.observeMarketEvent(article, event);

  let primary: EditorialDecision | undefined;
  let shadow: { material: boolean; score: number; reason: string } | undefined;
  let contractFailure = false;
  try { primary = await deps.analyze(enriched, event); }
  catch (error) { deps.store.increment("aiFailures"); contractFailure = error instanceof AIContractFailure; }
  try { shadow = await deps.shadow(enriched, event); }
  catch { deps.store.increment("aiFailures"); }
  if (contractFailure) {
    const reason = shadow?.material && shadow.score >= 80 ? "AI_CONTRACT_FAILURE: primary and repair invalid; fallback evaluated material candidate" : "AI_CONTRACT_FAILURE: primary and repair invalid";
    record = { ...record, stage: "AI_CONTRACT_FAILURE", primaryDecision: "REVIEW", reason,
      shadowDecision: shadow?.material ? "SEND" : "DROP", shadowScore: shadow?.score,
      audit: { ...auditBase, aiCalled: true, schema: "INVALID", repairAttempted: true, fallbackAttempted: true, outcome: "AI_CONTRACT_FAILURE" } };
    deps.store.record(record);
    // Do not mark processed: a later independent provider can re-evaluate it.
    return record;
  }
  const highRiskMiss = !primary?.material && (event.highPriority || (shadow?.material && shadow.score >= 80));
  if (highRiskMiss) deps.store.increment("highRiskMisses");
  const shadowSupports = Boolean(shadow?.material && shadow.score >= 80);
  const corroborated = event.sourceTier <= 2;
  const aiSupports = Boolean(primary?.material || shadowSupports);
  const aiUnavailable = !primary && !shadow;
  const publish = corroborated && Boolean(event.causalChannel) && event.marketMateriality >= 65 &&
    event.transmissionConfidence >= 65 && (aiSupports || (event.highPriority && aiUnavailable));
  record = { ...record, stage: highRiskMiss ? "SHADOW" : "AI", primaryDecision: publish ? "SEND" : "DROP",
    reason: primary?.reason ?? "Primary AI unavailable", shadowDecision: shadow?.material ? "SEND" : "DROP", shadowScore: shadow?.score,
    audit: { ...auditBase, aiCalled: true, schema: "VALID", fallbackAttempted: true, outcome: publish ? "PENDING" : "INTELLIGENCE_NOT_MATERIAL" } };
  if (!corroborated) {
    record = { ...record, stage: "SOURCE", primaryDecision: "REVIEW", reason: "Tier-3 source needs independent corroboration" };
    deps.store.record(record); deps.store.markProcessedIdentity(article, event.key); deps.store.increment("unverifiedRejected"); return record;
  }
  if (!publish) {
    deps.store.record(record); deps.store.markProcessedIdentity(article, event.key);
    deps.store.increment("lowValueRejected");
    return record;
  }
  const message = primary?.material ? primary.telegramMessage : null;
  if (message === null) {
    record = { ...record, stage: "FORMAT", primaryDecision: "REVIEW", reason: "FORMATTER_FAILURE: AI produced no Indonesian NEWS narrative", audit: { ...record.audit!, outcome: "FORMATTER_FAILURE" } };
    deps.store.record(record);
    return record;
  }
  const outputCheck = validateNewsOutput(message, article);
  if (!outputCheck.ok) {
    record = { ...record, stage: "FORMAT", primaryDecision: "REVIEW", reason: `FORMATTER_FAILURE: ${outputCheck.reason}`, audit: { ...record.audit!, outcome: "FORMATTER_FAILURE" } };
    deps.store.record(record);
    return record;
  }
  const newsMessage = message;
  // A second hard guard immediately before Telegram routing, independent of AI.
  if (deps.store.hasDeliveredIdentity(article, event.key)) {
    deps.store.increment("duplicatesRemoved");
    return { ...record, stage: "DUPLICATE", primaryDecision: "DROP", reason: "Already delivered" };
  }
  if (deps.store.safeMode) {
    record = { ...record, stage: "ROUTING", primaryDecision: "REVIEW", reason: "Safe mode: queued for replay", renderedMessage: newsMessage };
    deps.store.record(record); return record;
  }
  try {
    const ids = await deps.deliver(newsMessage, event.key, article);
    const delivered = Object.keys(ids).length > 0;
    record = { ...record, stage: delivered ? "SENT" : "ROUTING", primaryDecision: delivered ? "SEND" : "REVIEW",
      reason: delivered ? record.reason : "TELEGRAM_FAILURE: No Telegram destination accepted message",
      sentAt: delivered ? (deps.now?.() ?? new Date()).toISOString() : undefined, telegramMessageIds: ids, renderedMessage: newsMessage };
    record.audit = { ...record.audit!, outcome: delivered ? "SEND" : "TELEGRAM_FAILURE" };
    deps.store.record(record);
    if (delivered) {
      deps.store.markProcessedIdentity(article, event.key);
      deps.store.markDeliveredIdentity(article, event.key);
      deps.store.rememberStory(event, true);
      deps.store.increment("alertsSent");
      deps.store.deliveryLatency(Math.max(0, (deps.now?.() ?? new Date()).getTime() - now.getTime()));
    }
    return record;
  } catch {
    record = { ...record, stage: "ROUTING", primaryDecision: "REVIEW", reason: "TELEGRAM_FAILURE: Telegram delivery failed; queued for replay", renderedMessage: newsMessage, audit: { ...record.audit!, outcome: "TELEGRAM_FAILURE" } };
    deps.store.record(record); return record;
  }
}
