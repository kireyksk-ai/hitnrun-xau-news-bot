import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PredictionLedger, applyMark, dueMarks, formatScorecard, judge, scorecard } from "../dist/predictions.js";
import { goldCallFrom, goldCallLine } from "../dist/editor.js";
import { validateNewsOutput } from "../dist/news-output.js";
import { IntelligenceStore } from "../dist/intelligence-store.js";
import { processArticle } from "../dist/pipeline.js";

const base = (over = {}) => ({ id: "p1", eventId: "e1", storyKey: "fed-policy", title: "Barr hawkish", createdAt: "2026-09-23T14:08:00Z",
  direction: "BEARISH", confidence: 65, horizonMinutes: 240, entryPrice: 4340, entrySource: "test", marks: {}, ...over });

test("judging: direction vs move, small moves are flat, two-way is never scored", () => {
  assert.equal(judge("BEARISH", -0.4), "HIT");
  assert.equal(judge("BEARISH", 0.4), "MISS");
  assert.equal(judge("BULLISH", 0.05), "FLAT");
  assert.equal(judge("TWO_WAY", 1), "NOT_SCORED");
});

test("marks are taken once, on time, and never from a stale restart", () => {
  const p = base();
  assert.deepEqual(dueMarks(p, new Date("2026-09-23T14:24:00Z")), [15]);
  assert.deepEqual(dueMarks(p, new Date("2026-09-23T16:00:00Z")), []); // 15m window missed, 60m window missed too (>30 min late)
  const marked = applyMark(p, 15, 4330, new Date("2026-09-23T14:24:00Z"));
  assert.equal(marked.marks["15"].result, "HIT");
  assert.deepEqual(dueMarks(marked, new Date("2026-09-23T14:25:00Z")), []);
  assert.deepEqual(dueMarks({ ...p, entryPrice: undefined }, new Date("2026-09-23T14:24:00Z")), []);
});

test("scorecard reports accuracy at the stated horizon and confidence calibration", () => {
  const items = [
    base({ id: "a", marks: { "240": { at: "x", price: 4320, returnPct: -0.46, result: "HIT" } } }),
    base({ id: "b", confidence: 82, marks: { "240": { at: "x", price: 4360, returnPct: 0.46, result: "MISS" } } }),
    base({ id: "c", direction: "TWO_WAY" })
  ];
  const card = scorecard(items, 0);
  assert.equal(card.alerts, 3); assert.equal(card.directional, 2);
  assert.deepEqual(card.atHorizon, { hit: 1, miss: 1, flat: 0 });
  const text = formatScorecard(card, "7 hari");
  assert.match(text, /50%/); assert.match(text, /bukan sinyal trading/);
  assert.doesNotMatch(text, /entry|stop.?loss|take profit|\bTP\b|\bSL\b|zona/i);
});

test("ledger persists and deduplicates", () => {
  const path = join(mkdtempSync(join(tmpdir(), "xau-pred-")), "p.json");
  const ledger = new PredictionLedger(path); ledger.add(base()); ledger.add(base());
  assert.equal(new PredictionLedger(path).all().length, 1);
});

test("potential line is potential only and passes the NEWS gate", () => {
  const call = goldCallFrom({ potensiArah: "BEARISH", keyakinan: 97, horizonJam: 4 });
  assert.equal(call.confidence, 90);
  const line = goldCallLine(call);
  assert.match(line, /^Potensi arah emas: cenderung turun · keyakinan 90% · ±4 jam$/);
  assert.doesNotMatch(line, /beli|jual|buy|sell|entry|zona|target|stop/i);
  const prose = "<b>⚠️ Barr: kenaikan suku bunga lanjutan kemungkinan dibutuhkan</b>\n\nGubernur Fed Michael Barr menilai kenaikan suku bunga lanjutan kemungkinan diperlukan agar inflasi kembali ke dua persen tepat waktu, karena risiko inflasi naik dan pasar kerja masih kuat.\n\nNada hawkish ini menekan emas lewat ekspektasi yield dan dolar yang lebih tinggi, meski risiko Iran bisa menahan penurunan.";
  const article = { provider: "t", providerId: "x", title: "Fed's Barr Says Further Rate Hikes Likely Needed", summary: "", url: "https://x.test", publishedAt: new Date() };
  assert.deepEqual(validateNewsOutput(`${prose}\n${line}`, article), { ok: true });
});

test("a sent alert with a call reaches the ledger hook exactly once", async () => {
  const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "xau-hook-")), "state.json"));
  const calls = [];
  const msg = "<b>⚠️ Dolar sentuh level tertinggi delapan minggu</b>\n\nIndeks dolar naik ke level tertinggi delapan minggu karena taruhan kenaikan suku bunga Fed menguat setelah data aktivitas bisnis AS yang kuat.\n\nDolar yang lebih kuat dan yield yang naik menekan emas, meski permintaan lindung nilai dari risiko Iran bisa menahan penurunan.";
  const call = { direction: "BEARISH", confidence: 60, horizonMinutes: 240 };
  const result = await processArticle({ provider: "benzinga", providerId: "dxy2", sourceName: "Benzinga", url: "https://example.test/dxy2",
    title: "Dollar Hits 8-Week High As Fed Hike Bets Surge", summary: "The dollar index climbed to an eight-week high.", publishedAt: new Date() }, {
    store, analyze: async () => ({ material: true, confidence: "high", reason: "DXY", telegramMessage: msg, call }),
    shadow: async () => ({ material: false, score: 0, reason: "" }), deliver: async () => ({ chat: 1 }),
    onSent: (record, c) => { calls.push([record.stage, c]); } });
  assert.equal(result.stage, "SENT");
  assert.deepEqual(calls, [["SENT", call]]);
});

test("the Telegram NEWS text carries no potential-direction footer", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/editor.ts", import.meta.url), "utf8");
  const build = source.slice(source.indexOf("function buildTelegramMessage"), source.indexOf("export class Editor"));
  assert.doesNotMatch(build, /goldCallLine/);
});
