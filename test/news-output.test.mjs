import assert from "node:assert/strict";
import test from "node:test";
import { validateNewsOutput } from "../dist/news-output.js";

const finalNews = "<b>⚠️ KEBIJAKAN TARIF AS BERUBAH</b>\n\nPemerintah AS mengumumkan tarif baru atas impor China. Perubahan ini menjadi informasi baru karena berpotensi mengubah perhitungan inflasi dan pertumbuhan, bukan sekadar mengulang ancaman lama.\n\nBuat emas, tarif dapat menaikkan tekanan inflasi sekaligus menekan ekspektasi pertumbuhan. Dampaknya ke yield dan dolar bisa saling tarik-menarik, jadi arah emas belum jelas sampai respons pasar terhadap kebijakan ini lebih terbentuk.";
const sources = [
  ["Reuters", "US President announces a new tariff on Chinese imports after White House meeting."],
  ["Truth Social", "Donald Trump wrote: I will impose a new tariff on Chinese imports effective immediately."],
  ["Federal Reserve", "Federal Reserve Chair said the committee is prepared to keep rates restrictive if inflation remains elevated."],
];

for (const [sourceName, summary] of sources) test(`English ${sourceName} input produces valid Indonesian NEWS`, () => {
  const article = { provider: "test", providerId: sourceName, sourceName, title: "English source headline", summary,
    url: "https://example.test", publishedAt: new Date("2026-09-22T00:00:00Z") };
  assert.deepEqual(validateNewsOutput(finalNews, article), { ok: true });
  assert.ok(!finalNews.includes(summary));
});

test("metadata and raw long quote are blocked before routing", () => {
  const article = { provider: "test", providerId: "post", sourceName: "Truth Social", title: "Trump post",
    summary: "Donald Trump wrote a long original English statement about tariffs, China and a planned meeting at the White House.", url: "https://example.test", publishedAt: new Date() };
  const unsafe = "<b>⚠️ Donald Trump — Truth Social</b>\n\nImportance 100/100 NEW_INFORMATION\n\nDonald Trump wrote a long original English statement about tariffs, China and a planned meeting at the White House.";
  assert.equal(validateNewsOutput(unsafe, article).ok, false);
});

