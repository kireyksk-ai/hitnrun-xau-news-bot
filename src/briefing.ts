import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { CalendarEvent } from "./economic-calendar.js";
import { readable } from "./news-output.js";

/**
 * Scheduled briefings, one per trading session (Asia, Europe, US). Not news alerts:
 * a desk-style recap of what happened since the previous session and a guide to what
 * is coming, in the owner's voice. Never zones, levels, entries or trading instructions.
 */
export type BriefingKind = "ASIA" | "EROPA" | "US";
export const SESSION: Record<BriefingKind, { label: string; opener: string; upcomingHours: number; words: number }> = {
  ASIA: { label: "Sesi Asia", opener: "☀️ Morning guys...", upcomingHours: 24, words: 350 },
  EROPA: { label: "Sesi Eropa", opener: "🌤️ Afternoon guys...", upcomingHours: 8, words: 280 },
  US: { label: "Sesi US", opener: "🌙 Evening guys...", upcomingHours: 14, words: 300 }
};
export type BriefingSchedule = { asiaWib: string; europeLondon: string; usNewYork: string };
export type BriefingInput = {
  kind: BriefingKind; nowWib: string;
  /** Hours covered by the recap (since the previous session). */
  recapHours?: number;
  sentAlerts: Array<{ at: string; theme: string; title: string }>;
  rejectedButMoved: string[];
  market: string;
  /** % change of the drivers over the recap window, identical to the images sent. */
  stats?: string;
  upcoming: Array<{ at: string; name: string; country: string; impact: string; consensus: string | null; prior: string | null; history?: string }>;
  /** Calendar releases of the recap window that already have an actual figure. */
  released?: Array<{ at: string; name: string; country: string; actual: string; consensus: string | null; prior: string | null }>;
};

const wib = (iso: string) => new Date(Date.parse(iso) + 7 * 3600_000).toISOString().replace("T", " ").slice(5, 16);
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Jakarta clock parts for scheduling. */
export function jakarta(date = new Date()): { day: string; weekday: number; minutes: number; label: string } {
  const shifted = new Date(date.getTime() + 7 * 3600_000);
  const hari = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"][shifted.getUTCDay()];
  const bulan = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"][shifted.getUTCMonth()];
  return { day: shifted.toISOString().slice(0, 10), weekday: shifted.getUTCDay(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    label: `${hari}, ${shifted.getUTCDate()} ${bulan} ${shifted.getUTCFullYear()}` };
}
export function parseClock(value: string): number { const [h, m] = value.split(":").map(Number); return (h || 0) * 60 + (m || 0); }

/** Offset (ms) of an IANA zone from UTC at a given instant. */
function zoneOffset(ms: number, timeZone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
/** UTC instant of a local wall-clock time on a given calendar day (YYYY-MM-DD) in a zone. DST-aware. */
export function zonedTime(day: string, clock: string, timeZone: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(parseClock(clock) / 60), parseClock(clock) % 60);
  const first = guess - zoneOffset(guess, timeZone);
  return guess - zoneOffset(first, timeZone);
}
/**
 * Session slots for a Jakarta day. Asia at a fixed WIB time; Europe before the London open and US
 * before the 08:30 New York data, both in local time so they follow daylight saving automatically.
 */
export function sessionSlots(day: string, schedule: BriefingSchedule): Record<BriefingKind, number> {
  return { ASIA: zonedTime(day, schedule.asiaWib, "Asia/Jakarta"), EROPA: zonedTime(day, schedule.europeLondon, "Europe/London"), US: zonedTime(day, schedule.usNewYork, "America/New_York") };
}
/** Asia: Mon–Sat (Saturday recaps Friday's NY). Europe and US: Mon–Fri. Window of 20 minutes after each slot. */
export function dueBriefing(now: Date, schedule: BriefingSchedule, sentToday: Partial<Record<string, string>>): BriefingKind | null {
  const j = jakarta(now);
  const slots = sessionSlots(j.day, schedule);
  const open = (kind: BriefingKind) => now.getTime() >= slots[kind] && now.getTime() < slots[kind] + 20 * 60_000 && sentToday[kind] !== j.day;
  if (j.weekday >= 1 && j.weekday <= 6 && open("ASIA")) return "ASIA";
  if (j.weekday >= 1 && j.weekday <= 5 && open("EROPA")) return "EROPA";
  if (j.weekday >= 1 && j.weekday <= 5 && open("US")) return "US";
  return null;
}
/** Recap window start: the previous session's slot (Asia looks back to the last US session, skipping the weekend). */
export function recapSince(kind: BriefingKind, now: Date, schedule: BriefingSchedule): number {
  const j = jakarta(now);
  if (kind === "EROPA") return sessionSlots(j.day, schedule).ASIA;
  if (kind === "US") return sessionSlots(j.day, schedule).EROPA;
  const back = j.weekday === 1 ? 3 : j.weekday === 0 ? 2 : 1;
  const prev = jakarta(new Date(now.getTime() - back * 86400_000)).day;
  return sessionSlots(prev, schedule).US;
}

export function upcomingEvents(events: CalendarEvent[], now: Date, hours: number): BriefingInput["upcoming"] {
  const end = now.getTime() + hours * 3600_000;
  return events.filter((e) => (e.impact === "high" || e.impact === "medium") && Date.parse(e.releaseAt) > now.getTime() && Date.parse(e.releaseAt) <= end)
    .sort((a, b) => a.releaseAt.localeCompare(b.releaseAt)).slice(0, 20)
    .map((e) => ({ at: `${wib(e.releaseAt)} WIB`, name: e.name, country: e.country, impact: e.impact, consensus: e.consensus, prior: e.prior }));
}

/** High/medium releases of the past window that already printed, for the recap. */
export function releasedEvents(events: CalendarEvent[], now: Date, hours: number): NonNullable<BriefingInput["released"]> {
  const start = now.getTime() - hours * 3600_000;
  return events.filter((e) => (e.impact === "high" || e.impact === "medium") && e.actual && Date.parse(e.releaseAt) >= start && Date.parse(e.releaseAt) <= now.getTime())
    .sort((a, b) => a.releaseAt.localeCompare(b.releaseAt)).slice(-20)
    .map((e) => ({ at: `${wib(e.releaseAt)} WIB`, name: e.name, country: e.country, actual: e.actual!, consensus: e.consensus, prior: e.prior }));
}

export function briefingPrompt(input: BriefingInput): string {
  const s = SESSION[input.kind];
  const span = input.recapHours ? `dalam ${input.recapHours} jam terakhir` : "sejak sesi sebelumnya";
  const scope = input.kind === "ASIA"
    ? `PEMBUKAAN SESI ASIA. Rangkum SEMUA berita yang sudah dibagikan ke grup ${span} (sejak sesi US kemarin, termasuk penutupan New York). Fokus sesi ini: data China, Jepang, Australia, permintaan fisik dan PBoC, lalu gambaran jadwal rilis 24 jam ke depan.`
    : input.kind === "EROPA"
    ? `MENJELANG LONDON OPEN (SESI EROPA). Rangkum SEMUA berita yang sudah dibagikan ke grup ${span} (selama sesi Asia) dan bagaimana emas bergerak di Asia. Fokus sesi ini: data zona euro dan Inggris, ECB/BoE, arus London, lalu jadwal rilis sampai sesi US.`
    : `MENJELANG SESI US (sebelum data AS dan New York open). Rangkum SEMUA berita yang sudah dibagikan ke grup ${span} (selama sesi Eropa) dan bagaimana emas bergerak di London. Fokus sesi ini: data AS, pembicara Fed, lelang Treasury, lalu jadwal rilis sesi New York malam ini.`;
  return `${scope}
Tulis dalam format Telegram HTML sederhana (boleh <b> saja), maksimal sekitar ${s.words} kata, dengan bagian:
1. Baris pembuka santai persis: "${s.opener}" lalu baris kedua: "${s.label} — ${input.nowWib}". Jangan pakai kata "briefing" di teks.
2. "Yang udah kejadian": rangkum SEMUA alert terkirim dan data RELEASED di bawah, jangan ada yang dilewat, tapi kelompokkan per alur cerita (misal Fed/data AS, dolar-yield, Iran-minyak, dagang) jadi 3-6 poin. Tiap poin sebab-akibat ke XAU, bukan daftar judul. Untuk data yang sudah rilis, sebut aktual vs perkiraan dan artinya buat emas.
3. "Posisi sekarang": timbang DXY, yield, minyak, XAU dari data pasar yang diberikan; bilang timbangan condong ke mana, atau tabrakan. Kalau ada MACRO_LINKAGE, bilang emas lagi main logika rate atau logika bank sentral, dan kubu mana yang lagi menang di BATTLE.
4. "Yang perlu lo pantau": analisa jadwal dari daftar UPCOMING (jam WIB, ${s.upcomingHours} jam ke depan), dahulukan yang jatuh di ${s.label.toLowerCase()}. Dahulukan dampak tinggi. Untuk tiap event penting sebut perkiraan dan sebelumnya bila ada, lalu jelaskan skenario buat emas kalau angkanya lebih tinggi atau lebih rendah dari perkiraan, dan kaitkan dengan alur cerita di atas (menguatkan atau membalik). Event dampak sedang cukup disebut singkat. Kalau ada catatan "historis" di jadwal, pakai itu buat bilang biasanya emas bereaksi gimana (sebut sebagai kebiasaan, bukan kepastian). Kalau daftar kosong, bilang terus terang gak ada rilis besar dan tema apa yang masih jalan.
5. Satu kalimat penutup: tema besar yang lagi nyetir emas.
Aturan keras: pakai hanya fakta di bawah, jangan ngarang angka, konsensus, atau kejadian. Tanpa zona, level harga, entry, target, stop-loss, atau ajakan beli/jual. Tanpa kata "pasti" atau "dijamin". Tanpa link, tanpa nama media, tanpa daftar sumber, dan jangan pernah menyebut "bot" atau "AI". Pakai gaya HITNRUN VOICE.

ALERT YANG SUDAH DIBAGIKAN KE GRUP ${span.toUpperCase()} (lama→baru, ${input.sentAlerts.length} alert):
${input.sentAlerts.length ? input.sentAlerts.map((a) => `${wib(a.at)} WIB | ${a.theme} | ${a.title}`).join("\n") : "(tidak ada)"}

RELEASED (data kalender ${span} yang sudah keluar):
${input.released?.length ? input.released.map((e) => `${e.at} | ${e.country} ${e.name} | aktual ${e.actual} | perkiraan ${e.consensus ?? "-"} | sebelumnya ${e.prior ?? "-"}`).join("\n") : "(tidak ada)"}

BERITA DITOLAK TAPI DIIKUTI GERAK EMAS:
${input.rejectedButMoved.length ? input.rejectedButMoved.join("\n") : "(tidak ada)"}

DATA PASAR SEKARANG: ${input.market || "(tidak tersedia; jangan menyebut angka pasar)"}
${input.stats ? `${input.stats}\nGambar statistik ikut dikirim di atas teks; boleh bilang "lihat chart di atas". Angka persen di teks harus sama dengan baris ini.` : ""}

UPCOMING (kalender ${s.upcomingHours} jam ke depan, jadwal WIB, dengan perkiraan/sebelumnya bila ada):
${input.upcoming.length ? input.upcoming.map((e) => `${e.at} | ${e.country} ${e.name} | dampak ${e.impact} | perkiraan ${e.consensus ?? "-"} | sebelumnya ${e.prior ?? "-"}${e.history ? ` | ${e.history}` : ""}`).join("\n") : "(tidak ada rilis penting dalam jendela ini)"}`;
}

/** Last gate before a briefing reaches the group. Output is safe Telegram HTML (only <b> survives). */
export function validateBriefing(text: string): { ok: true; text: string } | { ok: false; reason: string } {
  const noTags = text.trim().replace(/```[a-z]*\n?|```/gi, "").replace(/<(?!\/?b>)\/?[a-z][^>]*>/gi, "");
  const visible = noTags.replace(/<\/?b>/g, "");
  const words = visible.split(/\s+/).filter(Boolean).length;
  if (words < 60 || words > 420 || visible.length > 3800) return { ok: false, reason: `briefing length ${words} words` };
  if (/https?:\/\/|www\./i.test(visible)) return { ok: false, reason: "link in briefing" };
  if (/\b(sources?|sumber\s*:|bot|AI)\b/.test(visible) || /\b(sources?|sumber\s*:)/i.test(visible)) return { ok: false, reason: "source list or bot/AI mention in briefing" };
  if (/\b(entry|stop ?loss|take profit|zona (?:buy|sell)|buy di|sell di|target harga|pasti naik|pasti turun|dijamin)\b/i.test(visible) || /\b(TP|SL)\b/.test(visible)) return { ok: false, reason: "trading instruction or guarantee in briefing" };
  if (!/\b(emas|gold|xau)\b/i.test(visible)) return { ok: false, reason: "briefing does not discuss gold" };
  // Escape everything, then restore <b> only when balanced, so Telegram HTML parsing never fails.
  let safe = escapeHtml(readable(noTags)).replace(/&lt;(\/?)b&gt;/g, "<$1b>");
  if ((safe.match(/<b>/g) ?? []).length !== (safe.match(/<\/b>/g) ?? []).length) safe = safe.replace(/<\/?b>/g, "");
  return { ok: true, text: safe };
}
export { escapeHtml };

export class BriefingLedger {
  private data: Partial<Record<string, string>>;
  constructor(private readonly path: string) { this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}; }
  sent(): Partial<Record<string, string>> { return this.data; }
  mark(kind: BriefingKind, day: string): void { this.data[kind] = day; const tmp = `${this.path}.tmp`; writeFileSync(tmp, JSON.stringify(this.data), "utf8"); renameSync(tmp, this.path); }
}
