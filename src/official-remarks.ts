import type { NewsArticle } from "./types.js";

/**
 * Official remarks: anything a policymaker or state official says about money, prices, trade or war.
 * Owner rule (2026-09-25): every such comment, from any provider, must reach the analysis, and a NEWS
 * alert must go out as soon as a new one is found (still deduplicated, still source-checked).
 */
const NAMES = [
  // Fed
  "Powell", "Warsh", "Waller", "Bowman", "Barr", "Cook", "Jefferson", "Williams", "Daly", "Bostic", "Goolsbee", "Logan", "Musalem",
  "Schmid", "Collins", "Hammack", "Kashkari", "Miran", "Paulson", "Harker", "Barkin", "Mester",
  // US administration
  "Trump", "Vance", "Bessent", "Lutnick", "Greer", "Navarro", "Hassett", "Rubio", "Hegseth", "Leavitt", "Witkoff", "Wright", "Burgum",
  // other central banks / Europe / UK / Japan
  "Lagarde", "Schnabel", "Lane", "Nagel", "Villeroy", "Kazaks", "Holzmann", "Bailey", "Ueda", "Himino", "Takaichi", "Kato", "Katayama", "Macklem", "Bullock", "Jordan", "Schlegel",
  // China / Russia / Ukraine
  "Xi", "He Lifeng", "Wang Yi", "Pan Gongsheng", "Putin", "Peskov", "Lavrov", "Zelenskiy", "Zelensky",
  // Middle East / energy
  "Netanyahu", "Katz", "Khamenei", "Pezeshkian", "Araghchi", "Baghaei", "bin Salman", "Abdulaziz", "Novak", "Erdogan", "Al-Sudani", "Qalibaf"
];
const ROLES = /\b(Fed(?:eral Reserve)?|FOMC|ECB|BOE|BoE|BOJ|BoJ|SNB|RBA|BoC|BOC|PBOC|PBoC|central bank|White House|Treasury|Commerce|USTR|Pentagon|State Department|Kremlin|Tehran|IRGC|Saudi|OPEC\+?|Aramco|Israel(?:i)?|Iran(?:ian)?|China(?:'s|ese)?|Beijing|EU|European Commission|minister|ministry|secretary|governor|president|chair(?:man|woman)?|spokes(?:man|woman|person)|official|envoy|lawmaker|senator|prime minister|foreign minister|finance minister|energy minister)\b/i;
const SPEECH = /\b(says?|said|warns?|signals?|sees|expects?|tells?|told|stresses|urges|vows|threatens?|rules out|backs|reiterates|reaffirm(?:s|ed)?|agree[sd]?|pledges?|announce[sd]?|claims?|insists?|denies|confirms?|comments?|remarks?|testif(?:y|ies))\b|^[^:]{2,60}:\s/i;
const TOPIC = /\b(rates?|rate (?:hike|cut)s?|hike|cut|inflation|prices?|monetary|policy|tightening|easing|balance sheet|QT|yields?|dollar|currency|yen|yuan|gold|tariffs?|trade|deal|truce|summit|export|import|sanctions?|war|strike|attack|missile|ceasefire|talks|negotiat\w*|nuclear|Hormuz|oil|crude|OPEC|production|output|China|Xi|Iran|Israel|Saudi|Gaza|Houthi|Red Sea|Ukraine|Russia|Taiwan|recession|economy|growth|jobs|labor|deficit|debt|shutdown)\b/i;

const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameRe = new RegExp(`\\b(${NAMES.map(esc).join("|")})(?:'s)?\\b`);
// Squawk wires write in capitals ("TRUMP SAYS ..."); matched case-sensitively so "cook"/"lane" in prose never count.
const upperRe = new RegExp(`\\b(${NAMES.map((n) => esc(n.toUpperCase())).join("|")})(?:'S)?\\b`);
const findName = (t: string) => t.match(nameRe)?.[1] ?? t.match(upperRe)?.[1];

/** The official and topic of an official remark, or undefined. Pure headline check, no AI. */
export function officialRemark(article: Pick<NewsArticle, "title" | "summary">): { who: string; topic: string } | undefined {
  const title = (article.title ?? "").replace(/^@\w+:\s*/, "").replace(/\s+/g, " ").trim();
  if (title.length < 12) return undefined;
  const text = `${title} ${(article.summary ?? "").slice(0, 200)}`;
  const topic = title.match(TOPIC)?.[0] ?? (article.summary ?? "").slice(0, 200).match(TOPIC)?.[0];
  if (!topic || !SPEECH.test(title)) return undefined;
  const who = findName(title) ?? title.match(ROLES)?.[0] ?? findName(text);
  if (!who) return undefined;
  // Market recaps, previews and opinion pieces quote officials but add no new remark.
  if (/\b(preview|week ahead|what to watch|recap|wrap|explainer|opinion|analysis:|how to trade|stocks? to (?:buy|watch)|price prediction)\b/i.test(title)) return undefined;
  // Multi-story roundups ("Trump: 'Productive' Xi Meeting, Consumer Sentiment Falls, More") are digests, not a new remark.
  if (/,\s*More\b|\bStocks? (?:Steady|Rise|Fall|Slip|Gain)|\bMarkets? Wrap\b|\bBriefing\b/i.test(title)) return undefined;
  return { who, topic: topic.toLowerCase() };
}

export type RemarkLine = { at: string; who: string; title: string };
/** Newest distinct official remarks since `sinceMs` (one line per wording), for Sol and the briefings. */
export function remarksDigest(items: Array<{ title?: string; summary?: string; publishedAt?: string | Date; fetchedAt?: string }>, sinceMs: number, max = 25): RemarkLine[] {
  const seen = new Set<string>(), out: RemarkLine[] = [];
  const rows = items.map((i) => ({ i, t: Date.parse(String(i.publishedAt ?? i.fetchedAt ?? "")) })).filter((r) => r.t >= sinceMs).sort((a, b) => b.t - a.t);
  for (const { i, t } of rows) {
    const remark = officialRemark({ title: i.title ?? "", summary: i.summary ?? "" });
    if (!remark) continue;
    const title = (i.title ?? "").replace(/^@\w+:\s*/, "").replace(/\s+/g, " ").trim();
    const key = title.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").filter((w) => w.length > 2).slice(0, 8).join(" ");
    if (seen.has(key)) continue;
    seen.add(key); out.push({ at: new Date(t).toISOString(), who: remark.who, title: title.slice(0, 180) });
    if (out.length >= max) break;
  }
  return out;
}
export function remarksBlock(lines: RemarkLine[], label: string): string {
  if (!lines.length) return "";
  const wib = (iso: string) => new Date(Date.parse(iso) + 7 * 3600_000).toISOString().slice(11, 16);
  return `${label} (wajib ikut ditimbang dalam analisa; ini ucapan pejabat, bukan opini media):\n${lines.map((l) => `- ${wib(l.at)} WIB ${l.title}`).join("\n")}`;
}
