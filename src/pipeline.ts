import type { NewsArticle, EditorialDecision } from "./types.js";
import { assessEvent, shouldReview } from "./event-intelligence.js";
import type { EventAssessment } from "./event-intelligence.js";
import { validateNewsOutput } from "./news-output.js";
import { IntelligenceStore } from "./intelligence-store.js";
import type { ReviewRecord } from "./intelligence-store.js";
import { AIContractFailure } from "./editor.js";
import { channel, synthesize } from "./causal-intelligence.js";
import { policy, schedule } from "./delayed-outcomes.js";

export type PipelineDeps = {
  store: IntelligenceStore;
  analyze: (article: NewsArticle, event: EventAssessment) => Promise<EditorialDecision>;
  shadow: (article: NewsArticle, event: EventAssessment) => Promise<{ material: boolean; score: number; reason: string }>;
  deliver: (message: string, id: string, article: NewsArticle) => Promise<Record<string, number>>;
  /** Optional: writes prose for an already-approved event that has none. */
  compose?: (article: NewsArticle, reason: string) => Promise<{ message: string; call?: import("./editor.js").GoldCall } | null>;
  /** Optional: called once after a NEWS alert is accepted by Telegram (prediction ledger). */
  onSent?: (record: ReviewRecord, call: import("./editor.js").GoldCall | undefined) => void | Promise<void>;
  snapshot?: () => Promise<string | null>;
  now?: () => Date;
};

const echoStop = new Set(["the","a","an","of","to","in","on","and","for","is","are","be","will","with","at","by","from","that","this","it","as","us","u","s","says","said","say"]);
function echoTokens(fact: string): Set<string> {
  return new Set(fact.split(" ").filter((word) => word.length > 1 && !echoStop.has(word) && !/^(firstsquawk|deitaone|financialjuice|livesquawk|zerohedge)$/.test(word)));
}
/** Same storyline, near-identical wording, AI already consulted within 20 minutes. */
export function crossWireEcho(event: EventAssessment, records: ReviewRecord[], now: Date): ReviewRecord | undefined {
  const mine = echoTokens(event.fact);
  if (mine.size < 3) return undefined;
  return records.find((other) => {
    if (other.id === event.key || other.event.storyKey !== event.storyKey || !other.audit?.aiCalled) return false;
    const age = now.getTime() - Date.parse(other.event.firstSeenAt);
    if (!(age >= 0 && age <= 20 * 60000)) return false;
    // A held/failed judgment must not suppress a better-sourced copy.
    if (other.event.sourceTier > event.sourceTier) return false;
    if (/Primary AI unavailable|AI_CONTRACT_FAILURE/.test(other.reason)) return false;
    const theirs = echoTokens(other.event.fact);
    let shared = 0; for (const word of mine) if (theirs.has(word)) shared++;
    return shared / Math.min(mine.size, theirs.size) >= 0.7;
  });
}

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
    const reason = event.candidateRoute === "OBVIOUS_NOISE" ? "OBVIOUS_NOISE_DROP: No plausible macro/XAU transmission" : "HARD_FILTER_REJECT: Importance/delta below threshold";
    record = { ...record, stage: "SCORE", primaryDecision: "DROP", reason, audit: { ...auditBase, prefilter: "REJECT", outcome: "INTELLIGENCE_NOT_MATERIAL" } };
    deps.store.observeMarketEvent(article, event);
    deps.store.rememberEvidence(article, event, false);
    deps.store.record(record); deps.store.markProcessedIdentity(article, event.key); deps.store.increment("lowValueRejected");
    if (event.candidateRoute === "OBVIOUS_NOISE") deps.store.increment("obviousNoiseDrop");
    return record;
  }
  // Fast wires (FirstSquawk, DeItaone, financialjuice, LiveSquawk, Benzinga) often
  // post the same headline within minutes. Judge it once; repeats would only burn
  // the daily AI budget that later, genuinely new events need.
  const echo = crossWireEcho(event, deps.store.records(), now);
  if (echo) {
    deps.store.increment("duplicatesRemoved");
    deps.store.markProcessedIdentity(article, event.key);
    record = { ...record, stage: "DUPLICATE", primaryDecision: "DROP", reason: `CROSS_WIRE_ECHO of ${echo.id.slice(0, 10)}` };
    deps.store.record(record);
    return record;
  }
  if (event.candidateRoute === "PLAUSIBLE_MACRO") deps.store.increment("plausibleMacroToSol");
  else deps.store.increment("deterministicMaterialToSol");
  let enriched = article;
  try {
    const market = await deps.snapshot?.();
    const context = deps.store.marketContext(event, article, market);
    enriched = { ...article, summary: `${article.summary}\n\nMARKET_CONTEXT_PACK: ${JSON.stringify(context)}` };
  } catch { /* Snapshot is context only and never blocks an event. */ }
  // Persist after building the context pack: the model sees the state that
  // existed immediately before this candidate, not a state overwritten by it.
  deps.store.observeMarketEvent(article, event);
  // Persist a compact candidate graph before AI synthesis. It records uncertainty
  // and competing channels only; it cannot alter the existing NEWS decision.
  if (event.causalChannel) {
    const nowIso = now.toISOString();
    const previousGraph = deps.store.causalGraphs()[event.storyKey];
    const channels = (event.transmissionChannels.length ? event.transmissionChannels : [event.causalChannel]).map((name, index) =>
      channel(`${event.key}:${index}`, name, "XAU", index ? "SECOND_ORDER_EFFECT" : "FIRST_ORDER_EFFECT", "INTRADAY", nowIso,
        event.sourceTier <= 2 ? [event.fact] : [], event.sourceTier > 2 ? ["Independent corroboration required"] : []));
    const synthesis = synthesize(channels);
    deps.store.recordCausalGraph({ storyId:event.storyKey, createdAt:nowIso, updatedAt:nowIso, attribution:synthesis.attribution, channels,
      corrections:[], conflicts:event.sourceTier > 2 ? ["Single tier-three source"] : [], narrative:{known:[event.fact], changed:event.changeType,
      uncertain:event.sourceTier > 2 ? ["Independent corroboration required"] : [], active:channels.map(item=>item.id), contradicted:[], horizons:["INTRADAY"], latest:event.fact, limitations:[]} });
    if (/CORRECTION|DENIAL|REVERSAL/.test(String(event.changeType))) deps.store.recordCausalCorrection(event.storyKey,previousGraph?.attribution ?? "prior attribution",event.fact,"DRIVER_UNKNOWN",nowIso);
    const factualState = /CORRECTION|DENIAL|REVERSAL/.test(String(event.changeType)) ? "CORRECTED" : event.sourceTier <= 2 ? "CONFIRMED" : "UNRESOLVED";
    const actor = article.author ?? article.sourceMeta?.authorId;
    for (const horizon of policy(event.storyKey,event.marketMateriality)) for (const checkpoint of schedule(event.key,event.storyKey,nowIso,event.marketMateriality,horizon,event.storyKey,{source:article.sourceName ?? article.provider,actor,factualState,causalReference:event.storyKey,causalGraphVersion:nowIso})) deps.store.scheduleCheckpoint(checkpoint);
  }

  let primary: EditorialDecision | undefined;
  let shadow: { material: boolean; score: number; reason: string } | undefined;
  let contractFailure = false;
  try { primary = await deps.analyze(enriched, event); }
  catch (error) { deps.store.increment("aiFailures"); contractFailure = error instanceof AIContractFailure; }
  // The shadow review exists to catch primary misses. When the primary already
  // approved the event, a second call adds no protection and only burns budget.
  if (!primary?.material) try { shadow = await deps.shadow(enriched, event); }
  catch { deps.store.increment("aiFailures"); }
  if (contractFailure) {
    const reason = shadow?.material && shadow.score >= 80 ? "AI_CONTRACT_FAILURE: primary and repair invalid; fallback evaluated material candidate" : "AI_CONTRACT_FAILURE: primary and repair invalid";
    record = { ...record, stage: "AI_CONTRACT_FAILURE", primaryDecision: "REVIEW", reason,
      shadowDecision: shadow?.material ? "SEND" : "DROP", shadowScore: shadow?.score,
      audit: { ...auditBase, aiCalled: true, schema: "INVALID", repairAttempted: true, fallbackAttempted: true, outcome: "AI_CONTRACT_FAILURE" } };
    deps.store.record(record);
    deps.store.rememberEvidence(article, event, false);
    // Do not mark processed: a later independent provider can re-evaluate it.
    return record;
  }
  const highRiskMiss = !primary?.material && (event.highPriority || (shadow?.material && shadow.score >= 80));
  if (highRiskMiss) deps.store.increment("highRiskMisses");
  const shadowSupports = Boolean(shadow?.material && shadow.score >= 80);
  const corroborated = event.sourceTier <= 2;
  const aiSupports = Boolean(primary?.material || shadowSupports);
  const aiUnavailable = !primary && !shadow;
  const deterministicPublish = corroborated && Boolean(event.causalChannel) && event.marketMateriality >= 65 &&
    event.transmissionConfidence >= 65 && (aiSupports || (event.highPriority && aiUnavailable));
  // A plausible macro candidate reaches Sol without a keyword-built channel.
  // It may publish only when trusted-source Sol evidence supports it.
  const plausiblePublish = corroborated && event.candidateRoute === "PLAUSIBLE_MACRO" && aiSupports;
  const publish = deterministicPublish || plausiblePublish;
  record = { ...record, stage: highRiskMiss ? "SHADOW" : "AI", primaryDecision: publish ? "SEND" : "DROP",
    reason: primary?.reason ?? "Primary AI unavailable", shadowDecision: shadow?.material ? "SEND" : "DROP", shadowScore: shadow?.score,
    audit: { ...auditBase, aiCalled: true, schema: "VALID", fallbackAttempted: true, outcome: publish ? "PENDING" : "INTELLIGENCE_NOT_MATERIAL" } };
  if (!corroborated) {
    record = { ...record, stage: "SOURCE", primaryDecision: "REVIEW", reason: "Tier-3 source needs independent corroboration" };
    deps.store.record(record); deps.store.markProcessedIdentity(article, event.key); deps.store.increment("unverifiedRejected"); return record;
  }
  if (!publish) {
    deps.store.record(record); deps.store.markProcessedIdentity(article, event.key);
    deps.store.rememberEvidence(article, event, false);
    deps.store.increment("lowValueRejected"); if (!aiUnavailable && !aiSupports) deps.store.increment("solReject");
    return record;
  }
  deps.store.increment("solSend");
  let message = primary?.material ? primary.telegramMessage : null;
  let call = primary?.material ? primary.call : undefined;
  if (message === null && deps.compose) {
    // Publishing was approved (primary and/or shadow), but no narrative exists.
    // Write it now instead of silently holding a material event forever.
    try { const composed = await deps.compose(article, primary?.material ? primary.reason : shadow?.reason ?? record.reason); message = composed?.message ?? null; call = composed?.call ?? call; }
    catch { message = null; }
  }
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
      deps.store.rememberEvidence(article, event, true);
      deps.store.increment("alertsSent");
      deps.store.deliveryLatency(Math.max(0, (deps.now?.() ?? new Date()).getTime() - now.getTime()));
      try { await deps.onSent?.(record, call); } catch { /* The ledger is measurement only; it never blocks delivery. */ }
    }
    return record;
  } catch {
    record = { ...record, stage: "ROUTING", primaryDecision: "REVIEW", reason: "TELEGRAM_FAILURE: Telegram delivery failed; queued for replay", renderedMessage: newsMessage, audit: { ...record.audit!, outcome: "TELEGRAM_FAILURE" } };
    deps.store.record(record); return record;
  }
}
