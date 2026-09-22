import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceStore } from "../dist/intelligence-store.js";
import { assessEvent } from "../dist/event-intelligence.js";

function article(title, summary = "", sourceName = "Reuters") { return { provider: "fixture", providerId: title, title, summary, sourceName, url: "https://example.test", publishedAt: new Date("2026-09-22T00:00:00Z") }; }
test("phase one migrates old state with backup and persists memory-only evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-")); const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify({ records: {}, stories: {}, metrics: {}, safeMode: false, updateOffset: 0, regime: "UNCLEAR" }));
  const store = new IntelligenceStore(path); const a = article("China gold imports exceed 1,000 tonnes through August"); const e = assessEvent(a);
  store.rememberEvidence(a, e, false); assert.equal(store.marketBrain().schemaVersion, 2);
  assert.equal(store.marketBrain().states["china-gold-market"].alertDecision, "MEMORY_ONLY");
  assert.ok(new IntelligenceStore(path).marketBrain().evidence[e.key]);
});
test("Fed confirmation, macro state, reversal, and structural ETF memory are silent records", () => {
  const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "brain-")), "state.json"));
  for (const a of [article("Fed Goolsbee repeats inflation remains too high"), article("US CPI below consensus; previous revised lower"), article("China gold ETF flows add 44 tonnes"), article("Iran rejects ceasefire proposal")]) {
    store.rememberEvidence(a, assessEvent(a), false);
  }
  const states = store.marketBrain().states;
  assert.ok(states["fed-state"]); assert.ok(states["macro-state"]); assert.ok(states["china-gold-market"]); assert.ok(states["geopolitical-state"]);
});
test("shadow records and market experiences are retained without NEWS routing", () => {
  const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "brain-")), "state.json"));
  store.recordShadow({ timestamp: new Date().toISOString(), kind: "UNEXPLAINED_MOVE", attribution: "DRIVER_UNKNOWN", facts: ["no sufficient driver"], channels: [], confidence: 30 });
  store.recordExperience({ id: "x", createdAt: new Date().toISOString(), regime: "UNCLEAR", trigger: "UNEXPLAINED_MOVE", attribution: "DRIVER_UNKNOWN", confidence: 30 });
  assert.equal(store.marketBrain().shadow[0].attribution, "DRIVER_UNKNOWN");
  assert.equal(store.similarExperiences("UNCLEAR", "UNEXPLAINED_MOVE").length, 1);
});
test("generic earnings, real estate and AI disputes never enter persistent memory", () => {
  const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "brain-")), "state.json"));
  for (const title of ["Serabi Gold Q2 earnings rise", "Stewards terminates real estate acquisition", "Amazon blocks Meta AI shopping agent"]) {
    const a = article(title); store.rememberEvidence(a, assessEvent(a), false);
  }
  assert.equal(Object.keys(store.marketBrain().evidence).length, 0);
});
test("deterministic cleanup quarantines legacy noise without deleting it", () => {
  const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "brain-")), "state.json"));
  const a = article("Amazon blocks Meta AI shopping agent"); const e = assessEvent(a);
  const brain = store.marketBrain(); brain.evidence[e.key] = { id: e.key, timestamp: new Date().toISOString(), topic: "other-noise", subtopic: "event", facts: a.title, entities: [], provider: "fixture", sourceTier: 2, verification: "RELIABLE_WIRE", delta: "NEW_INFORMATION", alertDecision: "MEMORY_ONLY" };
  assert.equal(store.quarantineIrrelevantEvidence(), 1); assert.equal(Object.keys(store.marketBrain().evidence).length, 0); assert.ok(store.marketBrain().quarantine[e.key]);
});
