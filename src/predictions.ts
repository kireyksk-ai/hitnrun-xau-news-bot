import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Prediction ledger. Every NEWS alert that carries a gold "potential direction"
 * is recorded with the XAU price at send time and scored automatically later.
 * This is measurement only: it never sends trading zones, entries or orders.
 */
export type Direction = "BULLISH" | "BEARISH" | "TWO_WAY" | "UNCLEAR";
export const MARK_MINUTES = [15, 60, 240, 1440] as const;
export type MarkMinutes = (typeof MARK_MINUTES)[number];
export type Mark = { at: string; price: number; returnPct: number; result: "HIT" | "MISS" | "FLAT" | "NOT_SCORED" };
export type Prediction = {
  id: string; eventId: string; storyKey: string; title: string; createdAt: string;
  direction: Direction; confidence: number; horizonMinutes: MarkMinutes;
  entryPrice?: number; entrySource: string;
  marks: Partial<Record<`${MarkMinutes}`, Mark>>;
};
/** A move smaller than this is noise, not a confirmation or a miss. */
export const FLAT_THRESHOLD_PCT = 0.1;

export function judge(direction: Direction, returnPct: number): Mark["result"] {
  if (direction === "TWO_WAY" || direction === "UNCLEAR") return "NOT_SCORED";
  if (Math.abs(returnPct) < FLAT_THRESHOLD_PCT) return "FLAT";
  return (direction === "BULLISH") === (returnPct > 0) ? "HIT" : "MISS";
}

export function dueMarks(prediction: Prediction, now: Date): MarkMinutes[] {
  if (prediction.entryPrice === undefined) return [];
  const created = Date.parse(prediction.createdAt);
  // A mark is taken once, within a 30-minute window; stale marks are skipped so a
  // restart never scores a 15-minute call with a price from hours later.
  return MARK_MINUTES.filter((minutes) => {
    if (prediction.marks[`${minutes}`]) return false;
    const due = created + minutes * 60_000;
    return now.getTime() >= due && now.getTime() - due <= 30 * 60_000;
  });
}

export function applyMark(prediction: Prediction, minutes: MarkMinutes, price: number, now: Date): Prediction {
  if (prediction.entryPrice === undefined || !(price > 0)) return prediction;
  const returnPct = (price - prediction.entryPrice) / prediction.entryPrice * 100;
  return { ...prediction, marks: { ...prediction.marks, [`${minutes}`]: { at: now.toISOString(), price, returnPct, result: judge(prediction.direction, returnPct) } } };
}

type Tally = { hit: number; miss: number; flat: number };
const rate = (t: Tally) => t.hit + t.miss ? t.hit / (t.hit + t.miss) : null;
const pct = (value: number | null) => value === null ? "–" : `${Math.round(value * 100)}%`;

export type Scorecard = {
  alerts: number; directional: number;
  byMark: Record<`${MarkMinutes}`, Tally>;
  atHorizon: Tally;
  calibration: Array<{ band: string; calls: number; hitRate: number | null }>;
  byStory: Array<{ storyKey: string; calls: number; hitRate: number | null }>;
};

export function scorecard(predictions: Prediction[], sinceMs: number): Scorecard {
  const window = predictions.filter((item) => Date.parse(item.createdAt) >= sinceMs);
  const directional = window.filter((item) => item.direction === "BULLISH" || item.direction === "BEARISH");
  const empty = (): Tally => ({ hit: 0, miss: 0, flat: 0 });
  const add = (tally: Tally, mark?: Mark) => { if (mark?.result === "HIT") tally.hit++; else if (mark?.result === "MISS") tally.miss++; else if (mark?.result === "FLAT") tally.flat++; };
  const byMark = Object.fromEntries(MARK_MINUTES.map((m) => [`${m}`, empty()])) as Scorecard["byMark"];
  const atHorizon = empty();
  const bands = [{ band: "50–64%", lo: 0, hi: 65 }, { band: "65–79%", lo: 65, hi: 80 }, { band: "80%+", lo: 80, hi: 101 }].map((b) => ({ ...b, tally: empty(), calls: 0 }));
  const stories = new Map<string, Tally & { calls: number }>();
  for (const item of directional) {
    for (const m of MARK_MINUTES) add(byMark[`${m}`], item.marks[`${m}`]);
    const final = item.marks[`${item.horizonMinutes}`];
    add(atHorizon, final);
    const band = bands.find((b) => item.confidence >= b.lo && item.confidence < b.hi);
    if (band) { band.calls++; add(band.tally, final); }
    const story = stories.get(item.storyKey) ?? { ...empty(), calls: 0 };
    story.calls++; add(story, final); stories.set(item.storyKey, story);
  }
  return {
    alerts: window.length, directional: directional.length, byMark, atHorizon,
    calibration: bands.map((b) => ({ band: b.band, calls: b.calls, hitRate: rate(b.tally) })),
    byStory: [...stories].map(([storyKey, t]) => ({ storyKey, calls: t.calls, hitRate: rate(t) })).sort((a, b) => b.calls - a.calls).slice(0, 5)
  };
}

const markLabel: Record<`${MarkMinutes}`, string> = { "15": "15 menit", "60": "1 jam", "240": "4 jam", "1440": "24 jam" };

export function formatScorecard(card: Scorecard, periodLabel: string): string {
  const lines = [`📊 Rapor akurasi potensi arah emas (${periodLabel})`,
    `Alert: ${card.alerts} | Dengan arah jelas: ${card.directional}`];
  const scored = card.atHorizon.hit + card.atHorizon.miss;
  if (!card.directional || !scored) return [...lines, "Belum cukup data yang sudah dinilai."].join("\n");
  lines.push(`Tepat di horizon yang disebut: ${pct(rate(card.atHorizon))} (${card.atHorizon.hit} tepat, ${card.atHorizon.miss} meleset, ${card.atHorizon.flat} datar)`);
  lines.push(MARK_MINUTES.map((m) => `${markLabel[`${m}`]} ${pct(rate(card.byMark[`${m}`]))}`).join(" · "));
  lines.push(`Kalibrasi keyakinan: ${card.calibration.filter((b) => b.calls).map((b) => `${b.band} → ${pct(b.hitRate)} (${b.calls})`).join(" · ") || "–"}`);
  if (card.byStory.length) lines.push(`Per tema: ${card.byStory.map((s) => `${s.storyKey} ${pct(s.hitRate)} (${s.calls})`).join(" · ")}`);
  lines.push(`Datar = gerak < ${FLAT_THRESHOLD_PCT}%, tidak dihitung tepat/meleset. Ini potensi arah, bukan sinyal trading.`);
  return lines.join("\n");
}

export class PredictionLedger {
  private items: Prediction[];
  constructor(private readonly path: string) {
    this.items = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Prediction[]) : [];
  }
  private save(): void { const tmp = `${this.path}.tmp`; writeFileSync(tmp, JSON.stringify(this.items), "utf8"); renameSync(tmp, this.path); }
  all(): Prediction[] { return this.items; }
  add(item: Prediction): void {
    if (this.items.some((x) => x.id === item.id)) return;
    this.items.push(item);
    if (this.items.length > 3000) this.items = this.items.slice(-3000);
    this.save();
  }
  update(item: Prediction): void { const i = this.items.findIndex((x) => x.id === item.id); if (i >= 0) { this.items[i] = item; this.save(); } }
  pending(now: Date): Prediction[] { return this.items.filter((item) => dueMarks(item, now).length > 0); }
}
