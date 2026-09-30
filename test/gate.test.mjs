import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceStore } from "../dist/intelligence-store.js";
import { processArticle } from "../dist/pipeline.js";
import { AiUsage, priceFor } from "../dist/ai-usage.js";

const article = (id, title) => ({ provider: "twitter-wire", providerId: id, sourceName: "X", url: `https://x.com/FirstSquawk/status/${id}`,
  title, summary: "", publishedAt: new Date(), sourceMeta: { sourceClass: "FAST_WIRE" } });

test("a gatekeeper FAIL stops the item before Sol; PASS and gate errors let it through", async () => {
  const run = async (gate, id) => {
    let solCalls = 0;
    const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "xau-gate-")), "state.json"));
    const r = await processArticle(article(id, "@FirstSquawk: FED'S MUSALEM SAYS INFLATION STILL TOO HIGH, MORE HIKES POSSIBLE"), { store, gate,
      analyze: async () => { solCalls++; return { material: false, confidence: "low", reason: "minor", telegramMessage: null }; },
      shadow: async () => { solCalls++; return { material: false, score: 10, reason: "minor" }; }, deliver: async () => ({ chat: 1 }) });
    return { r, solCalls };
  };
  const stopped = await run(async () => ({ pass: false, reason: "REPEAT: same Musalem line already judged" }), "101");
  assert.equal(stopped.solCalls, 0); assert.match(stopped.r.reason, /^GATE: REPEAT/);
  assert.ok((await run(async () => ({ pass: true, reason: "new" }), "102")).solCalls >= 1);
  assert.ok((await run(async () => { throw new Error("gate down"); }, "103")).solCalls >= 1, "fail-open");
});

test("daily spend is priced per model: Luna is ~20x cheaper than Sol", () => {
  const sol = AiUsage.cost({ input: 6000, cached: 3000, output: 800, reasoning: 0 }, priceFor("gpt-5.6-sol"));
  const luna = AiUsage.cost({ input: 1500, cached: 0, output: 60, reasoning: 0 }, priceFor("gpt-5.6-luna"));
  assert.ok(sol > 0.02 && sol < 0.04, String(sol));
  assert.ok(luna < 0.001, String(luna));
  const u = new AiUsage();
  u.record("news_gate", { input_tokens: 1000000, output_tokens: 0 }, "gpt-5.6-luna");
  assert.ok(Math.abs(u.day.usd - 0.2) < 1e-9);
});
