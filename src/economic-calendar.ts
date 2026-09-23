import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type CalendarEvent = {
  id: string; name: string; country: string; releaseAt: string;
  consensus: string | null; prior: string | null; actual: string | null;
  impact: "high"; url: string;
};
type RawEvent = Record<string, unknown>;
export type Delivery = { warnedTo?: Record<string, number>; actualTo?: Record<string, number>; firstSeenForecast?: string | null; firstSeenPrior?: string | null; releaseAt?: string };

const text = (value: unknown): string | null => typeof value === "string" && value.trim() && value.trim() !== "-" ? value.trim() : null;
const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const source = '<a href="https://www.financecalendar.com">Sumber kalender: Finance Calendar</a>';

export function parseCalendarEvents(raw: unknown): CalendarEvent[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { events?: unknown }).events)) throw new Error("Invalid economic calendar response");
  const events = (raw as { events: RawEvent[] }).events;
  return events.flatMap((item) => {
    if (!item || item.impact !== "high" || item.all_day !== false) return [];
    const name = text(item.name), releaseAt = text(item.time_utc), url = text(item.url);
    if (!name || !releaseAt || !url || !/^https:\/\/www\.financecalendar\.com\/event\//.test(url)) return [];
    const date = new Date(releaseAt);
    if (Number.isNaN(date.getTime()) || !/(Z|[+-]\d\d:\d\d)$/.test(releaseAt)) return [];
    return [{ id: url, name, country: text(item.country) ?? "", releaseAt: date.toISOString(),
      consensus: text(item.consensus), prior: text(item.prior), actual: text(item.actual), impact: "high" as const, url }];
  });
}

export async function fetchCalendarEvents(fetcher: typeof fetch = fetch, now = new Date()): Promise<CalendarEvent[]> {
  const from = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 14 * 86400000).toISOString().slice(0, 10);
  const url = new URL("https://www.financecalendar.com/wp-json/fc/v1/calendar");
  url.searchParams.set("from", from); url.searchParams.set("to", to);
  url.searchParams.set("impact", "high"); url.searchParams.set("limit", "500");
  const response = await fetcher(url, { headers: { accept: "application/json", "user-agent": "HitnRun-XAU-Calendar/1.0" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Economic calendar HTTP ${response.status}`);
  return parseCalendarEvents(await response.json());
}

export function formatWib(releaseAt: string): string {
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(releaseAt)) + " WIB";
}

export function dueStage(event: CalendarEvent, nowMs: number, delivery: Delivery, destinations: string[] = []): "WARNING" | "ACTUAL" | null {
  const offset = nowMs - Date.parse(event.releaseAt);
  const pending = (sent: Record<string, number> | undefined) => destinations.length ? destinations.some((id) => !sent?.[id]) : !sent || !Object.keys(sent).length;
  if (offset >= 60000 && offset <= 6 * 3600000 && event.actual && pending(delivery.actualTo)) return "ACTUAL";
  if (offset >= -600000 && offset < -480000 && pending(delivery.warnedTo)) return "WARNING";
  return null;
}

export function compareActual(actual: string | null, consensus: string | null): string {
  if (!actual || !consensus) return "Perbandingan dengan konsensus belum dapat dihitung.";
  const parse = (value: string): number | null => {
    const match = value.replace(/,/g, "").replace(/^(US\$|C\$|A\$|\$|€|£)/, "").match(/^([+-]?\d+(?:\.\d+)?)(%|K|M|B|T)?$/i);
    if (!match) return null;
    const scale: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
    return Number(match[1]) * (scale[(match[2] ?? "").toUpperCase()] ?? 1);
  };
  if (actual.endsWith("%") !== consensus.endsWith("%")) return "Satuan actual dan konsensus berbeda; surprise belum dapat dihitung.";
  const a = parse(actual), c = parse(consensus);
  if (a === null || c === null) return "Perbandingan numerik belum dapat dihitung.";
  return a > c ? "Actual di atas konsensus." : a < c ? "Actual di bawah konsensus." : "Actual sesuai konsensus.";
}

export function calendarNarrative(event: CalendarEvent, stage: "WARNING" | "ACTUAL", marketContext: string, saved: Delivery = {}): { meaning: string; narrative: string } {
  const subject = event.name.toLowerCase();
  const kind = /cpi|pce|ppi|inflation|price index/.test(subject) ? "inflation"
    : /payroll|employment|unemployment|jobless|labour|labor/.test(subject) ? "labor"
    : /rate decision|interest rate|fomc|monetary policy/.test(subject) ? "policy"
    : /gdp|pmi|retail sales|industrial production/.test(subject) ? "growth" : "other";
  const meaning = kind === "inflation" ? "Rilis ini mengukur tekanan harga; selisih terhadap perkiraan dapat mengubah ekspektasi suku bunga dan yield."
    : kind === "labor" ? "Rilis ini membaca kekuatan pasar kerja; selisih dari perkiraan dapat memengaruhi pandangan atas pertumbuhan dan arah suku bunga."
    : kind === "policy" ? "Keputusan atau komunikasi bank sentral ini dapat mengubah ekspektasi jalur suku bunga dan nilai mata uang."
    : kind === "growth" ? "Rilis ini memberi petunjuk tentang laju kegiatan ekonomi; dampaknya ke emas bergantung pada respons suku bunga, dolar, dan selera risiko."
    : "Rilis ini berpotensi mengubah ekspektasi pasar. Dampaknya ke emas perlu ditimbang melalui dolar, yield, dan sentimen risiko.";
  const dxy = marketContext.match(/DXY (naik|turun|datar)/)?.[1];
  const yield10 = marketContext.match(/US10Y (naik|turun|datar)/)?.[1];
  const sentiment = dxy === "naik" && yield10 === "naik" ? "Dolar dan yield sedang sama-sama naik, sehingga jalur suku bunga menjadi penahan bagi emas."
    : dxy === "turun" && yield10 === "turun" ? "Dolar dan yield sedang sama-sama turun, sehingga tekanan suku bunga terhadap emas cenderung mereda."
    : dxy && yield10 ? "Dolar dan yield belum memberi sinyal yang searah, sehingga narasi emas masih campuran."
    : "Pembacaan dolar dan yield belum cukup untuk mengonfirmasi arah emas.";
  const context = marketContext ? ` ${sentiment} Konteks aset saat pengecekan: ${marketContext}. Ini bukan bukti reaksi khusus terhadap rilis.` : ` ${sentiment}`;
  if (stage === "WARNING") return { meaning, narrative: `Forecast masih merupakan perkiraan, bukan hasil. Jika hasil mengejutkan, DXY dan yield bisa mengubah respons emas; arahnya belum pasti sebelum angka aktual muncul.${context}` };
  const consensus = saved.firstSeenForecast !== undefined ? saved.firstSeenForecast : event.consensus;
  const comparison = compareActual(event.actual, consensus);
  const channel = kind === "inflation" ? "Inflasi yang lebih kuat dapat menopang ekspektasi suku bunga/yield, tetapi permintaan lindung nilai dapat menjadi penyeimbang."
    : kind === "labor" ? "Pasar kerja yang lebih kuat dapat memengaruhi ekspektasi Fed dan dolar; pelemahan data bisa membawa risiko pertumbuhan."
    : kind === "policy" ? "Arah emas tidak hanya ditentukan keputusan suku bunga, tetapi juga panduan kebijakan dan perubahan ekspektasi pasar."
    : "Dampak ke emas dapat saling berlawanan melalui pertumbuhan, dolar, yield, dan sentimen risiko.";
  return { meaning: `Hasil ${event.name} telah terbit. ${comparison}`, narrative: `${channel}${context}` };
}

export function formatCalendarMessage(event: CalendarEvent, stage: "WARNING" | "ACTUAL", explanation: { meaning: string; narrative: string }, saved: Delivery = {}): string {
  const label = escapeHtml(event.name);
  const stats = stage === "WARNING"
    ? `Forecast: ${escapeHtml(event.consensus ?? "belum tersedia")} | Sebelumnya: ${escapeHtml(event.prior ?? "belum tersedia")}`
    : `Actual: ${escapeHtml(event.actual ?? "belum tersedia")} | Forecast: ${escapeHtml((saved.firstSeenForecast !== undefined ? saved.firstSeenForecast : event.consensus) ?? "belum tersedia")} | Sebelumnya: ${escapeHtml((saved.firstSeenPrior !== undefined ? saved.firstSeenPrior : event.prior) ?? "belum tersedia")}`;
  const header = stage === "WARNING" ? "🚨 WARNING — U READY4 NEWSSSSS 🚨" : "🚨 HASIL NEWS 3 BINTANG 🚨";
  const caution = stage === "WARNING"
    ? "⚠️ PERSIAPAN: CLEAR POSISI UNTUK HINDARI RISIKO. Jangan judi menebak hasil rilis. Setelah angka keluar, lihat reaksi candle 15 menit pertama untuk mencari arah mata angin—gerakan pertama belum tentu arah yang bertahan."
    : "Reaksi awal pasar bisa berubah; arah emas belum terkonfirmasi hanya dari angka rilis.";
  return [`<b>${header}</b>`, `<b>${label}</b> — ${formatWib(event.releaseAt)}`, stats,
    escapeHtml(explanation.meaning), escapeHtml(explanation.narrative), caution, source].join("\n\n");
}

export class CalendarLedger {
  private data: Record<string, Delivery>;
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, Delivery> : {};
  }
  get(id: string): Delivery { return this.data[id] ?? {}; }
  observe(event: CalendarEvent, nowMs: number): void {
    if (nowMs >= Date.parse(event.releaseAt)) return;
    const item = this.data[event.id] ??= {};
    item.releaseAt = event.releaseAt;
    if (item.firstSeenForecast === undefined) item.firstSeenForecast = event.consensus;
    if (item.firstSeenPrior === undefined) item.firstSeenPrior = event.prior;
    // A later genuine consensus update before release supersedes the early snapshot.
    if (event.consensus) item.firstSeenForecast = event.consensus;
    if (event.prior) item.firstSeenPrior = event.prior;
    this.save();
  }
  mark(id: string, stage: "WARNING" | "ACTUAL", accepted: Record<string, number>): void {
    const item = this.data[id] ??= {};
    const field = stage === "WARNING" ? "warnedTo" : "actualTo";
    item[field] = { ...item[field], ...accepted };
    this.save();
  }
  prune(nowMs: number): void {
    for (const id of Object.keys(this.data)) {
      const releaseAt = this.data[id].releaseAt;
      if (releaseAt && Date.parse(releaseAt) < nowMs - 30 * 86400000) delete this.data[id];
    }
    this.save();
  }
  private save(): void { const temp = `${this.path}.tmp`; writeFileSync(temp, JSON.stringify(this.data), "utf8"); renameSync(temp, this.path); }
}
