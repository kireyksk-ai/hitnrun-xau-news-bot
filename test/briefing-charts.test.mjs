import assert from "node:assert/strict";
import test from "node:test";
import { changeOf, changePct, chartSource, goldTilt, moveChart, statsLine, tiltChart } from "../dist/briefing-charts.js";

const t0 = Date.parse("2026-09-23T10:00:00Z");
const series = (label, values) => ({ label, symbol: label, points: values.map((v, i) => [t0 + i * 15 * 60_000, v]) });
const sample = [series("Emas", [100, 99.5, 99]), series("DXY", [100, 100.2, 100.4]), series("Yield US10Y", [4, 4.02, 4.04]), series("Minyak", [80, 79, 78])];

test("tilt follows the old scale: DXY and yield up press gold, oil stays neutral", () => {
  assert.equal(goldTilt("DXY", 0.4), "pressure");
  assert.equal(goldTilt("Yield US10Y", -0.5), "support");
  assert.equal(goldTilt("Minyak", -2), "neutral");
  assert.equal(goldTilt("Emas", 0.01), "neutral");
});
test("stats line matches the chart numbers", () => {
  assert.equal(changePct(sample[0]), -1);
  assert.match(statsLine(sample, t0), /Emas -1\.00% \| DXY \+0\.40% \| Yield US10Y \+4\.0 bp \| Minyak -2\.50%/);
  assert.equal(+changeOf(sample[2]).toFixed(2), 4);
});
test("charts show % change only (never price levels) and carry the verdict", () => {
  const move = moveChart(sample, "T");
  assert.deepEqual(move.data.datasets[0].data.filter((v) => v !== null).at(-1), -1);
  const tilt = tiltChart(sample, "T");
  assert.match(tilt.options.plugins.title.text, /Tekanan ke emas lebih dominan/);
  assert.match(tilt.options.plugins.subtitle.text[0], /2 dari 3 faktor menekan/);
  assert.equal(tilt.data.labels.at(-1), "Emas (XAUUSD)");
  const src = chartSource(tilt);
  assert.match(src, /function\(v\)/);
  assert.doesNotMatch(src, /__PCT__|__LABEL__|__BP__|__X__/);
});
test("series fetch falls back to another host/symbol and reports why", async () => {
  const { fetchSeries } = await import("../dist/briefing-charts.js");
  const now = Date.now(), calls = [];
  const fetcher = async (url) => { calls.push(String(url));
    if (String(url).includes("DX-Y.NYB")) return new Response("busy", { status: 429 });
    const ts = Array.from({ length: 10 }, (_, i) => Math.floor((now - (10 - i) * 900_000) / 1000));
    return new Response(JSON.stringify({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: ts.map((_, i) => 100 + i) }] } }] } }), { status: 200 });
  };
  const s = await fetchSeries({ label: "DXY", symbol: "DX-Y.NYB" }, now - 6 * 3600_000, fetcher);
  assert.equal(s.symbol, "DX=F"); assert.equal(s.points.length, 10);
  assert.ok(calls.some((u) => u.includes("query2") && u.includes("DX-Y.NYB")));
});
