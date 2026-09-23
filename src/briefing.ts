import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { CalendarEvent } from "./economic-calendar.js";

/**
 * Scheduled briefings (morning open + 21:00 WIB). Not news alerts: a desk-style
 * recap of what already happened and a guide to what is coming, in the owner's
 * voice. Never zones, levels, entries or trading instructions.
 */
export type BriefingKind = "PAGI" | "MALAM";
export type BriefingInput = {
  kind: BriefingKind; nowWib: string;
  sentAlerts: Array<{ at: string; theme: string; title: string }>;
  rejectedButMoved: string[];
  market: string;
  /** % change of the drivers over the recap window, identical to the images sent. */
  stats?: string;
  upcoming: Array<{ at: string; name: string; country: string; impact: string; consensus: string | null; prior: string | null; history?: string }>;
  /** Calendar releases of the last 24 hours that already have an actual figure. */
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

/** Morning: Mon–Sat (Saturday recaps Friday's NY). Evening: Mon–Fri. Window of 20 minutes after the set time. */
export function dueBriefing(now: Date, morning: string, evening: string, sentToday: Partial<Record<BriefingKind, string>>): BriefingKind | null {
  const j = jakarta(now);
  const inWindow = (clock: string) => j.minutes >= parseClock(clock) && j.minutes < parseClock(clock) + 20;
  if (j.weekday >= 1 && j.weekday <= 6 && inWindow(morning) && sentToday.PAGI !== j.day) return "PAGI";
  if (j.weekday >= 1 && j.weekday <= 5 && inWindow(evening) && sentToday.MALAM !== j.day) return "MALAM";
  return null;
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
  const scope = input.kind === "PAGI"
    ? "BRIEFING PAGI (open market Asia). Rangkum SEMUA berita yang sudah dibagikan ke grup dalam 24 jam terakhir, lalu analisa jadwal rilis 24 jam ke depan dari kalender."
    : "BRIEFING MALAM jam 21:00 WIB (menjelang sesi NY). Rangkum SEMUA berita yang sudah dibagikan ke grup dalam 24 jam terakhir, lalu analisa jadwal rilis 24 jam ke depan dari kalender, dengan fokus sesi NY malam ini.";
  return `${scope}
Tulis dalam format Telegram HTML sederhana (boleh <b> saja), maksimal sekitar 350 kata, dengan bagian:
1. Baris pembuka santai persis: "${input.kind === "PAGI" ? "☀️ Morning guys..." : "🌙 Evening guys..."}" lalu baris kedua tanggal: "${input.nowWib}". Jangan pakai kata "briefing" di teks.
2. "Yang udah kejadian": rangkum SEMUA alert terkirim dan data RELEASED di bawah, jangan ada yang dilewat, tapi kelompokkan per alur cerita (misal Fed/data AS, dolar-yield, Iran-minyak, dagang) jadi 3-6 poin. Tiap poin sebab-akibat ke XAU, bukan daftar judul. Untuk data yang sudah rilis, sebut aktual vs perkiraan dan artinya buat emas.
3. "Posisi sekarang": timbang DXY, yield, minyak, XAU dari data pasar yang diberikan; bilang timbangan condong ke mana, atau tabrakan. Kalau ada MACRO_LINKAGE, bilang emas lagi main logika rate atau logika bank sentral, dan kubu mana yang lagi menang di BATTLE.
4. "Yang perlu lo pantau": analisa jadwal dari daftar UPCOMING (jam WIB, 24 jam ke depan). Dahulukan dampak tinggi. Untuk tiap event penting sebut perkiraan dan sebelumnya bila ada, lalu jelaskan skenario buat emas kalau angkanya lebih tinggi atau lebih rendah dari perkiraan, dan kaitkan dengan alur cerita di atas (menguatkan atau membalik). Event dampak sedang cukup disebut singkat. Kalau ada catatan "historis" di jadwal, pakai itu buat bilang biasanya emas bereaksi gimana (sebut sebagai kebiasaan, bukan kepastian). Kalau daftar kosong, bilang terus terang gak ada rilis besar dan tema apa yang masih jalan.
5. Satu kalimat penutup: tema besar yang lagi nyetir emas.
Aturan keras: pakai hanya fakta di bawah, jangan ngarang angka, konsensus, atau kejadian. Tanpa zona, level harga, entry, target, stop-loss, atau ajakan beli/jual. Tanpa kata "pasti" atau "dijamin". Tanpa link, tanpa nama media, tanpa daftar sumber, dan jangan pernah menyebut "bot" atau "AI". Pakai gaya HITNRUN VOICE.

ALERT YANG SUDAH DIBAGIKAN KE GRUP 24 JAM TERAKHIR (lama→baru, ${input.sentAlerts.length} alert):
${input.sentAlerts.length ? input.sentAlerts.map((a) => `${wib(a.at)} WIB | ${a.theme} | ${a.title}`).join("\n") : "(tidak ada)"}

RELEASED (data kalender 24 jam terakhir yang sudah keluar):
${input.released?.length ? input.released.map((e) => `${e.at} | ${e.country} ${e.name} | aktual ${e.actual} | perkiraan ${e.consensus ?? "-"} | sebelumnya ${e.prior ?? "-"}`).join("\n") : "(tidak ada)"}

BERITA DITOLAK TAPI DIIKUTI GERAK EMAS:
${input.rejectedButMoved.length ? input.rejectedButMoved.join("\n") : "(tidak ada)"}

DATA PASAR SEKARANG: ${input.market || "(tidak tersedia; jangan menyebut angka pasar)"}
${input.stats ? `${input.stats}\nGambar statistik ikut dikirim di atas teks; boleh bilang "lihat chart di atas". Angka persen di teks harus sama dengan baris ini.` : ""}

UPCOMING (kalender 24 jam ke depan, jadwal WIB, dengan perkiraan/sebelumnya bila ada):
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
  let safe = escapeHtml(noTags).replace(/&lt;(\/?)b&gt;/g, "<$1b>");
  if ((safe.match(/<b>/g) ?? []).length !== (safe.match(/<\/b>/g) ?? []).length) safe = safe.replace(/<\/?b>/g, "");
  return { ok: true, text: safe };
}
export { escapeHtml };

export class BriefingLedger {
  private data: Partial<Record<BriefingKind, string>>;
  constructor(private readonly path: string) { this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}; }
  sent(): Partial<Record<BriefingKind, string>> { return this.data; }
  mark(kind: BriefingKind, day: string): void { this.data[kind] = day; const tmp = `${this.path}.tmp`; writeFileSync(tmp, JSON.stringify(this.data), "utf8"); renameSync(tmp, this.path); }
}
