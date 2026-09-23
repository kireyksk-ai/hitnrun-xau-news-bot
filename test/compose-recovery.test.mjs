import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceStore } from "../dist/intelligence-store.js";
import { processArticle } from "../dist/pipeline.js";
import { sourceTier } from "../dist/event-intelligence.js";

const barr = { provider: "benzinga", providerId: "barr-1", sourceName: "Benzinga", url: "https://example.test/barr",
  title: "Fed's Barr Says Further Rate Hikes Likely Needed To Ensure Timely Return To 2% Inflation",
  summary: "Fed Governor Michael Barr says further rate hikes will likely be needed.", publishedAt: new Date("2026-09-23T14:08:00Z") };
const prose = "<b>⚠️ Barr: kenaikan suku bunga lanjutan kemungkinan dibutuhkan</b>\n\nGubernur Fed Michael Barr menilai kenaikan suku bunga lanjutan kemungkinan diperlukan agar inflasi kembali ke 2% tepat waktu.\n\nNada hawkish ini menekan emas lewat ekspektasi yield dan dolar yang lebih tinggi.";

function deps(primary, shadow, compose, sent) {
  const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "xau-compose-")), "state.json"));
  return { store, analyze: async () => primary, shadow: async () => shadow, compose,
    deliver: async (message) => { sent.push(message); return { chat: 1 }; } };
}

test("shadow-approved event without primary prose is composed and sent instead of held", async () => {
  const sent = [];
  const result = await processArticle(barr, deps(
    { material: false, confidence: "medium", reason: "primary unsure", telegramMessage: null },
    { material: true, score: 90, reason: "Fed governor signals more hikes" },
    async () => prose, sent));
  assert.equal(result.stage, "SENT");
  assert.equal(sent.length, 1);
});

test("without compose the old safe hold is preserved", async () => {
  const sent = [];
  const result = await processArticle(barr, deps(
    { material: false, confidence: "medium", reason: "primary unsure", telegramMessage: null },
    { material: true, score: 90, reason: "Fed governor signals more hikes" }, undefined, sent));
  assert.equal(result.stage, "FORMAT");
  assert.equal(sent.length, 0);
});

test("compose failure keeps the hold and never sends raw text", async () => {
  const sent = [];
  const result = await processArticle(barr, deps(
    { material: true, confidence: "high", reason: "material", telegramMessage: null },
    { material: true, score: 90, reason: "material" }, async () => { throw new Error("down"); }, sent));
  assert.equal(result.stage, "FORMAT");
  assert.equal(sent.length, 0);
});

test("compose is not called when nothing approved publishing", async () => {
  let called = false; const sent = [];
  const result = await processArticle(barr, deps(
    { material: false, confidence: "high", reason: "repeat", telegramMessage: null },
    { material: false, score: 20, reason: "repeat" }, async () => { called = true; return prose; }, sent));
  assert.equal(result.primaryDecision, "DROP");
  assert.equal(called, false);
});

test("mainstream financial publishers are tier 2, social aggregators stay tier 3", () => {
  for (const name of ["CNBC", "The Wall Street Journal", "WSJ", "MarketWatch", "Barron's", "Nikkei Asia", "S&P Global"])
    assert.equal(sourceTier({ provider: "google-news-rss", sourceName: name, url: "https://x.test" }), 2, name);
  for (const name of ["ZeroHedge", "The Lufkin Daily News", "Google News RSS"])
    assert.equal(sourceTier({ provider: "google-news-rss", sourceName: name, url: "https://x.test" }), 3, name);
});
