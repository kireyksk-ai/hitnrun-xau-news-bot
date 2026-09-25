import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fillActualsFromNasdaq } from "./calendar-nasdaq.js";
import { dirname } from "node:path";

export type CalendarEvent = {
  id: string; name: string; country: string; releaseAt: string;
  consensus: string | null; prior: string | null; actual: string | null;
  impact: "high" | "medium" | "low"; url: string;
};
type RawEvent = Record<string, unknown>;
export type Delivery = { warnedTo?: Record<string, number>; actualTo?: Record<string, number>; firstSeenForecast?: string | null; firstSeenPrior?: string | null; releaseAt?: string };

const text = (value: unknown): string | null => typeof value === "string" && value.trim() && value.trim() !== "-" ? value.trim() : null;
const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// The owner does not want the calendar source shown in the groups.

export function parseCalendarEvents(raw: unknown): CalendarEvent[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { events?: unknown }).events)) throw new Error("Invalid economic calendar response");
  const events = (raw as { events: RawEvent[] }).events;
  return events.flatMap((item) => {
    if (!item || !["high", "medium", "low"].includes(String(item.impact)) || item.all_day !== false) return [];
    const name = text(item.name), releaseAt = text(item.time_utc), url = text(item.url);
    if (!name || !releaseAt || !url || !/^https:\/\/www\.financecalendar\.com\/event\//.test(url)) return [];
    const date = new Date(releaseAt);
    if (Number.isNaN(date.getTime()) || !/(Z|[+-]\d\d:\d\d)$/.test(releaseAt)) return [];
    return [{ id: url, name, country: text(item.country) ?? "", releaseAt: date.toISOString(),
      consensus: text(item.consensus), prior: text(item.prior), actual: text(item.actual), impact: item.impact as CalendarEvent["impact"], url }];
  });
}

async function fetchFinanceCalendar(fetcher: typeof fetch, now: Date): Promise<CalendarEvent[]> {
  const from = new Date(now.getTime() - 3 * 86400000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 14 * 86400000).toISOString().slice(0, 10);
  const url = new URL("https://www.financecalendar.com/wp-json/fc/v1/calendar");
  url.searchParams.set("from", from); url.searchParams.set("to", to);
  url.searchParams.set("limit", "500");
  const response = await fetcher(url, { headers: { accept: "application/json", "user-agent": "HitnRun-XAU-Calendar/1.0" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Economic calendar HTTP ${response.status}`);
  return parseCalendarEvents(await response.json());
}

/** Common names so the owner playbook, backtest and wire matching recognise ForexFactory titles. */
const CANONICAL: Array<[RegExp, string]> = [
  [/^unemployment claims$/i, "Initial Jobless Claims"], [/^non-farm employment change$/i, "Nonfarm Payrolls"],
  [/^adp non-farm employment change$/i, "ADP Nonfarm Employment Change"], [/^federal funds rate$/i, "FOMC Federal Funds Rate"]
];
export function canonicalName(title: string): string { return CANONICAL.find(([re]) => re.test(title.trim()))?.[1] ?? title.trim(); }
/**
 * ForexFactory weekly JSON: complete schedule with clean currency codes and numeric forecasts
 * (e.g. claims "201K" instead of "around 235,000 to 240,000"). It has no actuals; those come
 * from the wires (calendar-actuals.ts) or from the secondary calendar when it has them.
 */
export function parseForexFactory(raw: unknown): CalendarEvent[] {
  if (!Array.isArray(raw)) throw new Error("Invalid ForexFactory calendar response");
  return (raw as RawEvent[]).flatMap((item) => {
    const impact = String(item.impact ?? "").toLowerCase();
    const title = text(item.title), country = text(item.country), date = text(item.date);
    if (!title || !country || !date || !["high", "medium", "low"].includes(impact)) return [];
    const at = new Date(date);
    if (Number.isNaN(at.getTime())) return [];
    const name = canonicalName(title);
    const slug = `${country}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return [{ id: `ff:${slug}:${at.toISOString()}`, name, country, releaseAt: at.toISOString(), consensus: text(item.forecast), prior: text(item.previous),
      actual: text(item.actual), impact: impact as CalendarEvent["impact"], url: `https://www.forexfactory.com/calendar#${slug}-${at.toISOString().slice(0, 10)}` }];
  });
}
let ffCache: { at: number; events: CalendarEvent[] } | null = null;
async function fetchForexFactory(fetcher: typeof fetch, now: Date): Promise<CalendarEvent[]> {
  // The feed updates hourly and rate-limits aggressive polling: at most one refresh every 10 minutes.
  if (ffCache && now.getTime() - ffCache.at < 10 * 60_000) return ffCache.events;
  const events: CalendarEvent[] = [];
  for (const week of ["thisweek", "nextweek"]) {
    try {
      const r = await fetcher(`https://nfs.faireconomy.media/ff_calendar_${week}.json`, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; HitnRun-XAU-Calendar/1.0)" }, signal: AbortSignal.timeout(15000) });
      if (r.ok) events.push(...parseForexFactory(await r.json()));
      else if (week === "thisweek") throw new Error(`ForexFactory HTTP ${r.status}`);
    } catch (error) { if (week === "thisweek") throw error; }
  }
  ffCache = { at: now.getTime(), events };
  return events;
}
const sameRelease = (a: CalendarEvent, b: CalendarEvent) => Math.abs(Date.parse(a.releaseAt) - Date.parse(b.releaseAt)) <= 5 * 60_000 && currencyOf(a) === currencyOf(b)
  && a.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3).some((w) => b.name.toLowerCase().includes(w));
/** ForexFactory first (complete schedule and forecasts); the secondary calendar only fills actuals, or takes over if FF is down. */
export async function fetchCalendarEvents(fetcher: typeof fetch = fetch, now = new Date()): Promise<CalendarEvent[]> {
  const [ff, fc] = await Promise.allSettled([fetchForexFactory(fetcher, now), fetchFinanceCalendar(fetcher, now)]);
  const primary = ff.status === "fulfilled" ? ff.value : [];
  const secondary = fc.status === "fulfilled" ? fc.value : [];
  if (!primary.length) { if (fc.status === "rejected" && ff.status === "rejected") throw ff.reason; return secondary; }
  const lo = now.getTime() - 3 * 86400_000, hi = now.getTime() + 14 * 86400_000;
  const merged = primary.filter((e) => Date.parse(e.releaseAt) >= lo && Date.parse(e.releaseAt) <= hi)
    .map((e) => e.actual ? e : { ...e, actual: secondary.find((x) => x.actual && sameRelease(e, x))?.actual ?? null });
  // Neither feed reliably carries the actual; Nasdaq's calendar does (see calendar-nasdaq.ts).
  return fillActualsFromNasdaq(merged, currencyOf, fetcher, now.getTime());
}

export function formatWib(releaseAt: string): string {
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(releaseAt)) + " WIB";
}

export function dueStage(event: CalendarEvent, nowMs: number, delivery: Delivery, destinations: string[] = []): "WARNING" | "ACTUAL" | null {
  const offset = nowMs - Date.parse(event.releaseAt);
  const pending = (sent: Record<string, number> | undefined) => destinations.length ? destinations.some((id) => !sent?.[id]) : !sent || !Object.keys(sent).length;
  // Never flood Telegram with historical results discovered only after deployment.
  // A result follows every release that was worth a warning, every high-impact one and every US medium-impact data print (owner wants e.g. Michigan sentiment),
  // while it is still fresh (6h), so a newly available actual source can never flood the group with old or low-impact prints.
  const warned = Boolean(delivery.warnedTo && Object.keys(delivery.warnedTo).length);
  if (delivery.releaseAt && offset >= 60000 && offset <= 6 * 3600000 && event.actual && (event.impact === "high" || warned || (event.impact === "medium" && currencyOf(event) === "USD")) && pending(delivery.actualTo)) return "ACTUAL";
  if (event.impact === "high" && offset >= -600000 && offset < 0 && pending(delivery.warnedTo)) return "WARNING";
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

export function formatCalendarMessage(event: CalendarEvent, stage: "WARNING" | "ACTUAL", explanation: { meaning: string; narrative: string }, saved: Delivery = {}, analysed = false): string {
  const label = `${escapeHtml(event.name)}${currencyOf(event) !== "USD" ? ` (${currencyOf(event)})` : ""}`;
  const stats = stage === "WARNING"
    ? `Forecast: ${escapeHtml(event.consensus ?? "belum tersedia")} | Sebelumnya: ${escapeHtml(event.prior ?? "belum tersedia")}`
    : `Actual: ${escapeHtml(event.actual ?? "belum tersedia")} | Forecast: ${escapeHtml((saved.firstSeenForecast !== undefined ? saved.firstSeenForecast : event.consensus) ?? "belum tersedia")} | Sebelumnya: ${escapeHtml((saved.firstSeenPrior !== undefined ? saved.firstSeenPrior : event.prior) ?? "belum tersedia")}`;
  // The alarm header is reserved for 3-star USD releases; everything else gets a calm header with its currency.
  const cur = currencyOf(event);
  const usdHigh = cur === "USD" && event.impact === "high";
  const stars = event.impact === "high" ? "⭐⭐⭐" : "⭐⭐";
  const where = countryTag(cur, event.country);
  // Country is always named right under/inside the header so members know at a glance whose data it is.
  const header = stage === "WARNING" ? (usdHigh ? `🚨 WARNING — U READY4 NEWSSSSS 🚨\n${where} — ${stars}` : `📅 RILIS ${where} — ${stars}`)
    : `📰 HASIL ${where}${event.impact === "high" ? " ⭐⭐⭐" : ""}`;
  const caution = stage === "WARNING" && !(currencyOf(event) === "USD" && event.impact === "high") ? ""
    : stage === "WARNING"
    ? "⚠️ PERSIAPAN: CLEAR POSISI UNTUK HINDARI RISIKO. Jangan judi menebak hasil rilis. Setelah angka keluar, lihat reaksi candle 15 menit pertama untuk mencari arah mata angin—gerakan pertama belum tentu arah yang bertahan."
    : analysed ? "" : "Reaksi awal pasar bisa berubah; arah emas belum terkonfirmasi hanya dari angka rilis.";
  return [`<b>${header}</b>`, `<b>${label}</b> — ${formatWib(event.releaseAt)}`, stats,
    escapeHtml(explanation.meaning), escapeHtml(explanation.narrative), caution].filter(Boolean).join("\n\n");
}


/** Scheduled talks have no figure; their "result" is what was said. */
export function isSpeech(e: Pick<CalendarEvent, "name" | "consensus" | "prior">): boolean {
  return !e.consensus && !e.prior && /\b(speaks|speech|testifies|testimony|press conference|remarks|statement)\b/i.test(e.name);
}
/** Surname to look for in headlines ("FOMC Member Williams Speaks" -> Williams). */
export function speakerOf(name: string): string | null {
  const direct = name.match(/([A-Z][a-zA-Z'\-]+)\s+(?:Speaks|Speech|Testifies|Testimony|Remarks)\b/);
  if (direct && !/^(Chair|Member|Governor|President|Gov|Speaks|Fed|FOMC|ECB|BOE|BOJ|Treasury)$/.test(direct[1])) return direct[1];
  if (/FOMC Press Conference|Fed Chair/i.test(name)) return "Powell";
  if (/ECB Press Conference|ECB President/i.test(name)) return "Lagarde";
  if (/BOE Gov|MPC.*Press/i.test(name)) return "Bailey";
  if (/BOJ Press Conference|BOJ Gov/i.test(name)) return "Ueda";
  return null;
}
const BANK: Record<string, string> = { USD: "Fed", EUR: "ECB", GBP: "BoE", JPY: "BoJ", CAD: "BoC", AUD: "RBA", NZD: "RBNZ", CHF: "SNB", CNY: "PBOC" };
/** Search words a newsroom would actually print: "Fed Schmid", not the calendar's "FOMC Member Schmid Speaks". */
export function huntQuery(event: CalendarEvent): { query: string; minutes: number; everySeconds: number } {
  const cur = currencyOf(event);
  if (isSpeech(event)) {
    const who = speakerOf(event.name);
    if (who) return { query: `${BANK[cur] ?? ""} ${who}`.trim(), minutes: 180, everySeconds: 120 };
  }
  const core = event.name.replace(/\b(m\/m|y\/y|q\/q|flash|prelim(?:inary)?|final|revised)\b/gi, " ").replace(/\s+/g, " ").trim();
  return { query: `"${core}"${cur === "USD" ? " US" : ""}`, minutes: 25, everySeconds: 60 };
}
/** Closing note when a warned speech produced no reported new line, so a warning is never left hanging. */
export function formatSpeechQuiet(event: CalendarEvent): string {
  const cur = currencyOf(event), where = countryTag(cur, event.country);
  return [`<b>📰 HASIL ${where}</b>`, `<b>${escapeHtml(event.name)}</b> — ${formatWib(event.releaseAt)}`,
    "Pidato sudah lewat dan sampai sekarang belum ada pernyataan baru soal suku bunga atau inflasi yang terlapor.",
    "Artinya pidato ini belum mengubah gambaran untuk emas; arah tetap mengikuti data dan berita utama berikutnya."].join("\n\n");
}
export function formatSpeechResult(event: CalendarEvent, explanation: { meaning: string; narrative: string }, headlines: number): string {
  const cur = currencyOf(event), where = countryTag(cur, event.country);
  return [`<b>📰 HASIL ${where}${event.impact === "high" ? " ⭐⭐⭐" : ""}</b>`, `<b>${escapeHtml(event.name)}</b> — ${formatWib(event.releaseAt)}`,
    `Ringkasan dari ${headlines} headline pidato`, escapeHtml(explanation.meaning), escapeHtml(explanation.narrative)].join("\n\n");
}

/** Institutional post-release note for US data: one message per release time, seven sections. */
export type DeepDive = { angka: string; kualitas: string; fed: string; transmisi: string; emas: string; risiko: string; berikutnya: string };
const numOf = (v: string | null | undefined): number | null => { if (!v) return null; const m = v.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
/** The numbers a desk reads first: actual vs the forecast seen before release, prior, and any revision of the prior. */
export function printFacts(event: CalendarEvent, saved: Delivery = {}): { name: string; actual: string | null; consensus: string | null; prior: string | null; revisedPrior: string | null; versus: "DI ATAS" | "DI BAWAH" | "SESUAI" | "N/A"; surprise: number | null } {
  const consensus = (saved.firstSeenForecast !== undefined ? saved.firstSeenForecast : event.consensus) ?? null;
  const prior = (saved.firstSeenPrior !== undefined ? saved.firstSeenPrior : event.prior) ?? null;
  const a = numOf(event.actual), c = numOf(consensus);
  const surprise = a !== null && c !== null ? +(a - c).toFixed(4) : null;
  const versus = surprise === null ? "N/A" : surprise > 0 ? "DI ATAS" : surprise < 0 ? "DI BAWAH" : "SESUAI";
  const revisedPrior = event.prior && prior && event.prior !== prior ? event.prior : null;
  return { name: event.name, actual: event.actual, consensus, prior, revisedPrior, versus, surprise };
}
const VERSUS_TEXT = { "DI ATAS": "di atas perkiraan", "DI BAWAH": "di bawah perkiraan", SESUAI: "sesuai perkiraan", "N/A": "" } as const;
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > max * 0.5 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}
export function formatCalendarDeep(items: Array<{ event: CalendarEvent; saved: Delivery }>, dive: DeepDive): string {
  const main = items[0].event;
  const high = items.some((i) => i.event.impact === "high");
  const prints = items.map(({ event, saved }) => {
    const f = printFacts(event, saved);
    const vs = VERSUS_TEXT[f.versus] ? ` → <b>${VERSUS_TEXT[f.versus]}</b>` : "";
    const rev = f.revisedPrior ? ` · data sebelumnya direvisi ${escapeHtml(f.prior ?? "")} → ${escapeHtml(f.revisedPrior)}` : "";
    return `• ${escapeHtml(f.name)}: <b>${escapeHtml(f.actual ?? "n/a")}</b> vs perkiraan ${escapeHtml(f.consensus ?? "n/a")} (sebelumnya ${escapeHtml(f.prior ?? "n/a")})${vs}${rev}`;
  }).join("\n");
  const sections: Array<[string, string]> = [
    ["📊 Angka vs ekspektasi", dive.angka], ["🔍 Kualitas dan detail data", dive.kualitas], ["🏦 Implikasi untuk The Fed", dive.fed],
    ["💵 Transmisi ke dolar dan yield", dive.transmisi], ["🥇 Dampak ke emas", dive.emas], ["⚠️ Yang bisa membalik", dive.risiko], ["📅 Yang dipantau berikutnya", dive.berikutnya]
  ];
  const head = [`<b>📰 HASIL ${countryTag("USD")}${high ? " ⭐⭐⭐" : ""}</b>`, `<b>Analisa lengkap rilis ${formatWib(main.releaseAt)}</b>`, prints];
  // Telegram caps a message at 4096 characters: shrink the longest sections first, never drop one.
  let budget = 3900 - head.join("\n\n").length - sections.reduce((n, [t]) => n + t.length + 12, 0);
  const texts = sections.map(([, body]) => escapeHtml(body.trim()));
  while (texts.reduce((n, t) => n + t.length, 0) > budget && budget > 0) {
    const i = texts.reduce((best, t, j) => t.length > texts[best].length ? j : best, 0);
    texts[i] = clip(texts[i], Math.floor(texts[i].length * 0.85));
  }
  return [...head, ...sections.map(([title], i) => `<b>${title}</b>\n${texts[i]}`)].join("\n\n");
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

/** Currency a release belongs to: country field first, then the name/URL (the feed often leaves country empty). */
const COUNTRY_TAG: Record<string, string> = { USD: "🇺🇸 AMERIKA SERIKAT (USD)", EUR: "🇪🇺 ZONA EURO (EUR)", GBP: "🇬🇧 INGGRIS (GBP)", JPY: "🇯🇵 JEPANG (JPY)",
  CNY: "🇨🇳 CHINA (CNY)", AUD: "🇦🇺 AUSTRALIA (AUD)", CAD: "🇨🇦 KANADA (CAD)", NZD: "🇳🇿 SELANDIA BARU (NZD)", CHF: "🇨🇭 SWISS (CHF)" };
/** Flag + country + currency, e.g. "🇦🇺 AUSTRALIA (AUD)". */
export function countryTag(currency: string, country = ""): string {
  return COUNTRY_TAG[currency] ?? `🌐 ${escapeHtml((country || "GLOBAL").toUpperCase())}`;
}

export function currencyOf(e: Pick<CalendarEvent, "country" | "name" | "url">): string {
  const c = (e.country || "").toUpperCase();
  if (/^(USD|EUR|GBP|JPY|CNY|AUD|CAD|NZD|CHF)$/.test(c)) return c;
  const byCountry: Record<string, string> = { US: "USD", USA: "USD", EU: "EUR", EZ: "EUR", EMU: "EUR", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", GB: "GBP", UK: "GBP", JP: "JPY", CN: "CNY", AU: "AUD", CA: "CAD", NZ: "NZD", CH: "CHF" };
  if (byCountry[c]) return byCountry[c];
  // The name decides first; the URL slug is only a fallback.
  const rules: Array<[RegExp, string]> = [
    [/australia|\brba\b/, "AUD"], [/new zealand|\brbnz\b/, "NZD"], [/canada|\bboc\b/, "CAD"], [/japan|\bboj\b|tokyo/, "JPY"], [/china|\bpboc\b|caixin/, "CNY"],
    [/united kingdom|\buk\b|britain|\bboe\b|bank of england/, "GBP"], [/switzerland|\bsnb\b/, "CHF"],
    [/euro|germany|german|france|french|italy|spain|\becb\b|\bifo\b|\bzew\b/, "EUR"],
    [/united states|united-states|\bus\b|\bu\.s\.|\bfed\b|fomc|nonfarm|non-farm|jobless|ism |michigan|jolts|pce|durable goods|new home sales|existing home|philly|empire state|treasury|adp/, "USD"]
  ];
  for (const text of [e.name.toLowerCase(), (e.url || "").toLowerCase().replace(/[-_/]/g, " ")]) for (const [re, cur] of rules) if (re.test(text)) return cur;
  return "OTHER";
}
/** How much a currency's own release can reach gold (XAUUSD). */
export function goldLinkNote(currency: string): string {
  const notes: Record<string, string> = {
    USD: "Data AS: langsung nyetir dolar, yield dan ekspektasi Fed, jadi dampaknya ke emas paling besar.",
    EUR: "Data zona euro: yang pertama kena EUR. EUR itu sekitar 58% dari DXY, jadi kejutan besar bisa geser dolar lalu emas (EUR menguat → DXY turun → emas kebantu). Dampak ke emas sedang.",
    JPY: "Data Jepang/BoJ: yang pertama kena JPY. Yen juga safe haven dan sekitar 14% dari DXY; kejutan BoJ bisa geser DXY dan selera risiko. Dampak ke emas sedang.",
    GBP: "Data Inggris/BoE: yang pertama kena GBP, sekitar 12% dari DXY. Dampak ke emas kecil sampai sedang.",
    CNY: "Data China/PBoC: jalurnya ke emas lewat permintaan fisik, pembelian emas PBoC dan selera risiko Asia, bukan lewat dolar.",
    AUD: "Data Australia: yang pertama kena AUD. AUD gak masuk hitungan DXY, jadi emas dunia (XAUUSD) hampir gak kegeser; yang kerasa harga emas dalam AUD (XAUAUD). Emas baru ikut kalau datanya ekstrem sampai ngubah selera risiko Asia.",
    CAD: "Data Kanada: yang pertama kena CAD (sekitar 9% DXY) dan terkait minyak. Dampak ke emas kecil.",
    NZD: "Data Selandia Baru: yang kena NZD, gak masuk DXY. Dampak ke emas kecil.",
    CHF: "Data Swiss/SNB: yang kena CHF, juga safe haven. Dampak ke emas kecil.",
    OTHER: "Bukan data AS: dampak ke emas biasanya kecil kecuali datanya ekstrem."
  };
  return notes[currency] ?? notes.OTHER;
}
