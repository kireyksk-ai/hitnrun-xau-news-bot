/**
 * Catch-up digest for members who were away (owner request 2026-09-26): after a run of NEWS posts,
 * one short message lists them with their importance marker. Pure code, no AI call, no new claims:
 * every line is the headline that was already posted.
 */
export type SentNews = { sentAt: string; message: string };

const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
const wib = (iso: string) => new Date(Date.parse(iso) + 7 * 3600_000).toISOString().slice(11, 16);

/** The posts to summarise now, or null. Six posts, or three that have waited four hours. */
export function recapDue(sent: SentNews[], lastRecapAt: number, now: number, every = 6): SentNews[] | null {
  const fresh = sent.filter((s) => Date.parse(s.sentAt) > lastRecapAt).sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  if (fresh.length >= every) return fresh.slice(-10);
  if (fresh.length >= 3 && now - Date.parse(fresh[0].sentAt) >= 4 * 3_600_000) return fresh.slice(-10);
  return null;
}

export function formatRecap(items: SentNews[]): string {
  const lines = items.map((s) => {
    const title = plain(s.message.split("\n")[0]);
    const marker = title.match(/^(🔴|🟡|⚪|⚠️)/u)?.[1] ?? "•";
    const text = title.replace(/^(🔴|🟡|⚪|⚠️)\s*/u, "");
    return `${marker === "⚠️" ? "🟡" : marker} ${wib(s.sentAt)}  ${escape(text)}`;
  });
  const span = `${wib(items[0].sentAt)}–${wib(items[items.length - 1].sentAt)} WIB`;
  return [`📌 <b>Rangkuman buat yang ketinggalan</b>`, `<i>${items.length} berita terakhir, ${span}</i>`, lines.join("\n"),
    "🔴 paling ngaruh ke emas · 🟡 perlu tau · ⚪ update/konteks. Penjelasan lengkap tiap berita ada di atas."].join("\n\n");
}
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
