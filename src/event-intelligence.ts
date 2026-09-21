import { createHash } from "node:crypto";
import type { NewsArticle } from "./types.js";

export type ChangeType = "NEW_INFORMATION" | "CONFIRMATION" | "REPEAT" | "RUMOR" | "DENIAL" | "ESCALATION" | "DE_ESCALATION" | "POLICY_CHANGE";
export type SourceTier = 1 | 2 | 3;
export type StoryState = { key: string; lastAction: string; lastFact: string; lastChange: ChangeType; updatedAt: string; sent: boolean };
export type EventAssessment = {
  key: string; storyKey: string; action: string; fact: string; entities: string[];
  changeType: ChangeType; sourceTier: SourceTier; sourceConfidence: number;
  importance: number; urgency: number; novelty: number; marketRelevance: number;
  actorImportance: number; marketMateriality: number; magnitude: number; transmissionConfidence: number;
  causalChannel: string | null;
  informationDelta: number; directionConfidence: number; highPriority: boolean;
  unscheduled: boolean; transmissionChannels: string[]; quotedText?: string;
  publishedAt: string; eventTime: string; firstSeenAt: string; lastUpdatedAt: string;
  reasons: string[];
};

const entities = ["trump", "iran", "israel", "saudi", "hormuz", "houthi", "fed", "fomc", "treasury", "opec", "russia", "china"];
const scheduled = /\b(cpi|pce|nfp|nonfarm payroll|gdp|ism|retail sales|jobless claims|fomc decision|treasury auction)\b/i;
const relevant = /\b(gold|xau|dxy|dollar|treasury|yield|inflation|oil|crude|brent|wti|tanker|shipping|fed|fomc|rate|war|iran|hormuz|sanction|tariff|cpi|pce|nfp|payroll|gdp|retail sales|fiscal|tax)\b/i;
const authority = /\b(trump|white house|president|fed|fomc|powell|goolsbee|waller|treasury|bessent|iran|israel|saudi|houthi|opec)\b/i;
const materialAction = /\b(announces?|orders?|imposes?|approves?|rejects?|denies?|cancels?|withdraws?|rules out|agrees?|accepts?|offers?|open to meeting|attacks?|strikes?|launches?|threatens?|threat|blocks?|declares?|signals?|ceasefire|ultimatum|disrupts?|disrupted|shuts? down|reopens?|resumes?|hikes?|cuts?|raises?|releases?|vot(?:es|ed)|surges?|plunges?|revis(?:es|ed))\b/i;
const minorOrCommentary = /\b(analyst opinion|market commentary|roundup|weekly outlook|could someday|routine maintenance|small local|minor disruption|unchanged|reiterates?|repeats?|no new details|without new policy|without a policy change|without announcing policy)\b/i;
const mediaOrPersonal = /\b(cnn|politico|msnbc|journalists?|press access|media seating|news media|polling|television ratings?|anchor|newspaper|campaign volunteer|birthday|award|sports champion|charity gala|social media followers?|judge over personal|court scheduling)\b/i;
const macro = /\b(cpi|pce|nfp|payroll|unemployment|retail sales|gdp|ism|jobless claims|inflation data)\b/i;
const surprise = /\b(above consensus|below consensus|surprise|sharply|revised|revision|plunges?|surges?|shock|higher than forecast|lower than forecast)\b/i;
const rates = /\b(fed|fomc|interest rates?|rate cuts?|rate hikes?|treasury|yields?|dollar|dxy|debt|deficit|fiscal|tax policy|stimulus|balance sheet|reserves?)\b/i;
const geo = /\b(iran|israel|russia|ukraine|china|hormuz|houthi|war|ceasefire|military|missile|peace talks?)\b/i;
const energy = /\b(oil|crude|brent|wti|tanker|shipping|opec|energy facilit|export terminal|strategic oil reserves?|oil reserves?)\b/i;
const trade = /\b(tariffs?|sanctions?|trade agreement|trade policy|export controls?)\b/i;
function causalChannel(text: string): string | null {
  if (minorOrCommentary.test(text)) return null;
  // A media/personal grievance remains non-market even if it mentions Iran or Fed.
  if (mediaOrPersonal.test(text) && !/\b(announces?|orders?|imposes?|approves?|cancels?|withdraws?|cuts?|hikes?)\b.{0,90}\b(tariffs?|sanctions?|rates?|oil|iran policy|fed policy|tax policy)\b/i.test(text)) return null;
  if (macro.test(text) && surprise.test(text)) return "DATA → FED_EXPECTATIONS → YIELDS/USD → XAU";
  if (trade.test(text) && materialAction.test(text)) return "TRADE/SANCTIONS → INFLATION/GROWTH → FED/USD → XAU";
  if (energy.test(text) && materialAction.test(text)) return "OIL_SUPPLY → INFLATION/RISK → YIELDS/USD → XAU";
  if (geo.test(text) && materialAction.test(text)) return "GEOPOLITICAL_CHANGE → OIL/RISK → INFLATION/USD → XAU";
  if (rates.test(text) && materialAction.test(text)) return "POLICY/RATES → YIELDS → DXY → XAU";
  return null;
}
const actionTerms = /\b(rejects?|denies?|cancels?|rules out|agrees?|accepts?|meets?|meeting|talks?|negotiat\w*|attacks?|strikes?|missiles?|ceasefires?|imposes?|sanctions?|cuts?|hikes?|holds?|raises?|announces?|confirms?|disrupt\w*|shuts?|reopens?|resumes?)\b/gi;

export function sourceTier(article: NewsArticle): SourceTier {
  const source = `${article.sourceName ?? ""} ${article.provider}`.toLowerCase();
  if (/federal reserve|treasury|white house|bureau of labor|bea|eia|central bank|government|truth social/.test(source)) return 1;
  if (/reuters|bloomberg|associated press|financial times|benzinga|firstsquawk|livesquawk|deltaone/.test(source)) return 2;
  return 3;
}
export function classifyChange(text: string): ChangeType {
  if (/\b(denies?|rejects?|rules out|cancels?|withdraws?)\b/i.test(text)) return "DENIAL";
  if (/\b(attacks?|strikes?|missiles?|ultimatum|escalat\w*|shuts? down)\b/i.test(text)) return "ESCALATION";
  if (/\b(ceasefire|talks?|meet\w*|negotiat\w*|de-escalat\w*|agrees?|reopens?|resumes?)\b/i.test(text)) return "DE_ESCALATION";
  if (/\b(announces?|approves?|decision|cuts?|hikes?|holds?|tariff|policy|guidance|imposes?|sanctions?)\b/i.test(text)) return "POLICY_CHANGE";
  if (/\b(confirms?|officially|verified)\b/i.test(text)) return "CONFIRMATION";
  if (/\b(rumou?r|sources say|said to|unconfirmed)\b/i.test(text)) return "RUMOR";
  return "NEW_INFORMATION";
}
function normalize(text: string): string { return text.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function storyKeyFor(text: string): string {
  const t = text.toLowerCase();
  if (/iran|hormuz|israel|saudi|houthi/.test(t)) return "iran-gulf-conflict";
  const release = t.match(/\b(cpi|pce|nfp|payroll|gdp|ism|retail sales|jobless claims)\b/);
  if (release) return `us-macro-${release[1].replaceAll(" ", "-")}`;
  if (/fed|fomc|powell|goolsbee|waller|warsh|rate/.test(t)) return "fed-policy";
  if (/oil|crude|brent|wti|opec|tanker/.test(t)) return "oil-supply";
  if (/tariff|sanction|trade/.test(t)) return "trade-sanctions";
  return `other-${createHash("sha256").update(normalize(text).slice(0, 80)).digest("hex").slice(0, 12)}`;
}
export function assessEvent(article: NewsArticle, prior?: StoryState, seenAt = new Date()): EventAssessment {
  const text = `${article.title} ${article.summary}`;
  const fact = normalize(text).slice(0, 360);
  const tier = sourceTier(article), changeType = classifyChange(text), storyKey = storyKeyFor(text);
  const namedEntities = entities.filter((entity) => new RegExp(`\\b${entity}\\b`, "i").test(text));
  const actions = [...text.matchAll(actionTerms)].map((match) => match[0].toLowerCase()).slice(0, 3);
  const action = actions.join("-") || changeType.toLowerCase();
  const key = createHash("sha256").update(`${storyKey}|${action}|${fact.slice(0, 180)}`).digest("hex");
  const hasNewFact = !prior || prior.lastFact !== fact;
  const reversal = Boolean(prior && ((changeType === "DENIAL" && prior.lastChange !== "DENIAL") || (prior.lastChange === "DENIAL" && changeType !== "DENIAL")));
  const informationDelta = !hasNewFact ? 0 : reversal ? 100 : prior?.lastAction === action ? 45 : 80;
  const novelty = !hasNewFact ? 0 : prior ? informationDelta : 90;
  const marketRelevance = relevant.test(text) ? 80 : 10;
  const sourceConfidence = tier === 1 ? 95 : tier === 2 ? 80 : 45;
  const channel = causalChannel(text);
  const actorImportance = authority.test(text) ? 90 : 40;
  const marketMateriality = channel ? 85 : 0;
  const magnitude = channel ? (/\b(major|surprise|sharply|shutdown|strike|attack|ceasefire|sanctions?|tariffs?)\b/i.test(text) ? 90 : 75) : 0;
  const transmissionConfidence = channel ? 85 : 0;
  const highPriority = tier <= 2 && channel !== null && (authority.test(text) || macro.test(text));
  const unscheduled = !scheduled.test(text);
  // Actor authority is recorded separately; it contributes nothing to importance.
  const importance = Math.min(100, Math.round(marketMateriality * 0.55 + novelty * 0.25 + magnitude * 0.20));
  const urgency = Math.min(100, importance + (unscheduled ? 15 : 0) + (reversal ? 15 : 0));
  const transmissionChannels: string[] = [];
  if (/iran|hormuz|saudi|houthi|oil|crude|tanker|opec/i.test(text)) transmissionChannels.push("OIL_SUPPLY", "INFLATION_EXPECTATIONS");
  if (/fed|fomc|cpi|pce|nfp|payroll|inflation|rate/i.test(text)) transmissionChannels.push("FED_PATH", "TREASURY_YIELDS", "DXY");
  if (/war|attack|missile|ceasefire|meeting|negotiat|sanction/i.test(text)) transmissionChannels.push("GEOPOLITICAL_RISK");
  if (/treasury|yield/i.test(text)) transmissionChannels.push("TREASURY_YIELDS", "DXY");
  if (channel) transmissionChannels.push("XAU");
  const quotedText = text.match(/[“"]([^”"]{5,250})[”"]/)?.[1];
  const reasons = [`source tier ${tier}`, `change ${changeType}`, `delta ${informationDelta}`, channel ?? "no concrete XAU transmission"];
  if (reversal) reasons.push("reversal of prior story");
  return { key, storyKey, action, fact, entities: namedEntities, changeType, sourceTier: tier, sourceConfidence,
    importance, urgency, novelty, marketRelevance, actorImportance, marketMateriality, magnitude, transmissionConfidence, causalChannel: channel,
    informationDelta, directionConfidence: 0, highPriority,
    unscheduled, transmissionChannels: [...new Set(transmissionChannels)], quotedText,
    publishedAt: article.publishedAt.toISOString(), eventTime: article.publishedAt.toISOString(),
    firstSeenAt: seenAt.toISOString(), lastUpdatedAt: seenAt.toISOString(), reasons };
}
export function shouldReview(event: EventAssessment, prior?: StoryState): boolean {
  if (event.informationDelta === 0) return false;
  if (!event.causalChannel || event.marketMateriality < 65 || event.transmissionConfidence < 65) return false;
  if (prior && event.informationDelta < 60 && event.changeType !== "DENIAL") return false;
  return event.highPriority || event.importance >= 65;
}

