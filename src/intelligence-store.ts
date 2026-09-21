import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { NewsArticle } from "./types.js";
import type { ChangeType, EventAssessment, StoryState } from "./event-intelligence.js";

export type DecisionStage = "SOURCE" | "NORMALIZE" | "DUPLICATE" | "DELTA" | "SCORE" | "AI" | "AI_CONTRACT_FAILURE" | "SHADOW" | "FORMAT" | "ROUTING" | "SENT";
export type ReviewRecord = {
  id: string; article: NewsArticle; event: EventAssessment; stage: DecisionStage;
  primaryDecision: "SEND" | "DROP" | "REVIEW"; reason: string;
  shadowDecision?: "SEND" | "DROP"; shadowScore?: number;
  renderedMessage?: string;
  sentAt?: string; telegramMessageIds?: Record<string, number>;
  adminDecision?: "FALSE_NEGATIVE" | "FALSE_POSITIVE"; adminReason?: string;
  audit?: { provider: string; normalizedEvent: string; prefilter: "REVIEW" | "REJECT"; storyMatch: string;
    aiCalled: boolean; schema: "VALID" | "INVALID" | "NOT_CALLED"; repairAttempted: boolean; fallbackAttempted: boolean;
    outcome: "INTELLIGENCE_NOT_MATERIAL" | "AI_CONTRACT_FAILURE" | "FORMATTER_FAILURE" | "TELEGRAM_FAILURE" | "SEND" | "PENDING" };
};
type Metrics = { ingested: number; uniqueEvents: number; alertsSent: number; duplicatesRemoved: number;
  lowValueRejected: number; unverifiedRejected: number; highRiskMisses: number;
  providerFailures: number; aiFailures: number; latencyTotalMs: number; latencyCount: number;
  providerLatencyMs: Record<string, { total: number; count: number }> };
export type ActorStance = { actor: string; storyKey: string; stance: string; changeType: ChangeType; updatedAt: string; sourceConfidence: number };
export type MacroRelease = { release: string; actual?: string; consensus?: string; previous?: string; revision?: string; surprise?: "UP" | "DOWN" | "NEUTRAL"; timestamp: string; eventKey: string };
export type MemoryEvent = { key: string; storyKey: string; fact: string; action: string; changeType: ChangeType; entities: string[]; sourceConfidence: number; eventTime: string; decision?: "SEND" | "DROP" | "REVIEW" };
export type AlertMemory = { eventKey: string; storyKey: string; delta: number; verification: string; sentAt: string; message?: string };
export type MarketMemoryPack = {
  currentEvent: { verifiedFacts: string; sourceConfidence: number; eventTime: string; changeType: ChangeType };
  previousStoryState: StoryState | null;
  actorStances: ActorStance[];
  macroContext: MacroRelease[];
  marketSnapshot: { text: string; capturedAt: string } | null;
  previousAlert: AlertMemory | null;
  informationDelta: { previousKnownState: string | null; newVerifiedInformation: string; delta: string };
  openUncertainties: string[];
};
const emptyMetrics = (): Metrics => ({ ingested: 0, uniqueEvents: 0, alertsSent: 0, duplicatesRemoved: 0,
  lowValueRejected: 0, unverifiedRejected: 0, highRiskMisses: 0, providerFailures: 0, aiFailures: 0,
  latencyTotalMs: 0, latencyCount: 0, providerLatencyMs: {} });
type Data = { records: Record<string, ReviewRecord>; stories: Record<string, StoryState>; metrics: Record<string, Metrics>;
  processedIdentities?: Record<string, string>; deliveredIdentities?: Record<string, string>;
  memoryEvents?: Record<string, MemoryEvent>; actorStances?: Record<string, ActorStance>; macroReleases?: Record<string, MacroRelease>;
  alerts?: Record<string, AlertMemory>; marketSnapshot?: { text: string; capturedAt: string };
  safeMode: boolean; lastReportDay?: string; updateOffset: number; regime: string };

function identityKeys(article: NewsArticle): string[] {
  const source = (article.sourceName || article.provider).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const author = (article.author || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const identity = article.postId || article.providerId || article.url;
  const content = `${article.title} ${article.summary}`.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  return [digest(`id|${source}|${author}|${identity}|${digest(content)}`), digest(`content|${source}|${author}|${content}`)];
}

export class IntelligenceStore {
  private data: Data;
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Data :
      { records: {}, stories: {}, metrics: {}, safeMode: false, updateOffset: 0, regime: "UNCLEAR" };
  }
  private save(): void { writeFileSync(this.path, JSON.stringify(this.data), "utf8"); }
  private day(): string { return new Date().toISOString().slice(0, 10); }
  private counters(): Metrics { return this.data.metrics[this.day()] ??= emptyMetrics(); }
  increment(name: keyof Pick<Metrics, "ingested" | "uniqueEvents" | "alertsSent" | "duplicatesRemoved" | "lowValueRejected" | "unverifiedRejected" | "highRiskMisses" | "providerFailures" | "aiFailures">): void {
    this.counters()[name]++; this.save();
  }
  providerLatency(provider: string, milliseconds: number): void {
    const item = this.counters().providerLatencyMs[provider] ??= { total: 0, count: 0 };
    item.total += milliseconds; item.count++; this.save();
  }
  deliveryLatency(milliseconds: number): void {
    const metrics = this.counters(); metrics.latencyTotalMs += milliseconds; metrics.latencyCount++; this.save();
  }
  getRecord(id: string): ReviewRecord | undefined { return this.data.records[id]; }
  hasProcessedIdentity(article: NewsArticle): boolean { return identityKeys(article).some((key) => Boolean(this.data.processedIdentities?.[key])); }
  markProcessedIdentity(article: NewsArticle, eventKey: string): void {
    this.data.processedIdentities ??= {}; for (const key of identityKeys(article)) this.data.processedIdentities[key] = eventKey; this.save();
  }
  hasDeliveredIdentity(article: NewsArticle, eventKey: string): boolean {
    return Boolean(this.data.deliveredIdentities?.[`event:${eventKey}`]) ||
      identityKeys(article).some((key) => Boolean(this.data.deliveredIdentities?.[key]));
  }
  markDeliveredIdentity(article: NewsArticle, eventKey: string): void {
    this.data.deliveredIdentities ??= {};
    this.data.deliveredIdentities[`event:${eventKey}`] = new Date().toISOString();
    for (const key of identityKeys(article)) this.data.deliveredIdentities[key] = new Date().toISOString();
    this.save();
  }
  records(): ReviewRecord[] { return Object.values(this.data.records); }
  record(item: ReviewRecord): void { this.data.records[item.id] = item; this.save(); }
  getStory(key: string): StoryState | undefined { return this.data.stories[key]; }
  /** Persist a compact, market-only observation before any expensive AI work. */
  observeMarketEvent(article: NewsArticle, event: EventAssessment): void {
    this.data.memoryEvents ??= {};
    this.data.memoryEvents[event.key] = { key: event.key, storyKey: event.storyKey, fact: event.fact, action: event.action,
      changeType: event.changeType, entities: event.entities, sourceConfidence: event.sourceConfidence, eventTime: event.eventTime };
    // Tier-3 noise never becomes canonical story/stance memory. It remains a rejected-candidate record only.
    if (event.sourceTier <= 2 && event.causalChannel) {
      this.data.stories[event.storyKey] = { key: event.storyKey, lastAction: event.action, lastFact: event.fact,
        lastChange: event.changeType, updatedAt: event.eventTime, sent: this.data.stories[event.storyKey]?.sent ?? false };
      this.rememberActorStances(article, event);
      this.rememberMacro(event);
    }
    this.save();
  }
  private rememberActorStances(article: NewsArticle, event: EventAssessment): void {
    const text = `${article.title} ${article.summary}`.toLowerCase();
    const actors = ["donald trump", "trump", "powell", "warsh", "goolsbee", "waller", "bessent", "fed", "fomc"]
      .filter((actor) => new RegExp(`\\b${actor.replace(" ", "\\s+")}\\b`, "i").test(text));
    if (!actors.length) return;
    this.data.actorStances ??= {};
    for (const actor of actors) this.data.actorStances[`${event.storyKey}|${actor}`] = {
      actor, storyKey: event.storyKey, stance: event.fact, changeType: event.changeType,
      updatedAt: event.eventTime, sourceConfidence: event.sourceConfidence
    };
  }
  private rememberMacro(event: EventAssessment): void {
    const release = event.storyKey.startsWith("us-macro-") ? event.storyKey.slice("us-macro-".length) : null;
    if (!release) return;
    const fact = event.fact;
    const numberAfter = (labels: string) => fact.match(new RegExp(`(?:${labels})\\s*(?:at|of|:|=)?\\s*([0-9]+(?:\\.[0-9]+)?%?)`, "i"))?.[1];
    const actual = numberAfter("actual|cpi|pce|nfp|payroll|unemployment|gdp|ism|retail sales");
    const consensus = numberAfter("consensus|forecast|expected|estimate");
    const previous = numberAfter("previous|prior");
    const revision = numberAfter("revised|revision");
    this.data.macroReleases ??= {};
    this.data.macroReleases[event.key] = { release, actual, consensus, previous, revision,
      surprise: /below consensus|lower than forecast/i.test(fact) ? "DOWN" : /above consensus|higher than forecast/i.test(fact) ? "UP" : "NEUTRAL",
      timestamp: event.eventTime, eventKey: event.key };
  }
  rememberSnapshot(text: string): void { if (text) { this.data.marketSnapshot = { text, capturedAt: new Date().toISOString() }; this.save(); } }
  marketContext(event: EventAssessment, article: NewsArticle, liveSnapshot?: string | null): MarketMemoryPack {
    if (liveSnapshot) this.rememberSnapshot(liveSnapshot);
    const prior = this.data.stories[event.storyKey];
    const actorStances = Object.values(this.data.actorStances ?? {}).filter((stance) => stance.storyKey === event.storyKey).slice(-4);
    const macroContext = Object.values(this.data.macroReleases ?? {}).filter((item) => item.release === event.storyKey.replace("us-macro-", "")).slice(-3);
    const previousAlert = Object.values(this.data.alerts ?? {}).filter((alert) => alert.storyKey === event.storyKey).sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0] ?? null;
    const snapshot = this.data.marketSnapshot && Date.now() - Date.parse(this.data.marketSnapshot.capturedAt) <= 120_000 ? this.data.marketSnapshot : null;
    const uncertainties: string[] = [];
    if (event.sourceTier === 3) uncertainties.push("single tier-three source; independent corroboration required");
    if (event.changeType === "RUMOR") uncertainties.push("report remains unconfirmed");
    if (!snapshot) uncertainties.push("fresh cross-market snapshot unavailable");
    return { currentEvent: { verifiedFacts: event.fact, sourceConfidence: event.sourceConfidence, eventTime: event.eventTime, changeType: event.changeType },
      previousStoryState: prior ?? null, actorStances, macroContext, marketSnapshot: snapshot,
      previousAlert,
      informationDelta: { previousKnownState: prior?.lastFact ?? null, newVerifiedInformation: event.fact,
        delta: event.informationDelta === 0 ? "no material delta" : event.changeType === "DENIAL" ? "reversal/denial of prior state" : "new fact or changed state" },
      openUncertainties: uncertainties };
  }
  rememberStory(event: EventAssessment, sent: boolean): void {
    this.data.stories[event.storyKey] = { key: event.storyKey, lastAction: event.action,
      lastFact: event.fact, lastChange: event.changeType as ChangeType, updatedAt: new Date().toISOString(), sent };
    this.data.alerts ??= {};
    if (sent) this.data.alerts[event.key] = { eventKey: event.key, storyKey: event.storyKey, delta: event.informationDelta,
      verification: event.sourceTier === 1 ? "OFFICIAL" : "TIER_2", sentAt: new Date().toISOString() };
    if (this.data.memoryEvents?.[event.key]) this.data.memoryEvents[event.key].decision = sent ? "SEND" : "REVIEW";
    this.save();
  }
  get safeMode(): boolean { return this.data.safeMode; }
  setSafeMode(value: boolean): void { this.data.safeMode = value; this.save(); }
  get updateOffset(): number { return this.data.updateOffset; }
  setUpdateOffset(value: number): void { this.data.updateOffset = value; this.save(); }
  get regime(): string { return this.data.regime; }
  setRegime(value: string): void { this.data.regime = value; this.save(); }
  markFeedback(id: string, decision: "FALSE_NEGATIVE" | "FALSE_POSITIVE", reason: string): boolean {
    const record = this.data.records[id]; if (!record) return false;
    record.adminDecision = decision; record.adminReason = reason; this.save(); return true;
  }
  addMissedHeadline(headline: string, source: string, reason: string): string {
    const id = `miss-${Date.now().toString(36)}`;
    const article: NewsArticle = { provider: "admin-feedback", providerId: id, title: headline, summary: "",
      url: "", publishedAt: new Date(), sourceName: source };
    const event = { key: id, storyKey: id, action: "unknown", fact: headline, entities: [],
      changeType: "NEW_INFORMATION", sourceTier: 3, sourceConfidence: 0, importance: 0, urgency: 0,
      novelty: 0, marketRelevance: 0, actorImportance: 0, marketMateriality: 0, magnitude: 0,
      transmissionConfidence: 0, causalChannel: null, informationDelta: 0, directionConfidence: 0,
      highPriority: false, unscheduled: true, transmissionChannels: [], publishedAt: article.publishedAt.toISOString(),
      eventTime: article.publishedAt.toISOString(), firstSeenAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(), reasons: ["not discovered by provider"] } satisfies EventAssessment;
    this.record({ id, article, event, stage: "SOURCE", primaryDecision: "DROP",
      reason: "Not discovered by providers", adminDecision: "FALSE_NEGATIVE", adminReason: reason });
    this.increment("highRiskMisses");
    return id;
  }
  report(day: string): string {
    const m = this.data.metrics[day] ?? emptyMetrics();
    const latency = m.latencyCount ? Math.round(m.latencyTotalMs / m.latencyCount) : 0;
    const providers = Object.entries(m.providerLatencyMs).map(([name, value]) =>
      `${name}: ${Math.round(value.total / value.count)} ms`).join(", ") || "tidak ada";
    return [`Laporan intelligence admin ${day}`, `Ingested: ${m.ingested}`,
      `Unique events: ${m.uniqueEvents}`, `Alerts sent: ${m.alertsSent}`,
      `Duplicates removed: ${m.duplicatesRemoved}`, `Low-value rejected: ${m.lowValueRejected}`,
      `Unverified rejected: ${m.unverifiedRejected}`, `High-risk misses: ${m.highRiskMisses}`,
      `Provider failures: ${m.providerFailures}`, `AI failures: ${m.aiFailures}`,
      `Detection-to-Telegram average: ${latency} ms`, `Provider latency: ${providers}`,
      `Safe mode: ${this.safeMode ? "ON" : "OFF"}`, `Market regime: ${this.regime}`].join("\n");
  }
  lastReportDay(): string | undefined { return this.data.lastReportDay; }
  setLastReportDay(day: string): void { this.data.lastReportDay = day; this.save(); }
}
