/**
 * Phase 1-4 state only.  Nothing in this module can change NEWS routing.
 * Records contain evidence and conclusions, never model reasoning traces.
 */
export const MARKET_BRAIN_SCHEMA_VERSION = 2;

export type EvidenceRecord = {
  id: string; timestamp: string; topic: string; subtopic: string; facts: string;
  entities: string[]; provider: string; sourceTier: number; verification: string;
  eventId?: string; storyId?: string; delta: string; alertDecision: "SENT" | "MEMORY_ONLY" | "REJECTED";
  expiryAt?: string; supersedes?: string;
};
export type MarketPoint = { capturedAt: string; values: Record<string, { price: number; changePercent: number; fresh: boolean }>; session: string };
export type ShadowDecision = {
  timestamp: string; eventId?: string; kind: "CONSISTENT" | "CROSS_ASSET_DIVERGENCE" | "UNEXPLAINED_MOVE" | "DECAYING" | "CONTEXTUAL_ONLY";
  attribution: "CONFIRMED_DRIVER" | "LIKELY_DRIVER" | "POSSIBLE_DRIVER" | "MULTIPLE_COMPETING_DRIVERS" | "INSUFFICIENT_EVIDENCE" | "DRIVER_UNKNOWN";
  facts: string[]; channels: string[]; confidence: number; productionDecision?: string;
};
export type MarketExperience = { id: string; createdAt: string; regime: string; trigger: string; marketSnapshotId?: string; attribution: ShadowDecision["attribution"]; confidence: number; outcome?: string };
export type PersistentMarketBrain = {
  schemaVersion: number;
  migratedAt: string;
  evidence: Record<string, EvidenceRecord>;
  states: Record<string, EvidenceRecord>;
  snapshots: MarketPoint[];
  shadow: ShadowDecision[];
  experiences: MarketExperience[];
  providerHealth: Record<string, { configured: boolean; lastFetchedAt?: string; lastLiveDataAt?: string; lastError?: string }>;
  quarantine?: Record<string, { quarantinedAt: string; reason: string; original: EvidenceRecord }>;
  lastObserverAt?: string;
};

export function emptyBrain(now = new Date().toISOString()): PersistentMarketBrain {
  return { schemaVersion: MARKET_BRAIN_SCHEMA_VERSION, migratedAt: now, evidence: {}, states: {}, snapshots: [], shadow: [], experiences: [], providerHealth: {}, quarantine: {} };
}

export function sessionAt(date: Date): string {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "2-digit", hourCycle: "h23" }).format(date));
  if (hour < 7) return "ASIA";
  if (hour < 12) return "LONDON";
  if (hour < 21) return "NEW_YORK";
  return "ROLL_OVER";
}

export function classifyEvidence(topic: string, facts: string): { stateKey: string; subtopic: string } {
  const text = `${topic} ${facts}`.toLowerCase();
  if (/china.*(gold|shanghai|etf|import)|gold.*china/.test(text)) return { stateKey: "china-gold-market", subtopic: "structural_gold_demand" };
  if (/(etf|central bank|comex|physical premium|india).*gold/.test(text)) return { stateKey: "structural-gold-demand", subtopic: "structural_gold_demand" };
  if (/(fed|fomc|powell|goolsbee|waller|warsh)/.test(text)) return { stateKey: "fed-state", subtopic: "fed_stance" };
  if (/(cpi|pce|nfp|payroll|unemployment|gdp|ism|retail sales)/.test(text)) return { stateKey: "macro-state", subtopic: "macro_release" };
  if (/(hormuz|iran|israel|houthi|saudi|war|ceasefire)/.test(text)) return { stateKey: "geopolitical-state", subtopic: "geopolitics" };
  if (/(oil|crude|brent|wti|tanker|opec|shipping)/.test(text)) return { stateKey: "energy-state", subtopic: "energy" };
  if (/(tariff|sanction|trade)/.test(text)) return { stateKey: "trade-state", subtopic: "trade" };
  if (/(treasury|yield|curve)/.test(text)) return { stateKey: "treasury-state", subtopic: "treasury" };
  if (/(dxy|dollar|eurusd|gbpjpy|fx)/.test(text)) return { stateKey: "fx-state", subtopic: "fx" };
  return { stateKey: "general-market-state", subtopic: "event" };
}
