import assert from "node:assert/strict";
import test from "node:test";
import { assessEvent, shouldReview } from "../dist/event-intelligence.js";

function article(title, summary = "", sourceName = "Reuters") {
  return { provider: "test", providerId: title, title, summary, url: "https://example.test", publishedAt: new Date("2026-09-22T00:00:00Z"), sourceName };
}

for (const [name, title, summary] of [
  ["Trump-Iran diplomacy", "Trump says he is open to meeting Iran's president", "Diplomatic opening discussed ahead of UN meetings."],
  ["Hormuz tankers", "Tanker traffic disrupted near Hormuz after new shipping threat", "Freight costs climb as crude cargoes reroute."],
  ["Iran sanctions", "US Treasury Secretary Bessent announces new sanctions on Iranian airlines", "Secondary sanctions threaten providers of landing and fuel services."],
  ["Fed shift", "Fed official Goolsbee rejects rate cuts to ease US government debt", "He says such pressure could lift long-term yields."],
]) test(`${name} is reviewable without gold or XAU in headline`, () => {
  const event = assessEvent(article(title, summary));
  assert.equal(shouldReview(event), true);
  assert.ok(event.importance >= 65);
});

test("minor energy item is not a high-priority override", () => {
  const event = assessEvent(article("Minor disruption at local oil storage site", "Routine maintenance; no change to supply."));
  assert.equal(event.highPriority, false);
  assert.equal(shouldReview(event), false);
});

test("analyst opinion mentioning Trump and Iran is not a high-priority override", () => {
  const event = assessEvent(article("Analyst opinion: Trump and Iran could someday meet", "No new statement or policy announced."));
  assert.equal(event.highPriority, false);
  assert.equal(shouldReview(event), false);
});

test("Iran agreement is a new update after Trump proposal", () => {
  const proposal = assessEvent(article("Trump says he is open to meeting Iran's president"));
  const prior = { key: proposal.storyKey, lastAction: proposal.action, lastFact: proposal.fact, lastChange: proposal.changeType, updatedAt: new Date().toISOString(), sent: true };
  const agreement = assessEvent(article("Iran agrees to meet Trump officials"), prior);
  assert.notEqual(proposal.key, agreement.key);
  assert.equal(shouldReview(agreement, prior), true);
});

test("same fact is repeat and rejected", () => {
  const first = assessEvent(article("Trump says he is open to meeting Iran's president"));
  const prior = { key: first.storyKey, lastAction: first.action, lastFact: first.fact, lastChange: first.changeType, updatedAt: new Date().toISOString(), sent: true };
  const repeat = assessEvent(article("Trump says he is open to meeting Iran's president"), prior);
  assert.equal(repeat.informationDelta, 0);
  assert.equal(shouldReview(repeat, prior), false);
});

