import test from "node:test";
import assert from "node:assert/strict";
import { AiUsage, meter } from "../dist/ai-usage.js";
process.env.WEEKEND_CLOSE_ENABLED = "false"; // these tests are about counting, not the weekend close

test("usage is counted per purpose with cached and reasoning tokens, then reset", () => {
  const u = new AiUsage();
  u.record("market_editor_decision", { input_tokens: 6000, output_tokens: 900, input_tokens_details: { cached_tokens: 4000 }, output_tokens_details: { reasoning_tokens: 700 } });
  u.record("market_editor_decision", { input_tokens: 5000, output_tokens: 600 });
  u.record("briefing", { input_tokens: 9000, output_tokens: 3000 });
  const s = u.flush();
  assert.equal(s.total.calls, 3);
  const d = s.byPurpose.find((r) => r.purpose === "market_editor_decision");
  assert.deepEqual([d.calls, d.input, d.cached, d.output, d.reasoning], [2, 11000, 4000, 1500, 700]);
  assert.equal(u.flush().total.calls, 0);
  assert.equal(AiUsage.cost({ input: 1e6, cached: 5e5, output: 1e5 }, { input: 2, cached: 0.5, output: 10 }), 2.25);
});

test("meter records every responses.create call under its schema name", async () => {
  const fake = { responses: { create: async () => ({ usage: { input_tokens: 10, output_tokens: 2 } }) } };
  const client = meter(fake);
  await client.responses.create({ text: { format: { name: "calendar_text" } } });
  await client.responses.create({ input: [] });
  const { aiUsage } = await import("../dist/ai-usage.js");
  const names = aiUsage.flush().byPurpose.map((r) => r.purpose).sort();
  assert.deepEqual(names, ["briefing", "calendar_text"]);
});
