import test from "node:test";
import assert from "node:assert/strict";
import { weekendClosed } from "../dist/weekend.js";
import { meter } from "../dist/ai-usage.js";

const wib = (iso) => new Date(Date.parse(`${iso}+07:00`));

test("weekend close runs from Saturday 00:00 to Monday 04:00 WIB", () => {
  assert.equal(weekendClosed(wib("2026-10-02T23:59:00"), true), false, "Friday night still open");
  assert.equal(weekendClosed(wib("2026-10-03T00:00:00"), true), true, "Saturday 00:00 closed");
  assert.equal(weekendClosed(wib("2026-10-04T15:00:00"), true), true, "Sunday closed");
  assert.equal(weekendClosed(wib("2026-10-05T03:59:00"), true), true, "Monday before 04:00 closed");
  assert.equal(weekendClosed(wib("2026-10-05T04:00:00"), true), false, "Monday 04:00 open");
  assert.equal(weekendClosed(wib("2026-10-04T15:00:00"), false), false, "switch off");
});

test("metered OpenAI client refuses calls during the weekend close", async () => {
  let calls = 0;
  const raw = () => ({ responses: { create: async () => { calls++; return { usage: {} }; } } });
  const shut = meter(raw(), () => true), open = meter(raw(), () => false);
  await assert.rejects(shut.responses.create({ model: "gpt-5.6-luna" }), /Weekend close/);
  assert.equal(calls, 0, "nothing reached OpenAI");
  await open.responses.create({ model: "gpt-5.6-luna" });
  assert.equal(calls, 1);
});

test("weekend red-only: AI stays available inside the close until the weekend budget is spent", async () => {
  const { aiBlocked, addWeekendSpend, weekendSpent } = await import("../dist/weekend.js");
  const sat = new Date("2026-10-03T05:00:00Z"), mon = new Date("2026-10-05T05:00:00Z");
  const prev = { ro: process.env.WEEKEND_RED_ONLY, cap: process.env.WEEKEND_AI_USD_CAP, en: process.env.WEEKEND_CLOSE_ENABLED };
  process.env.WEEKEND_CLOSE_ENABLED = "true"; process.env.WEEKEND_AI_USD_CAP = "1.5";
  try {
    delete process.env.WEEKEND_RED_ONLY;
    assert.equal(aiBlocked(mon), false, "weekdays never blocked");
    assert.equal(aiBlocked(sat), false, "red-only weekend starts open");
    addWeekendSpend(1.2, sat); assert.equal(aiBlocked(sat), false);
    addWeekendSpend(0.4, sat); assert.ok(weekendSpent(sat) >= 1.5); assert.equal(aiBlocked(sat), true, "budget spent");
    assert.equal(aiBlocked(new Date("2026-10-04T05:00:00Z")), false, "new WIB day, new budget");
    process.env.WEEKEND_RED_ONLY = "false";
    assert.equal(aiBlocked(new Date("2026-10-04T06:00:00Z")), true, "full close when red-only is off");
  } finally {
    for (const [k, v] of [["WEEKEND_RED_ONLY", prev.ro], ["WEEKEND_AI_USD_CAP", prev.cap], ["WEEKEND_CLOSE_ENABLED", prev.en]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
