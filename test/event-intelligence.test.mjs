import assert from "node:assert/strict";
import test from "node:test";
import { assessEvent } from "../dist/event-intelligence.js";

function article(title, summary = "") {
  return { provider: "test", providerId: title, title, summary, url: "https://example.test", publishedAt: new Date("2026-09-22T00:00:00Z"), sourceName: "Reuters" };
}

test("Trump-Iran diplomacy is high priority without gold or XAU keywords", () => {
  const result = assessEvent(article("Trump says he is open to meeting Iran's president", "Diplomatic opening discussed ahead of UN meetings."));
  assert.equal(result.highPriority, true);
  assert.ok(result.score >= 80);
});

test("Iran agreement is an update, not a duplicate of the meeting proposal", () => {
  const proposal = assessEvent(article("Trump says he is open to meeting Iran's president"));
  const agreement = assessEvent(article("Iran agrees to talks with Trump officials"));
  assert.notEqual(proposal.key, agreement.key);
});

test("Hormuz tanker disruption is high priority without gold or XAU keywords", () => {
  const result = assessEvent(article("Tanker traffic disrupted near Hormuz after new shipping threat", "Freight costs climb as crude cargoes reroute."));
  assert.equal(result.highPriority, true);
  assert.ok(result.score >= 80);
});

test("Unrelated retail stock commentary is below publish threshold", () => {
  const result = assessEvent(article("Groupon stock rises after analyst upgrade", "No macro catalyst cited."));
  assert.equal(result.highPriority, false);
  assert.ok(result.score < 65);
});
