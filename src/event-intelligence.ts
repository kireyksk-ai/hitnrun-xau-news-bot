import type { NewsArticle } from "./types.js";

export type ChangeType = "NEW_INFORMATION" | "CONFIRMATION" | "REPEAT" | "RUMOR" | "DENIAL" | "ESCALATION" | "DE_ESCALATION" | "POLICY_CHANGE";
export type SourceTier = 1 | 2 | 3;
export type EventAssessment = {
  key: string; storyKey: string; action: string; changeType: ChangeType; sourceTier: SourceTier;
  score: number; importance: number; urgency: number; highPriority: boolean; reasons: string[];
};

const HIGH_PRIORITY: Array<{ story: string; pattern: RegExp; label: string }> = [
  { story: "trump-policy-geopolitics", pattern: /\b(trump|donald trump)\b[\s\S]{0,240}\b(iran|russia|china|tariff|sanction|oil|fed|rate|dollar|treasury|trade|war)\b/i, label: "statement Trump yang berpotensi mengubah kebijakan atau konflik" },
  { story: "fed-rates", pattern: /\b(fed|fomc|powell|goolsbee|waller|warsh|daly|bostic|williams|bowman|jefferson)\b[\s\S]{0,240}\b(rate|rates|interest|inflation|policy|cut|hike|hold|yield)\b/i, label: "keputusan atau delta statement Fed" },
  { story: "us-macro", pattern: /\b(cpi|pce|nfp|nonfarm|payroll|unemployment|wages|gdp|ism|retail sales|jobless claims)\b/i, label: "rilis atau revisi data makro AS" },
  { story: "middle-east-conflict", pattern: /\b(iran|israel|saudi|houthi|hormuz)\b[\s\S]{0,260}\b(attack|strike|missile|ceasefire|negotia|meet|talk|ultimatum|sanction|war|diploma|reject)\b/i, label: "delta konflik atau diplomasi Timur Tengah" },
  { story: "oil-supply-logistics", pattern: /\b(oil|crude|brent|wti|tanker|shipping|hormuz|opec|aramco|saudi)\b[\s\S]{0,260}\b(supply|output|production|disruption|shortage|sanction|tanker|shipping|freight|export|refinery)\b/i, label: "delta supply atau logistik energi" },
  { story: "trade-sanctions", pattern: /\b(tariff|sanction|trade)\b[\s\S]{0,260}\b(us|u\.s\.|america|china|iran|russia|oil|energy)\b/i, label: "perubahan tarif atau sanksi" }
];

function normalized(text: string): string { return text.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }

function sourceTier(article: NewsArticle): SourceTier {
  const source = `${article.sourceName ?? ""} ${article.provider}`.toLowerCase();
  if (/federal reserve|treasury|white house|bureau of labor|bea|eia|central bank|government|truth social/.test(source)) return 1;
  if (/reuters|bloomberg|associated press|\bap\b|financial times|benzinga|firstsquawk|livesquawk|deltaone/.test(source)) return 2;
  return 3;
}

function classifyChange(text: string): ChangeType {
  if (/\b(denies|denied|rejects|rejected|rules out|cancels|cancelled|withdraws|withdrawn)\b/i.test(text)) return "DENIAL";
  if (/\b(attack|strike|missile|ultimatum|deploys|imposes|sanctions|escalat)\w*/i.test(text)) return "ESCALATION";
  if (/\b(ceasefire|talks|meeting|meet|negotiat|de-escalat|agrees)\w*/i.test(text)) return "DE_ESCALATION";
  if (/\b(announces|approved|decision|cuts?|hikes?|hold|tariff|policy|guidance)\b/i.test(text)) return "POLICY_CHANGE";
  if (/\b(confirms?|officially|verified)\b/i.test(text)) return "CONFIRMATION";
  if (/\b(reports?|rumou?r|said to|sources say)\b/i.test(text)) return "RUMOR";
  return "NEW_INFORMATION";
}

export function assessEvent(article: NewsArticle): EventAssessment {
  const text = `${article.title} ${article.summary}`;
  const lower = normalized(text);
  const tier = sourceTier(article);
  const changeType = classifyChange(text);
  const rule = HIGH_PRIORITY.find((candidate) => candidate.pattern.test(text));
  const reasons: string[] = [];
  let importance = tier === 1 ? 40 : tier === 2 ? 28 : 15;
  if (rule) { importance += 45; reasons.push(rule.label); }
  if (/\b(gold|xau|dxy|treasury|yield|inflation|oil|crude|brent|wti|fed|rate|war|iran|hormuz|sanction|tariff)\b/i.test(text)) importance += 15;
  if (changeType === "DENIAL" || changeType === "ESCALATION" || changeType === "DE_ESCALATION" || changeType === "POLICY_CHANGE") importance += 10;
  if (tier === 1) reasons.push("sumber primer"); else if (tier === 2) reasons.push("sumber tier-2"); else reasons.push("sumber tier-3");

  const actors = (lower.match(/\b(trump|iran|israel|saudi|houthi|fed|opec|russia|china|treasury)\b/g) ?? []).slice(0, 3).join("-");
  const action = (lower.match(/\b(meet|meeting|agree|approve|impose|launch|strike|ceasefire|negotia\w*|cut|hike|hold|increase|decrease|disrupt\w*|attack\w*|reject\w*|deny\w*)\b/g) ?? []).slice(0, 3).join("-") || changeType.toLowerCase();
  const storyKey = (rule ? `${rule.story}-${actors}` : lower.split(" ").slice(0, 6).join("-")).slice(0, 100);
  const score = Math.min(importance, 100);
  const highPriority = Boolean(rule) && (tier <= 2 || article.provider === "truth-social-trump");
  const urgency = Math.min(100, (highPriority ? 90 : 35) + (changeType === "DENIAL" || changeType === "ESCALATION" ? 10 : 0));
  return { key: `${storyKey}-${action}`.slice(0, 120), storyKey, action, changeType, sourceTier: tier, score, importance: score, urgency, highPriority, reasons };
}

export function highPriorityFallback(article: NewsArticle, event: EventAssessment): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false }).format(article.publishedAt);
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    `⚠️ <b>${escape(article.title)}</b>`,
    `<b>${time} WIB | Importance ${event.importance}/100 | Urgency ${event.urgency}/100 | ${event.changeType}</b>`,
    "",
    escape(article.summary),
    "",
    "<b>Kenapa penting:</b> Event ini dapat mengubah risk premium, oil dan ekspektasi inflasi; jalur lanjutannya ke yield Treasury dan DXY menentukan dampak bersih ke emas. Arah belum dipaksakan sebelum transmisi pasar terkonfirmasi."
  ].join("\n");
}
