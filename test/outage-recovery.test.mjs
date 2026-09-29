import assert from "node:assert/strict";
import test from "node:test";
import { recoveryDigest } from "../dist/outage-recovery.js";

const now = Date.parse("2026-09-29T12:00:00Z");
function failed(id, minutes, storyKey = id, title = id) {
  const seen = new Date(now - minutes * 60_000).toISOString();
  return { id, stage: "AI_CONTRACT_FAILURE", event: { firstSeenAt: seen, storyKey }, article: { title, publishedAt: seen } };
}

test("recovery uses one bounded headline digest, never stale or duplicate stories", () => {
  const records = [failed("a", 10, "fed", "Fed <remarks>"), failed("b", 15, "fed", "Fed repeat"), failed("c", 20, "oil", "Oil supply"), failed("old", 90)];
  const text = recoveryDigest(records, 0, now, "fresh");
  assert.match(text, /Fed &lt;remarks&gt;/);
  assert.match(text, /Oil supply/);
  assert.doesNotMatch(text, /Fed repeat|old/);
  assert.match(text, /belum dinilai/);
  assert.equal(recoveryDigest(records, now - 5 * 60_000, now, "fresh"), null);
});

test("recovery never includes the alert currently being published", () => {
  assert.equal(recoveryDigest([failed("current", 1)], 0, now, "current"), null);
});
