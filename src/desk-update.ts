/**
 * Desk update ("🧭 UPDATE XAU"), owner request 2026-10-01: single headlines are judged one by one and many
 * important shifts never pass as a single alert (10Y at a 24-year high, DXY at a 3-month high while Fed-hike
 * odds fall, diesel tightness spreading from Russia to China, a Fed official moving the neutral rate...).
 * Every few hours one AI call reads EVERYTHING fetched since the last note (sent or not), the live market
 * readings and the official remarks, and writes a short regime update only when something really changed.
 * Pure helpers here; scheduling and delivery live in index.ts.
 */
import { benzingaTopicHits } from "./providers/benzinga-wire.js";

const DESK_TOPICS = /\b(refiner\w*|fuel|diesel|gasoline|jet fuel|yields?|treasur\w+|bonds?|tankan|payrolls?|adp|jobs|inflation|rate hike|rate cut|neutral rate|chinese|japan\w*|boj|hormuz|tankers?|export ban)\b/i;

/** WIB hours at which a desk update may go out on weekdays. */
export const DESK_SLOTS_WIB = [9, 12, 15, 18, 21, 24];

/** The slot (WIB hour) that is due now, or null. Weekdays only; a slot is open for 20 minutes. */
export function dueDeskSlot(now: Date, sentSlots: Set<string>): string | null {
  const w = new Date(now.getTime() + 7 * 3_600_000);
  const day = w.getUTCDay(), minutes = w.getUTCHours() * 60 + w.getUTCMinutes();
  for (const h of DESK_SLOTS_WIB) {
    // 24:00 belongs to the WIB day that is ending, so Friday 24:00 runs (Saturday 00:00) and Monday 00:00 does not.
    const slotDay = h === 24 ? (day + 6) % 7 : day, slotMin = (h % 24) * 60;
    if (slotDay < 1 || slotDay > 5) continue;
    if (minutes < slotMin || minutes >= slotMin + 20) continue;
    const key = `${w.toISOString().slice(0, 10)}T${String(h % 24).padStart(2, "0")}`;
    if (!sentSlots.has(key)) return key;
  }
  return null;
}

/** Distinct market-relevant headlines since `sinceMs`, newest first (wire prefixes stripped, near-duplicates merged). */
export function deskHeadlines(items: Array<{ title?: string; publishedAt?: string; fetchedAt?: string }>, sinceMs: number, max = 60): string[] {
  const seen = new Set<string>(), out: string[] = [];
  const rows = items.map((i) => ({ title: (i.title ?? "").replace(/^@\w+:\s*/, "").replace(/\s+-\s+[A-Z][\w .]+$/, "").replace(/\s+/g, " ").trim(), t: Date.parse(String(i.publishedAt ?? i.fetchedAt ?? "")) }))
    .filter((r) => r.title.length > 15 && r.t >= sinceMs && (benzingaTopicHits(r.title).length > 0 || DESK_TOPICS.test(r.title))).sort((a, b) => b.t - a.t);
  for (const r of rows) {
    const key = r.title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3).sort().slice(0, 6).join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${new Date(r.t + 7 * 3_600_000).toISOString().slice(11, 16)} WIB ${r.title.slice(0, 180)}`);
    if (out.length >= max) break;
  }
  return out;
}

export function deskPrompt(input: { nowWib: string; headlines: string[]; market: string; remarks: string; sentAlerts: string[]; lastUpdate: string }): string {
  return [
    `TUGAS: UPDATE XAU desk (${input.nowWib}). Lo baca SEMUA headline yang masuk beberapa jam terakhir, termasuk yang tidak dikirim sebagai alert, lalu cari APA YANG BERUBAH di peta pasar emas: rezim yield (2Y vs 10Y/30Y), dolar, minyak vs produk olahan (diesel), Fed (siapa bilang apa, odds), bank sentral lain, geopolitik (Iran/Hormuz/Rusia), data.`,
    `Kalau dibanding UPDATE TERAKHIR tidak ada perubahan berarti, jawab PERSIS: TIDAK_ADA_UPDATE`,
    `Kalau ada: tulis satu post Telegram, 130-230 kata, baris pertama persis "🧭 UPDATE XAU" lalu satu judul pendek. Isi: 1) apa yang baru dan kenapa penting (gabungkan beberapa headline jadi satu cerita), 2) rantai ke emas lewat yield/dolar/minyak/safe haven, sebut kalau dua mesin tabrakan dan mana yang lagi menang, 3) satu kalimat apa yang dipantau berikutnya. Jangan ulang hal yang sudah ada di ALERT TERKIRIM kecuali ada sambungan baru. Tanpa level harga/zona/entry/target, tanpa BUY/SELL, tanpa nama media, tanpa link, tanpa kata bot atau AI. Fakta hanya dari input ini.`,
    `PASAR SEKARANG: ${input.market || "(tidak tersedia)"}`,
    input.remarks,
    `ALERT TERKIRIM (sudah dibaca member):\n${input.sentAlerts.map((t) => `- ${t}`).join("\n") || "(kosong)"}`,
    `HEADLINE MASUK (baru ke lama):\n${input.headlines.map((t) => `- ${t}`).join("\n")}`,
    `UPDATE TERAKHIR:\n${input.lastUpdate || "(belum ada)"}`
  ].filter(Boolean).join("\n\n");
}

/** Checks the model output; returns the text to post or null. */
export function deskOutput(text: string): string | null {
  const t = text.trim();
  if (!t || /TIDAK_ADA_UPDATE/.test(t) || !t.startsWith("🧭 UPDATE XAU")) return null;
  const words = t.split(/\s+/).length;
  if (words < 60 || words > 320 || t.length > 3000) return null;
  if (/https?:\/\/|www\.|\b(?:BUY|SELL)\b|\bentry\b|stop ?loss|take profit|\bbot\b|Reuters|Bloomberg|\$\s?\d{1,2},?\d{3}(?:\.\d+)?\b/i.test(t)) return null;
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/^🧭 UPDATE XAU/, "<b>🧭 UPDATE XAU</b>");
}
