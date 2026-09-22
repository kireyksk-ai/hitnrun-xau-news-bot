import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { NewsArticle } from "./types.js";
import type { ChangeType, EventAssessment, StoryState } from "./event-intelligence.js";
import { MARKET_BRAIN_SCHEMA_VERSION, classifyEvidence, emptyBrain, type MarketExperience, type MarketPoint, type PersistentMarketBrain, type ShadowDecision } from "./persistent-market-brain.js";
import type { DriftRecord, PositioningState, QuantModel, QuantObservation, QuantitativeState, Relationship, Scorecard, SourceEvidence } from "./quantitative.js";
import type { AbnormalInvestigation, CausalGraph } from "./causal-intelligence.js";
import type { Checkpoint } from "./delayed-outcomes.js";

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
export type MemoryEvent = { key: string; storyKey: string; fact: string; action: string; changeType: ChangeType; entities: string[]; sourceConfidence: number; eventTime: string; decision?: "SEND" | "DROP" | "REVIEW"; provenance?: NewsArticle["sourceMeta"] };
export type CandidateMemoryQuarantine = { quarantinedAt: string; reason: "NO_PLAUSIBLE_MARKET_TRANSMISSION"; original: MemoryEvent };
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
  memoryEvents?: Record<string, MemoryEvent>; candidateMemoryQuarantine?: Record<string, CandidateMemoryQuarantine>; actorStances?: Record<string, ActorStance>; macroReleases?: Record<string, MacroRelease>;
  alerts?: Record<string, AlertMemory>; marketSnapshot?: { text: string; capturedAt: string };
  safeMode: boolean; lastReportDay?: string; updateOffset: number; regime: string; schemaVersion?: number; brain?: PersistentMarketBrain };

function identityKeys(article: NewsArticle): string[] {
  const source = (article.sourceName || article.provider).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const author = (article.author || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const identity = article.postId || article.providerId || article.url;
  const content = `${article.title} ${article.summary}`.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const version = article.sourceMeta?.updatedAt ?? "";
  return [digest(`id|${source}|${author}|${identity}|${version}|${digest(content)}`), digest(`content|${source}|${author}|${content}`)];
}

export class IntelligenceStore {
  private data: Data;
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    const exists = existsSync(path);
    this.data = exists ? JSON.parse(readFileSync(path, "utf8")) as Data :
      { records: {}, stories: {}, metrics: {}, safeMode: false, updateOffset: 0, regime: "UNCLEAR" };
    // Versioned, non-destructive migration: retain the complete old JSON beside state.
    if ((this.data.schemaVersion ?? 1) < MARKET_BRAIN_SCHEMA_VERSION) {
      if (exists) copyFileSync(path, `${path}.backup-v${this.data.schemaVersion ?? 1}`);
      this.data.schemaVersion = MARKET_BRAIN_SCHEMA_VERSION;
      this.data.brain = this.data.brain ?? emptyBrain();
      this.save();
    } else this.data.brain ??= emptyBrain();
    this.data.brain.quantitative ??= { observations:{}, models:[], relationships:[], positioning:[], scorecards:[], sourceEvidence:{}, drift:[] };
    this.data.brain.causal ??= { graphs:{}, investigations:[] };
    this.data.brain.checkpoints ??= [];
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
    if (!this.candidateMemoryRelevant(event)) return;
    this.data.memoryEvents ??= {};
    this.data.memoryEvents[event.key] = { key: event.key, storyKey: event.storyKey, fact: event.fact, action: event.action,
      changeType: event.changeType, entities: event.entities, sourceConfidence: event.sourceConfidence, eventTime: event.eventTime };
    this.data.memoryEvents[event.key]!.provenance = article.sourceMeta;
    // Tier-3 noise never becomes canonical story/stance memory. It remains a rejected-candidate record only.
    if (event.sourceTier <= 2 && event.causalChannel) {
      this.data.stories[event.storyKey] = { key: event.storyKey, lastAction: event.action, lastFact: event.fact,
        lastChange: event.changeType, updatedAt: event.eventTime, sent: this.data.stories[event.storyKey]?.sent ?? false };
      this.rememberActorStances(article, event);
      this.rememberMacro(event);
    }
    this.save();
  }
  /** Store a relevant fact even when the production NEWS decision is DROP. */
  rememberEvidence(article: NewsArticle, event: EventAssessment, alerted: boolean): void {
    if (!this.memoryRelevant(event)) return;
    const brain = this.data.brain ??= emptyBrain();
    const { stateKey, subtopic } = classifyEvidence(event.storyKey, event.fact);
    const id = event.key;
    const record = { id, timestamp: new Date().toISOString(), topic: event.storyKey, subtopic, facts: event.fact,
      entities: event.entities, provider: article.provider, sourceTier: event.sourceTier,
      verification: event.sourceTier === 1 ? "OFFICIAL" : event.sourceTier === 2 ? "RELIABLE_WIRE" : "UNCONFIRMED",
      eventId: event.key, storyId: event.storyKey,
      delta: event.informationDelta === 0 ? "CONFIRMATION" : event.changeType,
      alertDecision: alerted ? "SENT" : "MEMORY_ONLY" } as const;
    brain.evidence[id] = record;
    if (event.sourceTier <= 2 && event.informationDelta > 0) brain.states[stateKey] = record;
    this.save();
  }
  /** Broad memory is allowed, but it must still have an evidenced market channel. */
  private memoryRelevant(event: EventAssessment): boolean {
    if (event.causalChannel) return true;
    return this.memoryRelevantText(event.storyKey, event.fact);
  }
  private memoryRelevantText(storyKey: string, fact: string): boolean {
    const structural = /china.*(gold|shanghai|etf|import)|gold.*(china|etf|central bank|comex|physical premium|india)|central bank.*gold/i.test(fact);
    return structural || /^(fed-policy|us-macro-|iran-gulf-conflict|oil-supply|trade-sanctions|china-gold|structural-gold|treasury-|fx-)/.test(storyKey);
  }
  /** Candidate memory additionally retains explicit cross-asset state observations without widening active evidence. */
  private candidateMemoryRelevant(event: EventAssessment): boolean {
    if (this.genericCorporateWithoutTransmission(event.fact)) return false;
    return this.memoryRelevant(event) || this.candidateMemoryRelevantText(event.storyKey, event.fact);
  }
  private candidateMemoryRelevantText(storyKey: string, fact: string): boolean {
    return this.memoryRelevantText(storyKey, fact) || this.hasCandidateMarketTransmission(fact);
  }
  /**
   * Candidate memory is broader than canonical evidence, but only where the text
   * itself identifies a macro transmission. This deliberately does not use a
   * company-name list: an AI/privacy dispute and an export-control action can
   * involve the same company but belong to different market regimes.
   */
  private hasCandidateMarketTransmission(fact: string): boolean {
    return /\b(treasury|yield|yields|bond|auction|real yield|dxy|dollar|fx|eurusd|gbpjpy|fed|fomc|interest rate|inflation|cpi|pce|nfp|payroll|gdp|ism|retail sales|jobless claims|oil|crude|brent|wti|opec|energy supply|refinery|commodity|hormuz|tanker|shipping disruption|tariff|sanction|export control|trade restriction|semiconductor restriction|financial stability|systemic financial|bank run|liquidity stress|credit market|capital market|fiscal policy|treasury supply|central bank gold|gold reserve|gold etf)\b/i.test(fact);
  }
  private genericCorporateWithoutTransmission(fact: string): boolean {
    const corporateMatter = /\b(earnings|quarterly results|acquisition|takeover|laboratory|dating|real estate|privacy|data breach|data breaches|data leak|security incident|cyber incident|user[- ]data|routing|product dispute|antitrust lawsuit|corporate litigation|investigation|probes?|lawsuit|litigation)\b/i.test(fact);
    return corporateMatter && !this.hasCandidateMarketTransmission(fact);
  }
  /** Legacy candidate cleanup is deliberately narrow: uncertain non-market records stay auditable. */
  private clearlyIrrelevantCandidate(record: MemoryEvent): boolean {
    if (!record.storyKey.startsWith("other-")) return false;
    const text = `${record.fact} ${record.action}`.toLowerCase();
    if (this.genericCorporateWithoutTransmission(text)) return true;
    if (this.candidateMemoryRelevantText(record.storyKey, record.fact)) return false;
    // Clear corporate/product matters lack a market channel unless the prior gate
    // found an explicit macro, trade, energy, or systemic-finance context.
    return /\b(earnings|quarterly results|acquisition|takeover|laboratory|dating|real estate|privacy|data breach|data breaches|data leak|security incident|cyber incident|user[- ]data|routing|product dispute|antitrust lawsuit|corporate litigation|investigation|probes?|lawsuit|litigation)\b/.test(text);
  }
  /** Move only clear legacy candidate noise to an auditable quarantine; never delete it. */
  quarantineIrrelevantCandidateMemory(): number {
    const candidates = Object.entries(this.data.memoryEvents ?? {}).filter(([, record]) => this.clearlyIrrelevantCandidate(record));
    if (!candidates.length) return 0;
    if (existsSync(this.path)) copyFileSync(this.path, `${this.path}.backup-pre-candidate-memory-cleanup-${Date.now()}`);
    this.data.candidateMemoryQuarantine ??= {};
    for (const [id, record] of candidates) {
      this.data.candidateMemoryQuarantine[id] = { quarantinedAt: new Date().toISOString(), reason: "NO_PLAUSIBLE_MARKET_TRANSMISSION", original: record };
      delete this.data.memoryEvents![id];
    }
    this.save(); return candidates.length;
  }
  /** Deterministic, reversible cleanup: quarantine only records with no valid market topic or channel. */
  quarantineIrrelevantEvidence(): number {
    const brain = this.data.brain ??= emptyBrain(); brain.quarantine ??= {};
    const irrelevant = Object.entries(brain.evidence).filter(([, record]) => {
      const eligible = /^(fed-policy|us-macro-|iran-gulf-conflict|oil-supply|trade-sanctions|china-gold|structural-gold|treasury-|fx-)/.test(record.topic) ||
        /gold|xau|fed|fomc|inflation|yield|treasury|dxy|dollar|oil|crude|brent|wti|hormuz|iran|sanction|tariff|macro|central bank|etf|comex|physical/i.test(`${record.topic} ${record.subtopic} ${record.facts}`);
      return !eligible;
    });
    if (!irrelevant.length) return 0;
    // A cleanup always keeps a complete pre-cleanup copy on the persistent disk.
    if (existsSync(this.path)) copyFileSync(this.path, `${this.path}.backup-pre-memory-cleanup-${Date.now()}`);
    for (const [id, record] of irrelevant) {
      brain.quarantine[id] = { quarantinedAt: new Date().toISOString(), reason: "NO_PLAUSIBLE_MARKET_TRANSMISSION", original: record };
      delete brain.evidence[id];
    }
    this.save(); return irrelevant.length;
  }
  recordMarketSnapshot(snapshot: MarketPoint): void {
    const brain = this.data.brain ??= emptyBrain(); brain.snapshots.push(snapshot);
    brain.lastObserverAt = snapshot.capturedAt;
    // Keep compact bars, never high-frequency raw tick history (seven days at five minutes).
    brain.snapshots.splice(0, Math.max(0, brain.snapshots.length - 2_016)); this.save();
  }
  recordShadow(decision: ShadowDecision): void {
    const brain = this.data.brain ??= emptyBrain(); brain.shadow.push(decision);
    brain.shadow.splice(0, Math.max(0, brain.shadow.length - 1_000)); this.save();
  }
  recordExperience(experience: MarketExperience): void {
    const brain = this.data.brain ??= emptyBrain(); brain.experiences.push(experience);
    brain.experiences.splice(0, Math.max(0, brain.experiences.length - 500)); this.save();
  }
  /** Versioned shadow evidence only; no method here participates in NEWS routing. */
  quantitative(): QuantitativeState { return (this.data.brain ??= emptyBrain()).quantitative ??= { observations:{}, models:[], relationships:[], positioning:[], scorecards:[], sourceEvidence:{}, drift:[] }; }
  recordQuantObservation(observation: QuantObservation): void { const q=this.quantitative(); q.observations[`${observation.instrument}|${observation.observedAt}`]=observation; this.save(); }
  recordQuantModel(model: QuantModel): void { const q=this.quantitative(); if(q.models.some(item=>item.id===model.id&&item.version===model.version)) throw new Error("Quantitative model versions are immutable"); q.models.push(model); this.save(); }
  recordRelationship(item: Relationship): void { this.quantitative().relationships.push(item); this.save(); }
  recordPositioning(item: PositioningState): void { this.quantitative().positioning.push(item); this.quantitative().positioning.splice(0, Math.max(0,this.quantitative().positioning.length-520)); this.save(); }
  recordScorecard(item: Scorecard): void { const q=this.quantitative(); const i=q.scorecards.findIndex(x=>x.id===item.id); if(i<0) q.scorecards.push(item); else q.scorecards[i]=item; this.save(); }
  recordSourceEvidence(item: SourceEvidence): void { this.quantitative().sourceEvidence[item.source]=item; this.save(); }
  recordQuantDrift(item: DriftRecord): void { this.quantitative().drift.push(item); this.quantitative().drift.splice(0, Math.max(0,this.quantitative().drift.length-500)); this.save(); }
  causalGraphs(): Record<string,CausalGraph> { return ((this.data.brain ??= emptyBrain()).causal ??= {graphs:{},investigations:[]}).graphs; }
  recordCausalGraph(graph:CausalGraph): void { this.causalGraphs()[graph.storyId]=graph; this.save(); }
  recordInvestigation(item:AbnormalInvestigation):void { const c=(this.data.brain ??=emptyBrain()).causal ??= {graphs:{},investigations:[]};c.investigations.push(item);c.investigations.splice(0,Math.max(0,c.investigations.length-500));this.save(); }
  checkpoints():Checkpoint[]{return (this.data.brain ??=emptyBrain()).checkpoints ??=[];}
  scheduleCheckpoint(item:Checkpoint):boolean{if(this.checkpoints().some(x=>x.id===item.id))return false;this.checkpoints().push(item);this.save();return true;}
  updateCheckpoint(item:Checkpoint):void{const all=this.checkpoints(),i=all.findIndex(x=>x.id===item.id);if(i>=0){all[i]=item;this.save();}}
  dueCheckpoints(now:string):Checkpoint[]{return this.checkpoints().filter(x=>(x.status==="PENDING"||x.status==="RETRY")&&x.scheduledAt<=now);}
  shadowStatus():Record<string,unknown>{const b=this.marketBrain(),q=this.quantitative();return{schemaVersion:b.schemaVersion,phase5:"OFF",marketSnapshots:b.snapshots.length,marketData:b.snapshots.at(-1)?.coverage?.quality??"DATA_UNAVAILABLE",providers:b.providerHealth,activeStories:Object.keys(this.data.stories).length,pendingCheckpoints:this.checkpoints().filter(x=>x.status==="PENDING").length,completedCheckpoints:this.checkpoints().filter(x=>x.status==="COMPLETED").length,experiences:b.experiences.length,causalGraphs:Object.keys(b.causal?.graphs??{}).length,quantModels:q.models.length,noEdge:q.relationships.filter(x=>x.state==="NO_EDGE_FOUND").length,quarantine:Object.keys(b.quarantine??{}).length};}
  similarExperiences(regime: string, trigger: string): MarketExperience[] {
    return (this.data.brain?.experiences ?? []).filter((item) => item.regime === regime || item.trigger === trigger).slice(-5);
  }
  markProvider(provider: string, status: "CONFIGURED" | "FETCHED" | "LIVE" | "ERROR", detail?: string): void {
    const health = (this.data.brain ??= emptyBrain()).providerHealth[provider] ??= { configured: false };
    if (status === "CONFIGURED") health.configured = true;
    if (status === "FETCHED") health.lastFetchedAt = new Date().toISOString();
    if (status === "LIVE") health.lastLiveDataAt = new Date().toISOString();
    if (status === "ERROR") health.lastError = detail ?? "provider error";
    this.save();
  }
  marketBrain(): PersistentMarketBrain { return this.data.brain ??= emptyBrain(); }
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
