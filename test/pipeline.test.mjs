import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceStore } from "../dist/intelligence-store.js";
import { processArticle } from "../dist/pipeline.js";
import { validateNewsOutput } from "../dist/news-output.js";

const news = "<b>⚠️ DIPLOMASI IRAN BERUBAH</b>\n\nTrump membuka peluang pertemuan langsung dengan Presiden Iran. Ini merupakan perkembangan baru karena jalur diplomasi resmi kini kembali dibicarakan di tengah konflik yang masih berlangsung.\n\nBuat emas, dampaknya belum otomatis bearish. Jika pertemuan benar menurunkan risiko perang dan tekanan minyak, premi safe haven dapat berkurang; tanpa tindak lanjut, arah emas belum jelas.";

function setup(primary, shadow, sourceName = "Reuters") {
  const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "xau-intel-")), "state.json"));
  const deliveries = [];
  const deps = { store, analyze: async () => primary, shadow: async () => shadow,
    deliver: async (message) => { deliveries.push(message); return { chat: 12 }; },
    now: () => new Date("2026-09-22T00:01:00Z") };
  const article = (title, summary = "") => ({ provider: "test", providerId: title, title, summary,
    url: "https://example.test", publishedAt: new Date("2026-09-22T00:00:00Z"), sourceName });
  return { deps, deliveries, article };
}

test("material Trump-Iran event is sent even without XAU keyword", async () => {
  const { deps, deliveries, article } = setup({ material: true, reason: "Diplomacy changes conflict path", telegramMessage: news }, { material: true, score: 90, reason: "new" });
  const result = await processArticle(article("Trump says he is open to meeting Iran's president"), deps);
  assert.equal(result.stage, "SENT"); assert.equal(deliveries.length, 1);
});

test("minor oil item is dropped even when AI would call it relevant", async () => {
  const { deps, deliveries, article } = setup({ material: true, reason: "oil", telegramMessage: news }, { material: true, score: 90, reason: "oil" });
  const result = await processArticle(article("Minor disruption at local oil storage site", "Routine maintenance; no change to supply."), deps);
  assert.equal(result.primaryDecision, "DROP"); assert.equal(deliveries.length, 0);
});

test("AI vetoes headline-only Trump/Fed repetition", async () => {
  const { deps, deliveries, article } = setup({ material: false, reason: "repeat", telegramMessage: null }, { material: false, score: 10, reason: "repeat" });
  const result = await processArticle(article("Trump announces he repeats his previous Fed rate view"), deps);
  assert.notEqual(result.stage, "SENT"); assert.equal(deliveries.length, 0);
});

test("tier-three single source is held for corroboration", async () => {
  const { deps, deliveries, article } = setup({ material: true, reason: "new", telegramMessage: news }, { material: true, score: 95, reason: "new" }, "Unverified Blog");
  const result = await processArticle(article("Iran announces Hormuz shipping shutdown"), deps);
  assert.equal(result.stage, "SOURCE"); assert.equal(deliveries.length, 0);
});

test("later Reuters corroboration can release a held tier-three event", async () => {
  const { deps, deliveries, article } = setup({ material: true, reason: "new", telegramMessage: news }, { material: true, score: 95, reason: "new" }, "Unverified Blog");
  const title = "Iran announces Hormuz shipping shutdown";
  const held = await processArticle(article(title), deps);
  const wire = { ...article(title), sourceName: "Reuters", provider: "wire" };
  const sent = await processArticle(wire, deps);
  assert.equal(held.stage, "SOURCE"); assert.equal(sent.stage, "SENT"); assert.equal(deliveries.length, 1);
});

test("safe mode queues the exact message for replay", async () => {
  const { deps, deliveries, article } = setup({ material: true, reason: "new", telegramMessage: news }, { material: true, score: 90, reason: "new" });
  deps.store.setSafeMode(true);
  const result = await processArticle(article("Iran announces Hormuz shipping shutdown"), deps);
  assert.equal(result.stage, "ROUTING"); assert.equal(result.renderedMessage, news); assert.equal(deliveries.length, 0);
});

test("identical Trump post is deduped before a second AI call", async () => {
  const { deps, deliveries, article } = setup({ material: true, reason: "new", telegramMessage: news }, { material: true, score: 90, reason: "new" });
  let calls = 0;
  deps.analyze = async () => { calls++; return { material: true, reason: "new", telegramMessage: news }; };
  const post = { ...article("Donald Trump — Truth Social", "Trump announces new tariffs on Chinese imports"),
    provider: "truth-social-trump", providerId: "12345", postId: "12345", author: "Donald Trump", url: "https://truthsocial.com/@realDonaldTrump/posts/12345" };
  const first = await processArticle(post, deps);
  const second = await processArticle({ ...post, providerId: "mirror-12345" }, deps);
  assert.equal(first.stage, "SENT"); assert.equal(second.primaryDecision, "DROP");
  assert.equal(calls, 1); assert.equal(deliveries.length, 1);
});

test("same storyline reversal remains a separate update", async () => {
  const { deps, deliveries, article } = setup({ material: true, reason: "new", telegramMessage: news }, { material: true, score: 90, reason: "new" });
  const first = await processArticle(article("Trump says he is open to meeting Iran's president"), deps);
  const reversal = await processArticle(article("Iran rejects proposed meeting with Trump"), deps);
  assert.equal(first.stage, "SENT"); assert.equal(reversal.stage, "SENT");
  assert.equal(deliveries.length, 2);
});

test("raw English source is never valid NEWS", () => {
  const input = { provider: "test", providerId: "raw", title: "Trump announces tariffs", summary: "Donald Trump wrote that he will impose a new tariff on Chinese imports after meeting officials at the White House.", url: "https://example.test", sourceName: "Reuters", publishedAt: new Date("2026-09-22T00:00:00Z") };
  const result = validateNewsOutput(`<b>⚠️ Trump announces tariffs</b>\n\n${input.summary}\n\nThis could affect gold.`, input);
  assert.equal(result.ok, false);
});

test("formatter failure is held and cannot reach NEWS", async () => {
  const { deps, deliveries, article } = setup({ material: true, reason: "formatter failed", telegramMessage: null }, { material: true, score: 90, reason: "new" });
  const result = await processArticle(article("Trump announces new tariffs on Chinese imports"), deps);
  assert.equal(result.stage, "FORMAT"); assert.equal(result.primaryDecision, "REVIEW"); assert.equal(deliveries.length, 0);
});

