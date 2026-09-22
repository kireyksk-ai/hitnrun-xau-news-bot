import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceStore } from "../dist/intelligence-store.js";
import { assessEvent } from "../dist/event-intelligence.js";
import { runtimeActorRegistry, sourceClassFor } from "../dist/actor-registry.js";

function article(title, summary = "", sourceName = "Reuters") { return { provider: "fixture", providerId: title, title, summary, sourceName, url: "https://example.test", publishedAt: new Date("2026-09-22T00:00:00Z") }; }
test("phase one migrates old state with backup and persists memory-only evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-")); const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify({ records: {}, stories: {}, metrics: {}, safeMode: false, updateOffset: 0, regime: "UNCLEAR" }));
  const store = new IntelligenceStore(path); const a = article("China gold imports exceed 1,000 tonnes through August"); const e = assessEvent(a);
  store.rememberEvidence(a, e, false); assert.equal(store.marketBrain().schemaVersion, 6);
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
  const dir = mkdtempSync(join(tmpdir(), "brain-")); const store = new IntelligenceStore(join(dir, "state.json"));
  const a = article("Amazon blocks Meta AI shopping agent"); const e = assessEvent(a);
  const brain = store.marketBrain(); brain.evidence[e.key] = { id: e.key, timestamp: new Date().toISOString(), topic: "other-noise", subtopic: "event", facts: a.title, entities: [], provider: "fixture", sourceTier: 2, verification: "RELIABLE_WIRE", delta: "NEW_INFORMATION", alertDecision: "MEMORY_ONLY" };
  assert.equal(store.quarantineIrrelevantEvidence(), 1); assert.equal(Object.keys(store.marketBrain().evidence).length, 0); assert.ok(store.marketBrain().quarantine[e.key]);
  assert.ok(readdirSync(dir).some((name) => name.includes("backup-pre-memory-cleanup-")));
});
test("candidate memory gate rejects corporate noise but retains market-only candidates", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-")); const path = join(dir, "state.json"); const store = new IntelligenceStore(path);
  for (const title of ["Generic company quarterly earnings rise", "Castle Biosciences opens laboratory", "Match Group relaunches dating site", "DeepSeek and Anthropic dispute user-data routing", "China probes DeepSeek Moonshot over data breaches", "AI company faces privacy and security investigation", "Generic company corporate litigation continues"]) {
    const a = article(title); store.observeMarketEvent(a, assessEvent(a));
  }
  assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8")).memoryEvents ?? {}).length, 0);
  for (const title of ["Fed Goolsbee says inflation remains too high", "US CPI below consensus", "US PCE below consensus", "US NFP exceeds consensus", "FOMC holds rates steady", "Treasury yields rise after auction", "Hormuz disruption cuts oil shipments", "Trump announces new tariffs and Iran sanctions", "China announces semiconductor export controls with material US China trade implications", "Sanctions target a major Chinese company with explicit trade and geopolitical implications", "Major bank liquidity stress spreads through credit markets", "Refinery shutdown disrupts oil energy supply"]) {
    const a = article(title); store.observeMarketEvent(a, assessEvent(a));
  }
  const candidates = Object.values(JSON.parse(readFileSync(path, "utf8")).memoryEvents ?? {});
  assert.equal(candidates.length, 12);
  const lowMaterial = article("Fed Goolsbee repeats inflation remains too high"); const lowEvent = assessEvent(lowMaterial);
  store.rememberEvidence(lowMaterial, lowEvent, false);
  assert.equal(store.marketBrain().evidence[lowEvent.key].alertDecision, "MEMORY_ONLY");
});
test("legacy candidate cleanup quarantines only clear noise and keeps uncertain candidates", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-")); const path = join(dir, "state.json"); new IntelligenceStore(path);
  const data = JSON.parse(readFileSync(path, "utf8"));
  const candidate = (key, fact) => ({ key, storyKey: `other-${key}`, fact, action: "reported", changeType: "NEW_INFORMATION", entities: [], sourceConfidence: 60, eventTime: "2026-09-22T00:00:00.000Z" });
  data.memoryEvents = {
    earnings: candidate("earnings", "Generic company quarterly earnings rise"),
    lab: candidate("lab", "Castle Biosciences opens laboratory"),
    dating: candidate("dating", "Match Group relaunches dating site"),
    ai: candidate("ai", "DeepSeek and Anthropic dispute user-data routing"),
    breach: candidate("breach", "China probes DeepSeek Moonshot over data breaches"),
    uncertain: candidate("uncertain", "China considers strategic technology export controls after diplomatic escalation"),
    systemic: candidate("systemic", "Major bank liquidity stress spreads through credit markets")
  };
  writeFileSync(path, JSON.stringify(data));
  const store = new IntelligenceStore(path);
  assert.equal(store.quarantineIrrelevantCandidateMemory(), 5);
  const result = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(result.memoryEvents), ["uncertain", "systemic"]);
  assert.equal(Object.keys(result.candidateMemoryQuarantine).length, 5);
  assert.equal(result.candidateMemoryQuarantine.ai.reason, "NO_PLAUSIBLE_MARKET_TRANSMISSION");
  assert.equal(result.candidateMemoryQuarantine.breach.reason, "NO_PLAUSIBLE_MARKET_TRANSMISSION");
  assert.ok(readdirSync(dir).some((name) => name.includes("backup-pre-candidate-memory-cleanup-")));
});
test("premium provenance is compact, update-aware, and never makes popularity material", () => {
  const path = join(mkdtempSync(join(tmpdir(), "brain-")), "state.json"); const store = new IntelligenceStore(path);
  const a = { ...article("Fed official says inflation remains too high"), provider: "benzinga", providerId: "bz-77",
    sourceMeta: { stableId: "bz-77", updatedAt: "2026-09-22T01:00:00Z", authorId: "reporter", channels: ["Economics"], tags: ["Fed"], tickers: ["GLD"], publicMetrics: { like_count: 999999 }, sourceClass: "CREDIBLE_REPORTER" } };
  const e = assessEvent(a); store.observeMarketEvent(a, e);
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(state.memoryEvents[e.key].provenance.stableId, "bz-77");
  assert.equal(state.memoryEvents[e.key].provenance.publicMetrics.like_count, 999999);
  assert.equal(e.marketMateriality, 85); // derives from the Fed/rates channel, never metrics.
  assert.equal(sourceClassFor("DeItaone"), "FAST_WIRE"); assert.equal(sourceClassFor("unknown"), "UNVERIFIED_CLAIM");
  assert.equal(runtimeActorRegistry('[{"username":"FedTest","sourceClass":"OFFICIAL_DIRECT_STATEMENT","actor":"Federal Reserve","direct":true}]').at(-1).username, "FedTest");
  assert.equal(runtimeActorRegistry('[{"username":"bad handle!"}]').length, 7);
});
