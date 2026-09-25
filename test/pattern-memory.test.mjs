import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, candleCode, codeLabel, describeKey, keysOf, learn, Memory } from "../dist/pattern-memory.js";

test("candle shapes are coded by type and size", () => {
  assert.equal(candleCode([0, 100, 110, 99.5, 109], 10), "NK.S");
  assert.equal(candleCode([0, 100, 120, 99, 101], 10), "EA.B");
  assert.equal(candleCode([0, 100, 100.4, 95, 100.2], 10), "EB.K");
  assert.equal(candleCode([0, 100, 101.5, 98.6, 100.1], 10), "DJ.K");
  assert.equal(codeLabel("EA.B"), "ekor atas besar");
});

test("4h candles are built from complete 1h buckets only", () => {
  const H = 3_600_000;
  const h1 = [0, 1, 2, 3, 4, 5].map((k) => [k * H, 10 + k, 11 + k, 9 + k, 10.5 + k]);
  const h4 = aggregate(h1, 4 * H, 6 * H);
  assert.equal(h4.length, 1, "the 04:00 bucket is still forming");
  assert.deepEqual(h4[0], [0, 10, 14, 9, 13.5, 0]);
});

test("recall backs off from 3-candle to 1-candle memory and needs 30 samples", () => {
  const m = new Memory();
  const x = { atr: 1, codes: ["NK.S", "NK.S", "EA.B"], pos: "ATAS" };
  for (let i = 0; i < 29; i++) m.add(keysOf(x), -1);
  assert.equal(m.recall(keysOf(x)), undefined);
  m.add(keysOf(x), -1);
  const r = m.recall(keysOf(x));
  assert.equal(r.key, "L3:NK.S>NK.S>EA.B"); assert.ok(r.p < 0.1);
  assert.equal(describeKey(r.key), "naik sedang → naik sedang → ekor atas besar");
});

test("walk-forward learning finds a repeating shape and reports noise honestly", () => {
  // Every third candle is a big bullish candle after two small bearish ones: learnable.
  const bars = []; let p = 100;
  for (let i = 0; i < 900; i++) { const up = i % 3 === 2; const o = p; p = up ? p + 3 : p - 1; bars.push([i, o, Math.max(o, p) + 0.1, Math.min(o, p) - 0.1, p]); }
  const { report } = learn(bars, "H1");
  const a = report.scored.hit / (report.scored.hit + report.scored.miss);
  assert.ok(a > 0.9, `expected the cycle to be memorised, got ${a}`);
  assert.ok(report.proven.length > 0);
  let seed = 3; const noise = []; p = 100;
  for (let i = 0; i < 3000; i++) { seed = (seed * 16807) % 2147483647; const o = p; p += (seed / 2147483647 - 0.5) * 2; noise.push([i, o, Math.max(o, p) + 0.3, Math.min(o, p) - 0.3, p]); }
  const n = learn(noise, "H1").report, na = n.scored.hit / (n.scored.hit + n.scored.miss);
  assert.ok(na < 0.56, `random walk must not look predictable, got ${na}`);
});
