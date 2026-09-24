import type { CalendarEvent } from "./economic-calendar.js";
import type { NewsArticle } from "./types.js";

/**
 * Release numbers from the wires. Calendar feeds are often late or empty on actuals; the fast
 * wires (Benzinga, FirstSquawk, DeItaone...) print them within seconds. A number is accepted
 * only for an event that was just released, when it sits next to the event's own words, has
 * the same unit and a plausible size versus the forecast/previous, and comes from a tier-1/2
 * source or from two independent sources that agree.
 */
const PATTERNS: Array<[RegExp, RegExp]> = [
  [/jobless claims|unemployment claims|initial claims/i, /\b(initial jobless claims|jobless claims|initial claims|unemployment claims)\b/i],
  [/nonfarm payrolls|non-farm employment change/i, /\b(non-?farm payrolls|nonfarm|non-farm|nfp|payrolls)\b/i],
  [/core cpi/i, /\bcore (cpi|consumer price|inflation)/i],
  [/\bcpi\b/i, /\b(cpi|consumer price)/i],
  [/core pce/i, /\bcore pce\b/i],
  [/\bppi\b/i, /\b(ppi|producer price)/i],
  [/retail sales/i, /\bretail sales\b/i],
  [/unemployment rate/i, /\bunemployment rate\b/i],
  [/average hourly earnings/i, /\b(average hourly earnings|wages?)\b/i],
  [/\bgdp\b/i, /\bgdp\b/i],
  [/ism manufacturing/i, /\bism manufacturing\b/i], [/ism services/i, /\bism (services|non-manufacturing)\b/i],
  [/jolts/i, /\bjolts\b|job openings/i], [/new home sales/i, /\bnew home sales\b/i], [/existing home sales/i, /\bexisting home sales\b/i],
  [/durable goods/i, /\bdurable goods\b/i], [/consumer confidence/i, /\bconsumer confidence\b/i], [/consumer sentiment|uom/i, /\b(consumer sentiment|michigan)\b/i]
];
export function mentionPattern(eventName: string): RegExp {
  const hit = PATTERNS.find(([name]) => name.test(eventName) && !(/\bcpi\b/i.test(name.source) && /core/i.test(eventName) && !/core/.test(name.source)));
  if (hit) return hit[1];
  const words = eventName.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !["change", "index", "final", "prelim", "flash"].includes(w));
  return new RegExp(words.map((w) => `(?=.*\\b${w})`).join("") || "$^", "i");
}
type Num = { value: number; unit: "%" | "LEVEL"; decimals: number; raw: string };
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mln: 1e6, million: 1e6, b: 1e9, bln: 1e9, billion: 1e9 };
export function parseFigure(raw: string): Num | null {
  const m = raw.replace(/,(?=\d{3})/g, "").trim().match(/^([-+]?\d+(?:\.(\d+))?)\s*(%|k|m|b|mln|bln|million|billion|thousand)?$/i);
  if (!m) return null;
  const unit = m[3]?.toLowerCase();
  return { value: Number(m[1]) * (unit && unit !== "%" ? SCALE[unit] : 1), unit: unit === "%" ? "%" : "LEVEL", decimals: m[2]?.length ?? 0, raw };
}
function format(n: Num, ref: Num & { suffix: string }): string {
  if (ref.unit === "%") return `${n.value.toFixed(ref.decimals)}%`;
  const scale = SCALE[ref.suffix.toLowerCase()] ?? 1;
  return `${(n.value / scale).toFixed(scale === 1 ? ref.decimals : Math.max(ref.decimals, n.value % scale ? 1 : 0))}${ref.suffix}`;
}
/** The actual printed in a headline for this event, formatted like the calendar's forecast; null when unsure. */
export function extractActual(text: string, event: Pick<CalendarEvent, "name" | "consensus" | "prior">): string | null {
  const refRaw = event.consensus ?? event.prior;
  const refMatch = refRaw?.replace(/,(?=\d{3})/g, "").match(/([-+]?\d+(?:\.\d+)?)\s*(%|K|M|B)?/i);
  if (!refMatch) return null;
  const ref = { ...parseFigure(`${refMatch[1]}${refMatch[2] ?? ""}`)!, suffix: refMatch[2] ?? "" };
  const clean = text.replace(/(\d),(\d{3})/g, "$1$2");
  const at = clean.search(mentionPattern(event.name));
  if (at < 0) return null;
  // Only the part after the event's name and before the comparison words carries the actual.
  const tail = clean.slice(at);
  const stop = tail.search(/\b(vs\.?|versus|est\.?|estimates?|expect(?:s|ed|ations?)?|exp\.|forecasts?|due|seen|preview|ahead of|consensus|prior|previous|prev\.?|revised|from)\b/i);
  const segment = stop > 0 ? tail.slice(0, stop) : tail.slice(0, 160);
  for (const m of segment.matchAll(/[-+]?\d+(?:\.\d+)?\s*(?:%|percent|k\b|m\b|b\b|mln|bln|million|billion|thousand)?/gi)) {
    const n = parseFigure(m[0].replace(/\s*percent/i, "%").replace(/\s+/g, ""));
    if (!n || n.unit !== ref.unit) continue;
    if (/^(19|20)\d\d$/.test(m[0].trim())) continue; // a year, not a figure
    if (ref.unit === "%" ? Math.abs(n.value - ref.value) > Math.max(1.5, Math.abs(ref.value) * 1.5)
      : !(ref.value > 0 && n.value / ref.value >= 0.4 && n.value / ref.value <= 2.5)) continue;
    return format(n, ref);
  }
  return null;
}

export type Captured = { id: string; name: string; actual: string; source: string; at: number };
export class ActualCapture {
  private pending = new Map<string, Array<{ actual: string; source: string; at: number }>>();
  private done = new Set<string>();
  /** Offers one fetched article; returns the events whose actual is now confirmed. */
  offer(article: Pick<NewsArticle, "title" | "summary" | "provider" | "author" | "sourceName">, tier: number, events: CalendarEvent[], now = Date.now()): Captured[] {
    const out: Captured[] = [];
    const text = `${article.title} ${article.summary.split("\n\nMARKET_CONTEXT_PACK")[0].slice(0, 600)}`;
    const source = `${article.provider}:${article.author ?? article.sourceName ?? ""}`;
    for (const e of events) {
      const t = Date.parse(e.releaseAt);
      if (e.actual || this.done.has(e.id) || now < t - 60_000 || now > t + 45 * 60_000) continue;
      const actual = extractActual(text, e);
      if (!actual) continue;
      const list = (this.pending.get(e.id) ?? []).filter((x) => now - x.at < 10 * 60_000);
      list.push({ actual, source, at: now });
      this.pending.set(e.id, list);
      const agreeing = new Set(list.filter((x) => x.actual === actual).map((x) => x.source));
      if (tier <= 2 || agreeing.size >= 2) { this.done.add(e.id); out.push({ id: e.id, name: e.name, actual, source, at: now }); }
    }
    return out;
  }
}
