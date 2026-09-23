import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowOutcomeLedger, dueShadowMarks, markShadow, rejectedButMoved, similarPast, formatMissedReport, REJECTED_OUTCOME_GUIDE } from "../dist/shadow-outcomes.js";
import { sequenceContext } from "../dist/sequence-context.js";

const item = (id, at, title, stage, r15, r60, entryPrice = 4340) => ({ id, at, title, storyKey: "iran-gulf-conflict-hormuz", source: "twitter-wire", stage,
  reason: stage === "SENT" ? "material" : "Pernyataan ini hanya retorika", fact: title.toLowerCase(), entryPrice,
  marks: { ...(r15 === undefined ? {} : { "15": { at, returnPct: r15 } }), ...(r60 === undefined ? {} : { "60": { at, returnPct: r60 } }) } });
const now = new Date("2026-09-23T17:40:00Z");

test("rejected items are re-priced at 15 and 60 minutes, once, on time", () => {
  const i = item("a", "2026-09-23T14:00:00Z", "Iran says Hormuz cannot be used for weapons", "AI");
  assert.deepEqual(dueShadowMarks(i, new Date("2026-09-23T14:16:00Z")), [15]);
  const m = markShadow(i, 15, 4310, new Date("2026-09-23T14:16:00Z"));
  assert.equal(m.marks["15"].returnPct.toFixed(2), "-0.69");
  assert.deepEqual(dueShadowMarks(m, new Date("2026-09-23T14:17:00Z")), []);
  assert.deepEqual(dueShadowMarks({ ...i, entryPrice: undefined }, new Date("2026-09-23T14:16:00Z")), []);
});

test("rejected-but-moved lists only notable moves in the window", () => {
  const items = [item("a", "2026-09-23T14:22:00Z", "Iran says Hormuz cannot be used for weapons against Iran", "AI", -0.1, -0.45),
    item("b", "2026-09-23T15:00:00Z", "Iran foreign ministry spokesperson comments", "AI", 0.05, 0.08)];
  const moved = rejectedButMoved(items, now);
  assert.equal(moved.length, 1);
  assert.match(moved[0], /21:22 WIB .* ditolak .* XAU -0\.45% dalam 1 jam/);
  assert.match(formatMissedReport(items, now), /ditolak tapi diikuti gerak emas/);
});

test("similar past headlines (sent or rejected) are recalled with the gold reaction", () => {
  const items = [item("a", "2026-09-20T10:00:00Z", "Iran demands US accept Hormuz shipping route agreed with Oman", "AI", -0.3, -0.5),
    item("b", "2026-09-21T10:00:00Z", "Iran demands US accept Hormuz route agreed with Oman before talks", "SENT", -0.2, -0.35),
    item("c", "2026-09-22T10:00:00Z", "Nasdaq hits record as chip stocks rally", "SCORE", 0.1, 0.1)];
  const lines = similarPast(items, "iran demands us accept hormuz shipping route agreed with oman", now);
  assert.match(lines[0], /^2 berita mirip dalam 30 hari; 2 diikuti gerak XAU/);
  assert.ok(lines.some((l) => /ditolak/.test(l)) && lines.some((l) => /terkirim/.test(l)));
  assert.deepEqual(similarPast(items, "fed chair speaks on inflation outlook", now), []);
});

test("sequence context carries the memory sections; guide keeps it evidence only", () => {
  const items = [item("a", "2026-09-23T14:22:00Z", "Iran says Hormuz cannot be used for weapons against Iran", "AI", -0.1, -0.45)];
  const text = sequenceContext([], [], "iran-gulf-conflict-hormuz", now, { shadow: items, fact: "iran says hormuz cannot be used for weapons against iran" });
  assert.match(text, /REJECTED_BUT_MOVED/); assert.match(text, /SIMILAR_PAST/);
  assert.match(REJECTED_OUTCOME_GUIDE, /One case proves nothing/);
});

test("ledger persists, dedupes and prunes old entries", () => {
  const path = join(mkdtempSync(join(tmpdir(), "xau-shadow-")), "s.json");
  const l = new ShadowOutcomeLedger(path);
  l.add(item("a", new Date().toISOString(), "x y z", "AI")); l.add(item("a", new Date().toISOString(), "x y z", "AI"));
  l.add(item("old", "2020-01-01T00:00:00Z", "old", "AI"));
  assert.deepEqual(new ShadowOutcomeLedger(path).all().map((i) => i.id), ["a"]);
});

test("sent alerts are never reported as rejected-but-moved", () => {
  const items = [item("s", "2026-09-23T14:22:00Z", "Iran says Hormuz cannot be used for weapons against Iran", "SENT", -0.1, -0.45)];
  assert.deepEqual(rejectedButMoved(items, now), []);
});
