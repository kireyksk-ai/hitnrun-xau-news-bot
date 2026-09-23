import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Outcome memory for news the bot did NOT send. Each rejected candidate is stored
 * with the XAU price at that moment and re-priced after 15 and 60 minutes, so the
 * bot can later recognise "this kind of headline was dismissed, yet gold moved".
 * Measurement only: nothing here can send, block or re-route an alert.
 */
export type ShadowMark = { at: string; returnPct: number };
export type ShadowItem = {
  id: string; at: string; title: string; storyKey: string; source: string; stage: string; reason: string;
  fact: string; entryPrice?: number; marks: { "15"?: ShadowMark; "60"?: ShadowMark };
};
export const SHADOW_MARKS = [15, 60] as const;
/** A move this large within an hour is worth remembering (gold intraday noise is ~0.1%). */
export const NOTABLE_MOVE_PCT = 0.25;

const stop = new Set(["the", "a", "an", "of", "to", "in", "on", "and", "for", "is", "are", "be", "will", "with", "at", "by", "from", "that", "this", "it", "as", "us", "u", "s", "says", "said", "say", "firstsquawk", "deitaone", "financialjuice", "livesquawk", "zerohedge", "benzinga", "reuters", "bloomberg"]);
export function tokens(fact: string): Set<string> {
  return new Set(fact.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2 && !stop.has(w) && !/^\d+$/.test(w)));
}
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0; for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

export function dueShadowMarks(item: ShadowItem, now: Date): Array<(typeof SHADOW_MARKS)[number]> {
  if (item.entryPrice === undefined) return [];
  const t0 = Date.parse(item.at);
  return SHADOW_MARKS.filter((m) => !item.marks[`${m}`] && now.getTime() >= t0 + m * 60_000 && now.getTime() - (t0 + m * 60_000) <= 30 * 60_000);
}
export function markShadow(item: ShadowItem, minutes: (typeof SHADOW_MARKS)[number], price: number, now: Date): ShadowItem {
  if (item.entryPrice === undefined || !(price > 0)) return item;
  return { ...item, marks: { ...item.marks, [`${minutes}`]: { at: now.toISOString(), returnPct: (price - item.entryPrice) / item.entryPrice * 100 } } };
}
const biggest = (item: ShadowItem) => [item.marks["15"]?.returnPct, item.marks["60"]?.returnPct].filter((x): x is number => x !== undefined)
  .reduce<number | undefined>((best, x) => best === undefined || Math.abs(x) > Math.abs(best) ? x : best, undefined);
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const wib = (iso: string) => new Date(Date.parse(iso) + 7 * 3600_000).toISOString().slice(11, 16);

/** Recently rejected items that were followed by a notable XAU move (possible misses). */
export function rejectedButMoved(items: ShadowItem[], now: Date, hours = 6, limit = 5): string[] {
  const since = now.getTime() - hours * 3600_000;
  return items.filter((i) => i.stage !== "SENT" && Date.parse(i.at) >= since && Math.abs(biggest(i) ?? 0) >= NOTABLE_MOVE_PCT)
    .sort((a, b) => a.at.localeCompare(b.at)).slice(-limit)
    .map((i) => `${wib(i.at)} WIB | ${i.storyKey} | ${i.title.replace(/\s+/g, " ").slice(0, 120)} | ditolak (${i.reason.slice(0, 40)}) | XAU ${signed(biggest(i)!)} dalam 1 jam`);
}

/** Past items (sent or rejected) with similar wording, and what gold did afterwards. */
export function similarPast(items: ShadowItem[], fact: string, now: Date, days = 30, threshold = 0.35, limit = 4): string[] {
  const mine = tokens(fact); if (mine.size < 3) return [];
  const since = now.getTime() - days * 86400_000;
  const matches = items.filter((i) => Date.parse(i.at) >= since && Date.parse(i.at) < now.getTime() - 5 * 60_000 && biggest(i) !== undefined)
    .map((i) => ({ i, score: similarity(mine, tokens(i.fact)) })).filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score).slice(0, limit);
  if (!matches.length) return [];
  const moves = matches.map((m) => biggest(m.i)!);
  const notable = moves.filter((v) => Math.abs(v) >= NOTABLE_MOVE_PCT).length;
  const head = `${matches.length} berita mirip dalam ${days} hari; ${notable} diikuti gerak XAU ≥${NOTABLE_MOVE_PCT}% dalam 1 jam (rata-rata ${signed(moves.reduce((a, b) => a + b, 0) / moves.length)})`;
  return [head, ...matches.map((m) => `${m.i.at.slice(5, 10)} ${wib(m.i.at)} WIB | ${m.i.stage === "SENT" ? "terkirim" : "ditolak"} | ${m.i.title.replace(/\s+/g, " ").slice(0, 110)} | XAU ${signed(biggest(m.i)!)}`)];
}

export function formatMissedReport(items: ShadowItem[], now: Date): string {
  const lines = rejectedButMoved(items, now, 24, 10);
  return lines.length ? `🔎 Berita yang ditolak tapi diikuti gerak emas ≥${NOTABLE_MOVE_PCT}% (24 jam):\n${lines.join("\n")}\nGerak harga bisa punya penyebab lain; tandai yang memang terlewat dengan /fn.`
    : "🔎 24 jam terakhir: tidak ada berita yang ditolak lalu diikuti gerak emas besar.";
}

export class ShadowOutcomeLedger {
  private items: ShadowItem[];
  constructor(private readonly path: string) { this.items = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ShadowItem[]) : []; }
  private save(): void { const tmp = `${this.path}.tmp`; writeFileSync(tmp, JSON.stringify(this.items), "utf8"); renameSync(tmp, this.path); }
  all(): ShadowItem[] { return this.items; }
  add(item: ShadowItem): void {
    if (this.items.some((x) => x.id === item.id)) return;
    this.items.push(item);
    const cutoff = Date.now() - 45 * 86400_000;
    this.items = this.items.filter((x) => Date.parse(x.at) >= cutoff).slice(-6000);
    this.save();
  }
  pending(now: Date): ShadowItem[] { return this.items.filter((i) => dueShadowMarks(i, now).length > 0); }
  update(item: ShadowItem): void { const i = this.items.findIndex((x) => x.id === item.id); if (i >= 0) { this.items[i] = item; this.save(); } }
}

export const REJECTED_OUTCOME_GUIDE = `REJECTED-NEWS MEMORY (evidence, never rules):
SIMILAR_PAST lists earlier headlines with similar wording (sent or rejected) and the XAU move measured within an hour after each. REJECTED_BUT_MOVED lists recent headlines the bot dismissed that were followed by a notable gold move. Use them to recognise when a type of headline that looks minor has repeatedly preceded real moves, and to stitch scattered small items into one storyline (for example several low-key Iran conditions that together shift the Hormuz picture). One case proves nothing: the move may have had another cause, so require a repeated pattern before it raises materiality, and say when the link is uncertain. Never invent past items or reactions that are not listed.`;
