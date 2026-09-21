import type { NewsArticle } from "./types.js";

export type EventAssessment = {
  key: string;
  score: number;
  highPriority: boolean;
  reasons: string[];
};

const highPriorityRules: Array<{ key: string; pattern: RegExp; label: string }> = [
  { key: "trump-geopolitics-policy", pattern: /\b(trump|donald trump)\b[\s\S]{0,240}\b(iran|russia|china|tariff|sanction|oil|fed|rate|dollar|treasury|trade|war)\b/i, label: "Pernyataan Trump berpotensi mengubah ekspektasi kebijakan atau konflik" },
  { key: "fed-rates", pattern: /\b(fed|fomc|powell|goolsbee|waller|warsh|daly|bostic|williams|bowman|jefferson)\b[\s\S]{0,240}\b(rate|rates|interest|inflation|policy|cut|hike|hold|yield)\b/i, label: "Pernyataan atau keputusan Fed terkait rate" },
  { key: "us-macro", pattern: /\b(cpi|pce|nfp|nonfarm|payroll|unemployment|wages|gdp|ism|retail sales|jobless claims)\b/i, label: "Data makro AS yang dapat mengubah pricing rate" },
  { key: "iran-war-diplomacy", pattern: /\b(iran|israel|saudi|houthi|hormuz)\b[\s\S]{0,260}\b(attack|strike|missile|ceasefire|negotia|meet|talk|ultimatum|sanction|war|diploma)\b/i, label: "Perubahan konflik atau diplomasi Timur Tengah" },
  { key: "oil-supply-logistics", pattern: /\b(oil|crude|brent|wti|tanker|shipping|hormuz|opec|aramco|saudi)\b[\s\S]{0,260}\b(supply|output|production|disruption|shortage|sanction|tanker|shipping|freight|export|refinery)\b/i, label: "Gangguan supply atau logistik energi" },
  { key: "trade-sanctions", pattern: /\b(tariff|sanction|trade)\b[\s\S]{0,260}\b(us|u\.s\.|america|china|iran|russia|oil|energy)\b/i, label: "Kebijakan dagang atau sanksi berpotensi mengubah inflasi dan USD" }
];

function normalized(text: string): string {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export function assessEvent(article: NewsArticle): EventAssessment {
  const text = `${article.title} ${article.summary}`;
  const lower = normalized(text);
  const reasons: string[] = [];
  let score = 0;
  const source = (article.sourceName ?? article.provider).toLowerCase();

  if (/reuters|bloomberg|associated press|ap |federal reserve|bureau of labor|bea|treasury|truth social/.test(source)) { score += 25; reasons.push("sumber primer atau tier-1"); }
  else if (/benzinga|firstsquawk|livesquawk|deltaone/.test(source)) { score += 18; reasons.push("wire cepat"); }
  else score += 10;

  const rule = highPriorityRules.find((candidate) => candidate.pattern.test(text));
  if (rule) { score += 55; reasons.push(rule.label); }
  if (/\b(gold|xau|dxy|treasury|yield|inflation|oil|crude|brent|wti|fed|rate|war|iran|hormuz|sanction|tariff)\b/i.test(text)) score += 15;
  if (/\b(announces?|said|says|approved|imposed|launched|agreed|meeting|decision|data|surprise|cuts?|hikes?)\b/i.test(text)) score += 10;

  const highPriority = Boolean(rule);
  const keyStem = rule?.key ?? lower.split(" ").slice(0, 10).join("-");
  return { key: keyStem.slice(0, 120), score: Math.min(score, 100), highPriority, reasons };
}

export function highPriorityFallback(article: NewsArticle, event: EventAssessment): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false }).format(article.publishedAt);
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    `⚠️ <b>${escape(article.title)}</b>`,
    `<b>${time} WIB | Event prioritas tinggi | Skor ${event.score}/100</b>`,
    "",
    escape(article.summary),
    "",
    "<b>Kenapa penting:</b> Event ini dapat mengubah risk premium, oil dan ekspektasi inflasi; jalur lanjutannya ke yield Treasury dan DXY menentukan dampak bersih ke emas. Arah belum dipaksakan sebelum transmisi pasar terkonfirmasi."
  ].join("\n");
}
