import assert from "node:assert/strict";
import test from "node:test";
import { recentChain, trackRecord, sequenceContext, SEQUENCE_REASONING_GUIDE } from "../dist/sequence-context.js";
import { assessEvent } from "../dist/event-intelligence.js";

const now = new Date("2026-09-23T17:40:00Z");
const sent = [
  { sentAt: "2026-09-23T13:46:00Z", storyKey: "us-macro-pmi", title: "US flash composite PMI jumps to 58.4, highest since 2021", eventKey: "pmi" },
  { sentAt: "2026-09-23T14:08:00Z", storyKey: "fed-policy", title: "Fed's Barr says further rate hikes likely needed", eventKey: "barr" },
  { sentAt: "2026-09-23T15:49:00Z", storyKey: "treasury-yields", title: "US 10-year yield hits 5.08%, highest since 2007", eventKey: "y10" },
  { sentAt: "2026-09-23T08:00:00Z", storyKey: "oil-supply", title: "too old for the 6h window", eventKey: "old" }
];
const pred = (eventId, direction, confidence, r15, r60, storyKey = "fed-policy", r240) => ({ id: eventId, eventId, storyKey, title: eventId, createdAt: "2026-09-23T14:08:00Z",
  direction, confidence, horizonMinutes: 240, entryPrice: 4340, entrySource: "t",
  marks: { ...(r15 === undefined ? {} : { "15": { at: "x", price: 1, returnPct: r15, result: "HIT" } }), ...(r60 === undefined ? {} : { "60": { at: "x", price: 1, returnPct: r60, result: "HIT" } }),
    ...(r240 === undefined ? {} : { "240": { at: "x", price: 1, returnPct: r240, result: r240 < 0 ? "HIT" : "MISS" } }) } });

test("chain lists recent alerts in order with the recorded call and measured XAU reaction", () => {
  const chain = recentChain(sent, [pred("barr", "BEARISH", 65, -0.31, -0.52)], now);
  assert.equal(chain.length, 3);
  assert.match(chain[0], /^20:46 WIB \| us-macro-pmi/);
  assert.match(chain[1], /arah dicatat BEARISH 65% \| reaksi XAU 15m -0\.31%, 1j -0\.52%/);
  assert.doesNotMatch(chain.join("\n"), /too old/);
});

test("track record is withheld until the sample is large enough, then reported per theme", () => {
  assert.deepEqual(trackRecord([pred("a", "BEARISH", 60, undefined, undefined, "iran-gulf-conflict-hormuz", -0.3)], "iran-gulf-conflict-diplomacy", now), []);
  const many = Array.from({ length: 10 }, (_, i) => ({ ...pred(`p${i}`, "BEARISH", 60, undefined, undefined, i % 2 ? "iran-gulf-conflict-hormuz" : "iran-gulf-conflict-military", i < 4 ? -0.3 : 0.3), createdAt: "2026-09-20T00:00:00Z" }));
  const lines = trackRecord(many, "iran-gulf-conflict-diplomacy", now);
  assert.ok(lines.some((l) => /tema iran-gulf-conflict: arah tepat 40% dari 10/.test(l)), lines.join("|"));
});

test("empty history adds nothing; guide keeps evidence advisory", () => {
  assert.equal(sequenceContext([], [], "fed-policy", now), "");
  assert.match(SEQUENCE_REASONING_GUIDE, /never let the record decide materiality/);
  assert.match(sequenceContext(sent, [], "fed-policy", now), /TRACK_RECORD: sampel belum cukup/);
});

test("Iran news is split into finer threads; yields and dollar get their own threads", () => {
  const key = (title) => assessEvent({ provider: "t", providerId: title, title, summary: "", url: "https://x.test", publishedAt: new Date(), sourceName: "Reuters" }).storyKey;
  assert.equal(key("Rubio: Iran fired at commercial ships this morning"), "iran-gulf-conflict-hormuz");
  assert.equal(key("Iran and US hold talks via Qatari mediator"), "iran-gulf-conflict-diplomacy");
  assert.equal(key("Houthis threaten US interests in the Red Sea"), "iran-gulf-conflict-houthi");
  assert.equal(key("Fed's Barr says further hikes likely needed"), "fed-policy");
  assert.equal(key("US 10-year yield hits 5.08%, highest since 2007"), "treasury-yields");
  assert.equal(key("Dollar hits 8-week high"), "fx-usd");
  assert.equal(key("Corporate earnings separate from macro"), key("Corporate earnings separate from macro"));
  assert.notEqual(key("Corporate earnings separate from macro"), "fed-policy");
});
