import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandleLab, confidence, features, outcome, replay, scoreLive, sessionOf } from "../dist/candle-lab.js";

const START = Date.UTC(2026, 8, 1, 0, 0);
/** Synthetic 5m candles: a sine wave plus deterministic noise, 24h a day. */
function candles(n, drift = 0, start = START) {
  const out = []; let price = 2000, seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647; const noise = (seed / 2147483647 - 0.5) * 2;
    const o = price; price = price + Math.sin(i / 20) * 0.8 + noise + drift;
    out.push([start + i * 300_000, o, Math.max(o, price) + 0.5, Math.min(o, price) - 0.5, price]);
  }
  return out;
}

test("sessions follow UTC hours", () => {
  assert.equal(sessionOf(Date.UTC(2026, 0, 5, 23)), "ASIA");
  assert.equal(sessionOf(Date.UTC(2026, 0, 5, 8)), "LONDON");
  assert.equal(sessionOf(Date.UTC(2026, 0, 5, 14)), "NEWYORK");
  assert.equal(sessionOf(Date.UTC(2026, 0, 5, 19)), "SORE");
});

test("features need 24h of history and use only past candles", () => {
  const bars = candles(400);
  assert.equal(features(bars, 100), undefined);
  const f = features(bars, 300);
  assert.ok(f && f.atr > 0);
  const future = bars.map((b, i) => i > 300 ? [b[0], 9999, 9999, 9999, 9999] : b);
  assert.deepEqual(features(future, 300), f, "changing candles after i must not change features at i");
  assert.equal(features(bars, 300, [bars[300][0] - 10 * 60_000]).news, "BERITA");
});

test("outcome marks small moves FLAT and weekend gaps SKIP", () => {
  const bars = [[0, 1, 1, 1, 100], [300_000, 1, 1, 1, 100.01], [600_000, 1, 1, 1, 100.02], [900_000, 1, 1, 1, 105]];
  assert.equal(outcome(bars, 0, 3, 1), "UP");
  assert.equal(outcome(bars, 0, 3, 100), "FLAT");
  const gap = [[0, 1, 1, 1, 100], [300_000, 1, 1, 1, 100], [600_000, 1, 1, 1, 100], [48 * 3_600_000, 1, 1, 1, 90]];
  assert.equal(outcome(gap, 0, 3, 1), "SKIP");
});

test("replay learns a real pattern and reports no edge on noise", () => {
  const trend = replay(candles(4000, 0.6)).result;
  const s = trend.perH[12];
  assert.ok(s.ens.hit + s.ens.miss > 500);
  assert.ok(s.ens.hit / (s.ens.hit + s.ens.miss) > 0.8, "a steady uptrend must be learned");
  // Without live proof the label can never be TINGGI.
  assert.notEqual(confidence(s, { n: 0, acc: null, base: null }, 0.9), "TINGGI");
});

test("confidence is earned: TINGGI only with replay edge, live edge and a clear lean", () => {
  const strong = { base: { hit: 500, miss: 500 }, ens: { hit: 600, miss: 400, abstain: 0 }, lens: {}, bands: [] };
  assert.equal(confidence(strong, { n: 150, acc: 0.58, base: 0.5 }, 0.62), "TINGGI");
  assert.equal(confidence(strong, { n: 150, acc: 0.48, base: 0.5 }, 0.62), "RENDAH", "live failing kills confidence");
  assert.equal(confidence(strong, { n: 20, acc: 0.6, base: 0.5 }, 0.62), "SEDANG", "too few live calls");
  assert.equal(confidence(strong, { n: 150, acc: 0.58, base: 0.5 }, 0.51), "RENDAH", "no clear lean");
  const none = { base: { hit: 500, miss: 500 }, ens: { hit: 505, miss: 495, abstain: 0 }, lens: {}, bands: [] };
  assert.equal(confidence(none, { n: 150, acc: 0.6, base: 0.5 }, 0.7), "RENDAH", "no replay edge");
});

test("live predictions are scored only against later candles", () => {
  const bars = [[0, 1, 1, 1, 100], [300_000, 1, 1, 1, 101], [600_000, 1, 1, 1, 102], [900_000, 1, 1, 1, 104]];
  const pred = { at: 0, price: 100, h: 3, dir: "UP", p: 0.6, base: "DOWN", atr: 1, edge: true };
  assert.equal(scoreLive(pred, bars.slice(0, 3)).result, undefined, "not due yet");
  const done = scoreLive(pred, bars);
  assert.equal(done.result, "HIT"); assert.equal(done.baseResult, "MISS");
});

test("CandleLab backfills, stores, replays and gives context without trading words", async () => {
  const dir = mkdtempSync(join(tmpdir(), "candle-"));
  const now = START + 2999 * 300_000 + 60_000;
  const bars = candles(3000, 0.4);
  const net = async (url) => {
    const interval = new URL(url).searchParams.get("interval");
    const src = interval === "5m" ? bars : bars.slice(-300);
    return new Response(JSON.stringify({ chart: { result: [{ timestamp: src.map((b) => b[0] / 1000),
      indicators: { quote: [{ open: src.map((b) => b[1]), high: src.map((b) => b[2]), low: src.map((b) => b[3]), close: src.map((b) => b[4]) }] } }] } }), { status: 200 });
  };
  const lab = new CandleLab(dir, () => [], 7, net);
  await lab.tick(now);
  assert.equal(lab.candles().length, 2999, "the still-forming candle is not stored");
  const text = lab.experience(now);
  assert.match(text, /PENGALAMAN CANDLE EMAS/);
  assert.match(text, /Keyakinan: (RENDAH|SEDANG)/);
  assert.doesNotMatch(text, /\b(BUY|SELL)\b|entry di|stop loss/i);
  assert.match(lab.status(now), /fase latihan/);
  const again = new CandleLab(dir, () => [], 7, net);
  assert.equal(again.candles().length, 2999, "candles survive a restart");
});

test("candle reasoning is private: the group message gate blocks it", async () => {
  const { validateNewsOutput } = await import("../dist/news-output.js");
  const article = { title: "Fed official says rates stay high", summary: "", url: "", source: "x", publishedAt: new Date().toISOString() };
  const body = "⚠️ Pejabat Fed bilang suku bunga tetap tinggi lebih lama\n\nIni fakta baru karena pasar sebelumnya berharap ada pemangkasan dalam waktu dekat, jadi ekspektasi itu sekarang mundur dan dolar ikut menguat di sesi ini.\n\nBuat emas ini menekan karena yield naik dan dolar kuat, jadi emas cenderung tertahan; ";
  assert.equal(validateNewsOutput(body + "breakout H1 BELUM DINILAI, tunggu candle konfirmasi dulu ya.", article).ok, false);
});
