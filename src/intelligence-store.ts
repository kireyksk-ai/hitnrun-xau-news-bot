import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NewsArticle } from "./types.js";
import type { ChangeType, EventAssessment, StoryState } from "./event-intelligence.js";

export type DecisionStage = "SOURCE" | "NORMALIZE" | "DUPLICATE" | "DELTA" | "SCORE" | "AI" | "SHADOW" | "ROUTING" | "SENT";
export type ReviewRecord = {
  id: string; article: NewsArticle; event: EventAssessment; stage: DecisionStage;
  primaryDecision: "SEND" | "DROP" | "REVIEW"; reason: string;
  shadowDecision?: "SEND" | "DROP"; shadowScore?: number;
  renderedMessage?: string;
  sentAt?: string; telegramMessageIds?: Record<string, number>;
  adminDecision?: "FALSE_NEGATIVE" | "FALSE_POSITIVE"; adminReason?: string;
};
type Metrics = { ingested: number; uniqueEvents: number; alertsSent: number; duplicatesRemoved: number;
  lowValueRejected: number; unverifiedRejected: number; highRiskMisses: number;
  providerFailures: number; aiFailures: number; latencyTotalMs: number; latencyCount: number;
  providerLatencyMs: Record<string, { total: number; count: number }> };
const emptyMetrics = (): Metrics => ({ ingested: 0, uniqueEvents: 0, alertsSent: 0, duplicatesRemoved: 0,
  lowValueRejected: 0, unverifiedRejected: 0, highRiskMisses: 0, providerFailures: 0, aiFailures: 0,
  latencyTotalMs: 0, latencyCount: 0, providerLatencyMs: {} });
type Data = { records: Record<string, ReviewRecord>; stories: Record<string, StoryState>; metrics: Record<string, Metrics>;
  safeMode: boolean; lastReportDay?: string; updateOffset: number; regime: string };

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
  records(): ReviewRecord[] { return Object.values(this.data.records); }
  record(item: ReviewRecord): void { this.data.records[item.id] = item; this.save(); }
  getStory(key: string): StoryState | undefined { return this.data.stories[key]; }
  rememberStory(event: EventAssessment, sent: boolean): void {
    this.data.stories[event.storyKey] = { key: event.storyKey, lastAction: event.action,
      lastFact: event.fact, lastChange: event.changeType as ChangeType, updatedAt: new Date().toISOString(), sent };
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
      novelty: 0, marketRelevance: 0, informationDelta: 0, directionConfidence: 0,
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

