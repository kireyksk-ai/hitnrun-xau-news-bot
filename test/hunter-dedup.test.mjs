import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NewsHunter, followUpQuery, abnormalMove } from "../dist/brain-hunter.js";
import { clearBrainMarketCache } from "../dist/brain-market.js";
import { sentDuplicate, processArticle } from "../dist/pipeline.js";
import { assessEvent } from "../dist/event-intelligence.js";
import { validateNewsOutput } from "../dist/news-output.js";
import { IntelligenceStore } from "../dist/intelligence-store.js";

const rss = (items) => `<rss><channel>${items.map((t, i) => `<item><title>${t}</title><link>https://x.test/${i}</link><pubDate>${new Date().toUTCString()}</pubDate><source>Reuters</source></item>`).join("")}</channel></rss>`;

test("hunter chases queued targets on schedule and expires them", async () => {
  const asked = [];
  const h = new NewsHunter(30, 3, async (url) => { asked.push(String(url)); return { ok: true, text: async () => rss(["Gold jumps as dollar slides"]) }; });
  h.hunt("follow-1", "Barr hikes inflation", "lanjutan", 120, 300);
  h.hunt("follow-1", "Barr hikes inflation", "lanjutan", 180, 300);
  assert.equal(h.active().length, 1, "same key is extended, not duplicated");
  const found = await h.fetchLatest(new Date(Date.now() - 3600_000));
  assert.equal(found[0].provider, "news-hunter"); assert.equal(found[0].sourceName, "Reuters");
  assert.match(asked[0], /when%3A1h/);
  assert.equal((await h.fetchLatest(new Date(0))).length, 0, "not re-run before its interval");
  h.hunt("old", "x y", "r", -1, 60); assert.ok(!h.active().some((t) => t.key === "old"));
  assert.equal(followUpQuery("@DeItaone: FED'S BARR SIGNALS MORE RATE HIKES AHEAD"), "barr signals rate hikes");
});

test("abnormal gold move is detected with the assets that moved with it", async () => {
  const M = 60_000, now = Date.now();
  const fetcher = async (url) => { const sym = decodeURIComponent(new URL(String(url)).pathname.split("/").pop()); const bars = [];
    for (let t = now - 200 * M; t <= now; t += M) { const late = t > now - 15 * M; bars.push([t, sym === "GC=F" ? (late ? 4300 + (t - (now - 15 * M)) / M * 2 : 4300 + (t / M % 2) * 0.3) : sym === "DX-Y.NYB" ? (late ? 100 - 0.3 : 100) : 4.2]); }
    return { ok: true, json: async () => ({ chart: { result: [{ timestamp: bars.map((b) => Math.floor(b[0] / 1000)), indicators: { quote: [{ close: bars.map((b) => b[1]) }] } }] } }) }; };
  clearBrainMarketCache();
  const m = await abnormalMove(now, fetcher);
  assert.ok(m.xau > 0.5); assert.deepEqual(m.drivers, ["dollar"]);
  clearBrainMarketCache();
});

const article = (title, summary = "") => ({ provider: "t", providerId: title, title, summary, url: "https://x.test", publishedAt: new Date(), sourceName: "Reuters" });
test("a fact already published in the last 12h is never sent again; a denial still is", () => {
  const now = new Date();
  const sent = { id: "a1", stage: "SENT", sentAt: new Date(now.getTime() - 3600_000).toISOString(), renderedMessage: "x",
    article: article("Iran says Strait of Hormuz will be closed to US-linked tankers"), event: assessEvent(article("Iran says Strait of Hormuz will be closed to US-linked tankers")) };
  const echo = assessEvent(article("Strait of Hormuz to be closed to US-linked tankers, Iran says"));
  assert.ok(sentDuplicate(echo, "y", [sent], now), "same fact, different wire and wording");
  const other = assessEvent(article("Fed's Barr says more hikes likely"));
  assert.equal(sentDuplicate(other, "y", [sent], now), undefined);
  const denial = { ...echo, changeType: "DENIAL" };
  assert.equal(sentDuplicate(denial, "y", [sent], now), undefined);
});

test("gold impact must reason cause→effect; one rewrite is attempted before holding", async () => {
  const good = "<b>⚠️ Barr Hawkish Lagi</b>\n\nBarr bilang kenaikan bunga lanjutan kemungkinan masih dibutuhkan karena inflasi belum turun ke target, dan pasar kerja masih kuat.\n\nIntinya ekspektasi Fed naik lagi, makanya yield sama dolar ikut naik dan emas ketekan dari dua sisi selama data belum melemah.";
  const verdict = "<b>⚠️ Barr Hawkish Lagi</b>\n\nBarr bilang kenaikan bunga lanjutan kemungkinan masih dibutuhkan untuk inflasi yang belum turun ke target, pasar kerja juga masih kuat.\n\nPokoknya emas turun ya guys, fix bearish, siap-siap aja semua pantau terus ya teman teman semua.";
  const a = article("Fed's Barr says further hikes likely");
  assert.equal(validateNewsOutput(good, a).ok, true);
  assert.match(validateNewsOutput(verdict, a).reason, /cause-effect/);
  const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "ce-")), "s.json"));
  const sent = []; let composed = 0;
  const deps = { store, analyze: async () => ({ material: true, confidence: "high", reason: "hawkish", telegramMessage: verdict }), shadow: async () => ({ material: false, score: 0, reason: "" }),
    compose: async () => { composed++; return { message: good }; }, deliver: async (m) => { sent.push(m); return { c: 1 }; } };
  const r = await processArticle(a, deps);
  assert.equal(r.stage, "SENT"); assert.equal(composed, 1); assert.equal(sent[0], good);
});

test("timid alerts get one conviction rewrite; if it is not better the original still goes out", async () => {
  const { hedgeScore } = await import("../dist/news-output.js");
  const timid = "<b>⚠️ Barr Soal Bunga</b>\n\nBarr bilang kenaikan bunga lanjutan berpotensi masih dibutuhkan karena inflasi belum turun ke target, tapi semuanya tergantung data berikutnya.\n\nBuat emas dampaknya belum jelas karena bisa jadi yield naik tapi mungkin juga dolar ketahan, jadi arah emas masih perlu dipantau dulu sampai data keluar.";
  const bold = "<b>⚠️ Barr Nambahin Bensin Hawkish</b>\n\nBarr bilang kenaikan bunga lanjutan kemungkinan masih dibutuhkan karena inflasi belum turun ke target, dan pasar kerja masih kuat.\n\nEmas condong ketekan. Intinya ekspektasi Fed naik lagi, makanya yield sama dolar ikut naik dan emas kena dari dua sisi; yang bisa ngebalik cuma data tenaga kerja yang tiba-tiba lemah.";
  assert.equal(hedgeScore(timid).timid, true); assert.equal(hedgeScore(bold).timid, false);
  const a = article("Fed's Barr says further hikes may be needed");
  for (const [rewrite, expected] of [[bold, bold], [timid, timid]]) {
    const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "bold-")), "s.json"));
    const sent = [];
    const deps = { store, analyze: async () => ({ material: true, confidence: "high", reason: "hawkish", telegramMessage: timid }), shadow: async () => ({ material: false, score: 0, reason: "" }),
      compose: async () => ({ message: rewrite }), deliver: async (m) => { sent.push(m); return { c: 1 }; } };
    const r = await processArticle(a, deps);
    assert.equal(r.stage, "SENT"); assert.equal(sent[0], expected);
  }
});

test("readable() expands chat shorthand; calendar result echo is caught; opening with 'belum jelas' is timid", async () => {
  const { readable, hedgeScore } = await import("../dist/news-output.js");
  const { calendarEcho } = await import("../dist/pipeline.js");
  assert.equal(readable("Tp yg bikin emas susah napas klo DXY naik jg blm reda"), "Tapi yang bikin emas susah napas kalau DXY naik juga belum reda");
  assert.equal(readable("Emas (XAU) tetap"), "Emas (XAU) tetap");
  const now = Date.now();
  const posted = [{ at: now - 10 * 60_000, name: "Initial Jobless Claims", actual: "225K" }];
  assert.equal(calendarEcho("US initial jobless claims fall to 225K vs 230K expected", posted, now), "Initial Jobless Claims");
  assert.equal(calendarEcho("US continuing claims rise to 1.9M", posted, now), undefined);
  const msg = "<b>⚠️ X</b>\n\nFakta baru.\n\nArah emas belum jelas karena dua arus lagi tabrakan. Risiko inflasi bikin yield naik, ini ngerem gold.";
  assert.equal(hedgeScore(msg).timid, true);
});
