import test from "node:test";
import assert from "node:assert/strict";
import { boxBefore, describeNow, eventAt, eventOutcome, prep, reportLine, strength, study } from "../dist/market-structure.js";

/** 40 candles ranging 99–101 (normal range 2, volume 100), then whatever `tail` adds. */
function ranging(tail = []) {
  const bars = [];
  for (let i = 0; i < 40; i++) { const up = i % 2 === 0; bars.push([i, up ? 99.5 : 100.5, 101, 99, up ? 100.5 : 99.5, 100]); }
  return [...bars, ...tail.map((c, k) => [40 + k, ...c])];
}

test("candle strength combines body size and volume", () => {
  const bars = ranging([[100, 104.5, 99.8, 104.3, 400]]);
  const s = strength(bars, 40, prep(bars));
  assert.equal(s.label, "SANGAT_KUAT"); assert.ok(s.relVol > 3.5 && s.body > 2);
  const quiet = ranging([[100, 100.6, 99.8, 100.3, 50]]);
  assert.equal(strength(quiet, 40, prep(quiet)).label, "LEMAH");
});

test("sideways box: duration and how often each side was tested", () => {
  const bars = ranging(), box = boxBefore(bars, 39, prep(bars));
  assert.ok(box.len >= 20); assert.equal(Math.round(box.width), 1);
  assert.ok(box.topTests >= 5 && box.bottomTests >= 5);
});

test("a close outside the box is a breakout; real vs false is judged later", () => {
  const real = ranging([[100.5, 103, 100.4, 102.8, 300], [102.8, 105.5, 102.5, 105.2, 200]]);
  const p = prep(real), e = eventAt(real, 40, p);
  assert.equal(e.kind, "BREAKOUT"); assert.equal(e.side, "UP");
  assert.equal(eventOutcome(real, e, p, 40), undefined, "not known at the breakout candle");
  assert.equal(eventOutcome(real, e, p), "REAL");
  const fake = ranging([[100.5, 103, 100.4, 102.8, 300], [102.8, 102.9, 99.9, 100.2, 200]]);
  assert.equal(eventOutcome(fake, eventAt(fake, 40, prep(fake)), prep(fake)), "FALSE");
});

test("a wick through the box that closes back inside is a sweep (stop hunt)", () => {
  const bars = ranging([[100, 103.5, 99.9, 100.2, 250], [100.2, 100.3, 97.5, 97.8, 150]]);
  const p = prep(bars), e = eventAt(bars, 40, p);
  assert.equal(e.kind, "SWEEP"); assert.equal(e.side, "UP");
  assert.equal(eventOutcome(bars, e, p), "REAL", "price reversed down after the sweep");
});

test("study walks forward, counts level tests and never needs future candles", () => {
  const bars = []; let seed = 11, price = 2000;
  for (let i = 0; i < 4000; i++) { seed = (seed * 16807) % 2147483647; const o = price; price += (seed / 2147483647 - 0.5) * 4 + Math.sin(i / 30) * 0.6;
    bars.push([i * 3_600_000, o, Math.max(o, price) + 0.8, Math.min(o, price) - 0.8, price, 1000 + (seed % 500)]); }
  const rep = study(bars);
  const touches = (rep.events.TOUCH?.a ?? 0) + (rep.events.TOUCH?.b ?? 0);
  assert.ok(touches > 50, `expected level tests, got ${touches}`);
  assert.ok((rep.events.BREAKOUT?.a ?? 0) + (rep.events.BREAKOUT?.b ?? 0) > 5);
  const early = study(bars.slice(0, 2000));
  assert.ok((early.events.TOUCH?.a ?? 0) <= (rep.events.TOUCH?.a ?? 0));
  assert.match(reportLine(rep), /breakout asli \d+%/);
  const text = describeNow(bars, rep, 3_600_000);
  assert.match(text, /candle terakhir (naik|turun|datar)/);
  assert.doesNotMatch(text, /\d{4}\.\d/, "no price levels in the narrative context");
});

test("every breakout is suspected: trap signs and a confirmation wait before judging", async () => {
  const { confirmState, confirmOutcome, trapSigns } = await import("../dist/market-structure.js");
  // Weak, low-volume breakout candle with a long upper wick.
  const weak = ranging([[100.6, 104, 100.5, 101.6, 40], [101.6, 101.8, 100.4, 100.6, 60]]);
  const p = prep(weak), e = eventAt(weak, 40, p);
  assert.equal(e.kind, "BREAKOUT");
  const signs = trapSigns(weak, 40, "UP", e.box, e.str);
  assert.ok(signs.includes("volume tipis") && signs.includes("ekor penolakan panjang"), signs.join(","));
  assert.equal(confirmState(weak, e, 1, p), "GAGAL", "closed back inside on the next candle");
  // Strong breakout that retests the edge and holds, then runs.
  const good = ranging([[100.5, 103, 100.4, 102.8, 300], [102.8, 103.2, 101.2, 102.9, 200], [102.9, 104, 102.7, 103.9, 200], [103.9, 107, 103.8, 106.8, 250]]);
  const q = prep(good), g = eventAt(good, 40, q);
  assert.equal(confirmState(good, g, 1, q), "RETEST_OK");
  assert.equal(confirmState(good, g, 2, q), "MELAJU");
  assert.equal(confirmOutcome(good, g, 2, q, 42), undefined, "the judgement at c=2 cannot see later candles");
  assert.equal(confirmOutcome(good, g, 2, q), "REAL");
  const long = [...ranging().slice(0, 30).map((c, k) => [k - 30, ...c.slice(1)]), ...good.slice(0, 41)];
  const text = describeNow(long, study(long), 3_600_000);
  assert.match(text, /BELUM DINILAI/);
});
