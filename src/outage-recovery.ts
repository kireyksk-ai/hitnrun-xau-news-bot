import type { ReviewRecord } from "./intelligence-store.js";

const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One bounded context note, never a replay of individual unjudged alerts. */
export function recoveryDigest(records: ReviewRecord[], lastDigestAt: number, now: number, currentId: string): string | null {
  const fresh = records.filter((r) => r.stage === "AI_CONTRACT_FAILURE" && r.id !== currentId &&
    Date.parse(r.event.firstSeenAt) > lastDigestAt && now - Date.parse(r.event.firstSeenAt) <= 45 * 60_000 &&
    now - new Date(r.article.publishedAt).getTime() <= 45 * 60_000)
    .sort((a, b) => b.event.firstSeenAt.localeCompare(a.event.firstSeenAt));
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const r of fresh) {
    if (seen.has(r.event.storyKey)) continue;
    seen.add(r.event.storyKey);
    titles.push(escapeHtml(r.article.title.replace(/\s+/g, " ").trim().slice(0, 150)));
    if (titles.length === 5) break;
  }
  if (!titles.length) return null;
  return [`<b>📌 RANGKAIAN BERITA TERBARU</b>`,
    "Saat penilaian API tertunda, beberapa headline baru sempat lewat. Ini konteks singkat, bukan alert lama yang dikirim ulang:",
    titles.map((title) => `• ${title}`).join("\n"),
    "Headline di atas belum dinilai sebagai katalis baru. Mulai sekarang bot kembali menilai berita yang baru masuk satu per satu."].join("\n\n");
}
