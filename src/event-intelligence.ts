import { createHash } from "node:crypto";
import type { NewsArticle } from "./types.js";

export type ChangeType = "NEW_INFORMATION" | "CONFIRMATION" | "REPEAT" | "RUMOR" | "DENIAL" | "ESCALATION" | "DE_ESCALATION" | "POLICY_CHANGE";
export type SourceTier = 1 | 2 | 3;
export type StoryState = { key: string; lastAction: string; lastFact: string; lastChange: ChangeType; updatedAt: string; sent: boolean };
export type EventAssessment = {
  key: string; storyKey: string; action: string; fact: string; entities: string[];
  changeType: ChangeType; sourceTier: SourceTier; sourceConfidence: number;
  importance: number; urgency: number; novelty: number; marketRelevance: number;
  informationDelta: number; directionConfidence: number; highPriority: boolean;
  unscheduled: boolean; transmissionChannels: string[]; quotedText?: string;
  publishedAt: string; eventTime: string; firstSeenAt: string; lastUpdatedAt: string;
  reasons: string[];
};

const entities = ["trump", "iran", "israel", "saudi", "hormuz", "houthi", "fed", "fomc", "treasury", "opec", "russia", "china"];
const scheduled = /\b(cpi|pce|nfp|nonfarm payroll|gdp|ism|retail sales|jobless claims|fomc decision|treasury auction)\b/i;
const relevant = /\b(gold|xau|dxy|dollar|treasury|yield|inflation|oil|crude|brent|wti|tanker|shipping|fed|fomc|rate|war|iran|hormuz|sanction|tariff|cpi|pce|nfp|payroll)\b/i;
const authority = /\b(trump|white house|president|fed|fomc|powell|goolsbee|waller|treasury|bessent|iran|israel|saudi|houthi|opec)\b/i;
const materialAction = /\b(announces?|orders?|imposes?|approves?|rejects?|denies?|cancels?|withdraws?|rules out|agrees?|accepts?|offers?|open to meeting|attacks?|strikes?|launches?|ceasefire|ultimatum|disrupts?|shuts? down|reopens?|resumes?|hikes?|cuts?|raises?|vot(?:es|ed)|surges?|plunges?)\b/i;
const materialObject = /\b(iran|hormuz|war|ceasefire|oil supply|oil exports?|energy facilities|tanker|shipping|sanctions?|tariffs?|fed|fomc|interest rates?|rates?|inflation|treasury yields?|dollar|cpi|pce|nfp|payroll|opec)\b/i;
const minorOrCommentary = /\b(analyst opinion|market commentary|roundup|weekly outlook|could someday|routine maintenance|small local|minor disruption|unchanged|reiterates?|repeats?|no new details)\b/i;
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
  const hasMaterialAction = materialAction.test(text);
  const hasMaterialObject = materialObject.test(text);
  const highPriority = tier <= 2 && authority.test(text) && hasMaterialAction && hasMaterialObject && !minorOrCommentary.test(text);
  const unscheduled = !scheduled.test(text);
  const materiality = hasMaterialAction && hasMaterialObject ? 85 : hasMaterialObject ? 45 : 10;
  const importance = Math.min(100, Math.round(sourceConfidence * 0.15 + novelty * 0.15 + marketRelevance * 0.15 + informationDelta * 0.15 + materiality * 0.4 + (highPriority ? 8 : 0) - (minorOrCommentary.test(text) ? 35 : 0)));
  const urgency = Math.min(100, importance + (unscheduled ? 15 : 0) + (reversal ? 15 : 0));
  const transmissionChannels: string[] = [];
  if (/iran|hormuz|saudi|houthi|oil|crude|tanker|opec/i.test(text)) transmissionChannels.push("OIL_SUPPLY", "INFLATION_EXPECTATIONS");
  if (/fed|fomc|cpi|pce|nfp|payroll|inflation|rate/i.test(text)) transmissionChannels.push("FED_PATH", "TREASURY_YIELDS", "DXY");
  if (/war|attack|missile|ceasefire|meeting|negotiat|sanction/i.test(text)) transmissionChannels.push("GEOPOLITICAL_RISK");
  if (/treasury|yield/i.test(text)) transmissionChannels.push("TREASURY_YIELDS", "DXY");
  transmissionChannels.push("XAU");
  const quotedText = text.match(/[“"]([^”"]{5,250})[”"]/)?.[1];
  const reasons = [`source tier ${tier}`, `change ${changeType}`, `delta ${informationDelta}`];
  if (reversal) reasons.push("reversal of prior story");
  return { key, storyKey, action, fact, entities: namedEntities, changeType, sourceTier: tier, sourceConfidence,
    importance, urgency, novelty, marketRelevance, informationDelta, directionConfidence: 0, highPriority,
    unscheduled, transmissionChannels: [...new Set(transmissionChannels)], quotedText,
    publishedAt: article.publishedAt.toISOString(), eventTime: article.publishedAt.toISOString(),
    firstSeenAt: seenAt.toISOString(), lastUpdatedAt: seenAt.toISOString(), reasons };
}
export function shouldReview(event: EventAssessment, prior?: StoryState): boolean {
  if (event.informationDelta === 0) return false;
  if (prior && event.informationDelta < 60 && event.changeType !== "DENIAL") return false;
  return event.highPriority || event.importance >= 65;
}
export function highPriorityFallback(article: NewsArticle, event: EventAssessment): string {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ageMinutes = Math.round((Date.now() - article.publishedAt.getTime()) / 60000);
  const age = ageMinutes > 60 ? ` (terbit ${ageMinutes} menit lalu)` : "";
  return [`⚠️ <b>${escape(article.title)}</b>`, `<b>${event.changeType}${age}</b>`,
    escape(article.summary || "Detail tambahan belum tersedia."),
    "Perubahan ini bisa memengaruhi risk premium, oil atau ekspektasi rate; dampak akhir ke emas masih dua arah sampai jalur inflasi, yield dan dolar jelas."].join("\n\n");
}

