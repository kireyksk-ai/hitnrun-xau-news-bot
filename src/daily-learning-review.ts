import type { IntelligenceStore } from "./intelligence-store.js";

/** Evidence-only daily reflection. No model call, rule mutation, or trade route. */
export function formatDailyLearningReview(store: IntelligenceStore, now = new Date()): string {
  const since = now.getTime() - 24 * 60 * 60 * 1000;
  const records = store.records().filter(record => Date.parse(String(record.sentAt ?? record.article.publishedAt)) >= since);
  const sent = records.filter(record => record.stage === "SENT").length;
  const falseNegatives = records.filter(record => record.adminDecision === "FALSE_NEGATIVE").length;
  const falsePositives = records.filter(record => record.adminDecision === "FALSE_POSITIVE").length;
  const completed = store.checkpoints().filter(item => item.status === "COMPLETED" && Date.parse(item.completedAt ?? "") >= since);
  const q = store.quantitative();
  const directional = q.scorecards.filter(card => card.direction && Number.isFinite(card.xauReturn) && Date.parse(card.evaluatedAt ?? "") >= since);
  const hits = directional.filter(card => Math.sign(card.xauReturn!) === (card.direction === "UP" ? 1 : -1)).length;
  const accuracy = directional.length ? `${Math.round(100 * hits / directional.length)}% (${hits}/${directional.length})` : "BELUM TERUKUR (prediksi arah berlabel belum tersedia)";
  const validated = q.relationships.filter(item => item.state === "VALIDATED" && item.pointInTimeIntegrity === "VERIFIED").slice(-3);
  const lessons = validated.length
    ? validated.map(item => `${item.feature}–XAU ${item.sign?.toLowerCase() ?? "belum jelas"} pada ${item.horizon}; ${item.sampleSize} sampel (bukti statistik, bukan aturan trading).`)
    : ["Belum ada pola lintas-aset dengan sampel dan validasi memadai."];
  const lines = [
    `REFLEKSI BELAJAR — ${now.toISOString().slice(0, 10)} (baca-saja)`,
    `Alert 24 jam: ${sent}; evaluasi harga selesai: ${completed.length}; akurasi arah: ${accuracy}`,
    `Umpan balik kesalahan/false negative: ${falseNegatives}; false positive: ${falsePositives}. Tanpa umpan balik, penyebab salah belum dapat dipastikan.`,
    "Pelajaran tervalidasi:", ...lessons.map((lesson, index) => `${index + 1}. ${lesson}`),
    "Kekuatan/kelemahan kategori dan bias bullish/bearish: BELUM TERUKUR tanpa prediksi arah berlabel yang cukup.",
    "Aturan produksi yang diubah otomatis: 0. Usulan aturan baru harus diuji dan ditinjau sebelum aktif.",
    "Prediksi besok: TIDAK DIBUAT tanpa konteks pasar segar dan model terkalibrasi. Phase 5/trading: OFF."
  ];
  return lines.join("\n");
}
