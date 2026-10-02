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
