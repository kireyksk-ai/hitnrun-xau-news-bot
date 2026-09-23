import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MATERIALITY_CALIBRATION_GUIDE } from "../dist/editor.js";
import { IntelligenceStore } from "../dist/intelligence-store.js";
import { processArticle } from "../dist/pipeline.js";

test("calibration covers the real misses of 23 Sep 2026 and reaches both AI reviews", () => {
  for (const cue of [/DXY at a multi-week/, /EIA crude/, /sanctions action/, /attack on commercial shipping/, /"likely needed"/, /Treasury buyback/, /OECD or IMF/, /two-way conclusion/])
    assert.match(MATERIALITY_CALIBRATION_GUIDE, cue);
  const source = readFileSync(new URL("../src/editor.ts", import.meta.url), "utf8");
  assert.equal(source.match(/\$\{MATERIALITY_CALIBRATION_GUIDE\}/g)?.length, 2);
});

test("shadow review is skipped when the primary already approved the event", async () => {
  const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "xau-cal-")), "state.json"));
  let shadowCalls = 0;
  const msg = "<b>⚠️ Dolar sentuh level tertinggi delapan minggu</b>\n\nIndeks dolar naik ke level tertinggi delapan minggu karena taruhan kenaikan suku bunga Fed menguat setelah data aktivitas bisnis AS yang kuat.\n\nDolar yang lebih kuat dan yield yang naik menekan emas, meski permintaan lindung nilai dari risiko Iran bisa menahan penurunan.";
  const result = await processArticle({ provider: "benzinga", providerId: "dxy", sourceName: "Benzinga", url: "https://example.test/dxy",
    title: "Dollar Hits 8-Week High As Fed Hike Bets Surge", summary: "The dollar index climbed to an eight-week high as traders raised Fed hike bets.", publishedAt: new Date() }, {
    store, analyze: async () => ({ material: true, confidence: "high", reason: "DXY milestone", telegramMessage: msg }),
    shadow: async () => { shadowCalls++; return { material: true, score: 90, reason: "x" }; }, deliver: async () => ({ chat: 1 }) });
  assert.equal(result.stage, "SENT");
  assert.equal(shadowCalls, 0);
});
