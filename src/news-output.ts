import type { NewsArticle } from "./types.js";

export type OutputCheck = { ok: true } | { ok: false; reason: string };

function plain(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/&(?:amp|lt|gt|quot|#\d+);/gi, " ").replace(/\s+/g, " ").trim();
}
function normalized(text: string): string {
  return plain(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function copiesSource(message: string, article: NewsArticle): boolean {
  const output = normalized(message);
  for (const source of [article.title, article.summary]) {
    const words = normalized(source).split(" ").filter(Boolean);
    if (words.length < 8) continue;
    for (let start = 0; start <= words.length - 8; start++) {
      const phrase = words.slice(start, start + 8).join(" ");
      if (phrase.length >= 45 && output.includes(phrase)) return true;
    }
  }
  return false;
}

/** Last code-level NEWS gate: no model response or fallback bypasses this. */
export function validateNewsOutput(message: string, article: NewsArticle): OutputCheck {
  const blocks = message.trim().split(/\n\s*\n/).map((block) => plain(block));
  if (blocks.length !== 3 || !blocks[0].startsWith("⚠️ ")) return { ok: false, reason: "NEWS must have title, new fact and gold impact in three blocks" };
  const visible = blocks.join(" ");
  const wordCount = visible.split(/\s+/).filter(Boolean).length;
  if (wordCount < 35 || wordCount > 190 || message.length > 1500) return { ok: false, reason: `NEWS length ${wordCount} words outside safe range` };
  if (/\b(importance|urgency|new_information|source scoring|reasoning internal|score\s*\d+\s*\/\s*100|level dampak|bias dampak)\b/i.test(visible)) {
    return { ok: false, reason: "Internal metadata leaked into NEWS" };
  }
  if (/https?:\/\/|www\.|\b(?:Reuters|Bloomberg|Politico|Truth Social)\s*[:—-]/i.test(visible)) return { ok: false, reason: "Raw source attribution or link in NEWS" };
  if (copiesSource(message, article)) return { ok: false, reason: "NEWS copies source text" };
  const idWords = visible.match(/\b(apa|baru|terjadi|trump|mengatakan|terbuka|bertemu|pertemuan|dengan|ini|karena|jalur|diplomasi|buat|emas|risiko|perang|bisa|kalau|hanya|tanpa|belum|jelas|dampak|pasar|suku|bunga|harga|naik|turun|tekanan|menjadi|akan|sementara|tetap|sehingga|terhadap|dari|pada|yang|dan|di|ke|untuk|sebagai|masih|lebih|dapat|sedang|setelah|sebelum|jika|namun|tetapi)\b/gi) ?? [];
  const enWords = visible.match(/\b(the|and|said|says|will|would|could|has|have|after|before|against|between|according|announced|announces|meeting|president|government|market|shipping|threat|attack|policy)\b/gi) ?? [];
  if (idWords.length < 8 || idWords.length <= enWords.length * 2) return { ok: false, reason: "NEWS is not predominantly Indonesian" };
  if (!/\b(emas|xau)\b/i.test(blocks[2])) return { ok: false, reason: "Gold impact paragraph missing" };
  return { ok: true };
}

