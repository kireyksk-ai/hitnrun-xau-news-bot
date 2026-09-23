import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessEvent, shouldReview, sourceTier } from "../dist/event-intelligence.js";
import { IntelligenceStore } from "../dist/intelligence-store.js";
import { processArticle } from "../dist/pipeline.js";

const at = new Date("2026-09-23T10:00:00Z");
const article = (title, summary = title, sourceName = "Reuters") => ({
  provider: "wire", providerId: `${title}-${summary}`, title, summary,
  url: "https://example.test/macro", publishedAt: at, sourceName
});
const material = { material: true, confidence: "high", reason: "semantic macro development", telegramMessage:
  "<b>⚠️ PERKEMBANGAN MAKRO MATERIAL</b>\n\nFakta baru ini berpotensi mengubah ekspektasi pasar terhadap kebijakan, yield, dan dolar AS. Informasi tersebut perlu dipantau karena dampaknya dapat meluas ke aset lindung nilai.\n\nBuat emas, jalurnya bergantung pada perubahan ekspektasi suku bunga, yield, dolar, dan premi risiko. Arah emas belum jelas sampai reaksi lintas aset lebih konsisten." };

const plausible = [
  "Fed Barkin says the Fed is highly attentive to financial conditions, but cannot assume markets will keep rates at a level needed to cool inflation.",
  "Treasury WI 2-year yield 4.785% before $69 billion auction.",
  "Central bank announces purchase of gold reserves as part of reserve diversification.",
  "Gold ETF reports material net inflow into GLD holdings.",
  "DXY rises as Treasury yields reprice after macro data.",
  "Fed official gives guidance on financial conditions and the rate path.",
  "US PPI and JOLTS data surprise economists as wage pressure persists.",
  "Major bank run triggers emergency liquidity support across the financial system.",
  "US sovereign credit rating downgraded amid Treasury funding stress.",
  "India lowers gold import duty as physical demand surges.",
  "CME raises COMEX gold futures margin after delivery stress."
];

test("verified X fast wires retain trusted-source routing, unknown accounts do not", async () => {
  const wire = { ...article("@FirstSquawk: FED'S COLLINS: RESTRICTIVE RATE WILL HELP RETURN INFLATION TO TARGET"),
    provider: "twitter-wire", providerId: "123", sourceName: "X / Twitter Wire",
    url: "https://x.com/FirstSquawk/status/123", sourceMeta: { sourceClass: "FAST_WIRE" } };
  assert.equal(sourceTier(wire), 2);
  assert.equal(sourceTier({ ...wire, sourceMeta: { sourceClass: "UNVERIFIED_CLAIM" } }), 3);
  assert.equal(sourceTier({ ...wire, url: "https://example.test/status/123" }), 3);
  const run = async (item) => processArticle(item, {
    store: new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "wire-tier-")), "state.json")),
    analyze: async () => material,
    shadow: async () => ({ material: false, score: 10, reason: "not material" }),
    deliver: async () => ({ chat: 1 }), now: () => at
  });
  assert.equal((await run(wire)).stage, "SENT");
  assert.equal((await run({ ...wire, sourceMeta: { sourceClass: "UNVERIFIED_CLAIM" } })).stage, "SOURCE");
});

test("macro candidates reach Sol even when no narrow causal channel exists", () => {
  for (const title of plausible) {
    const event = assessEvent(article(title));
    assert.notEqual(event.candidateRoute, "OBVIOUS_NOISE", title);
    assert.equal(shouldReview(event), true, title);
  }
  for (const title of [...plausible.slice(0, 5), ...plausible.slice(7)]) {
    const event = assessEvent(article(title));
    assert.equal(event.candidateRoute, "PLAUSIBLE_MACRO", title);
    assert.equal(event.causalChannel, null, title);
  }
});

test("distinct macro follow-up reaches Sol despite heuristic delta below 60", async () => {
  const first = assessEvent(article("Fed Collins says inflation remains too high"));
  const prior = { key: first.storyKey, lastAction: first.action, lastFact: first.fact,
    lastChange: first.changeType, updatedAt: at.toISOString(), sent: true };
  const followUp = article("Fed Collins says labor demand is slowing while inflation remains too high");
  const event = assessEvent(followUp, prior);
  assert.equal(event.informationDelta, 45);
  assert.equal(shouldReview(event, prior), true);
  const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "follow-up-")), "state.json"));
  store.rememberStory(first, true);
  let calls = 0;
  const result = await processArticle(followUp, { store,
    analyze: async () => { calls++; return { material: false, confidence: "low", reason: "Sol judged follow-up immaterial", telegramMessage: null }; },
    shadow: async () => ({ material: false, score: 10, reason: "not material" }),
    deliver: async () => ({ chat: 1 }), now: () => at });
  assert.equal(calls, 1);
  assert.equal(result.stage, "SHADOW");
  assert.equal(result.primaryDecision, "DROP");
});

test("obvious corporate noise never receives macro channels or Sol budget", async () => {
  const noise = [
    "CNBC Final Trades: analyst upgrades an oil company stock",
    "Stock movers: shares of Oil Corp jump after earnings",
    "Whale alert moves crypto between wallets",
    "Company acquisition rumor involves an energy software startup",
    "FDA approves a single-company drug",
    "Analyst sees company AI growth accelerating after quarterly results"
  ];
  for (const title of noise) {
    const event = assessEvent(article(title));
    assert.equal(event.candidateRoute, "OBVIOUS_NOISE", title);
    assert.equal(event.causalChannel, null, title);
    assert.equal(shouldReview(event), false, title);
  }
  const path = join(mkdtempSync(join(tmpdir(), "macro-route-")), "state.json");
  const store = new IntelligenceStore(path);
  let calls = 0;
  const result = await processArticle(article(noise[1]), {
    store,
    analyze: async () => { calls++; return material; },
    shadow: async () => { calls++; return { material: true, score: 99, reason: "must not run" }; },
    deliver: async () => ({ chat: 1 }), now: () => at
  });
  assert.equal(result.stage, "SCORE");
  assert.match(result.reason, /^OBVIOUS_NOISE_DROP/);
  assert.equal(calls, 0);
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  const daily = Object.values(persisted.metrics)[0];
  assert.equal(daily.obviousNoiseDrop, 1);
});

test("routing counters persist plausible Sol, deterministic Sol, Sol reject and Sol send", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "macro-count-")), "state.json");
  const store = new IntelligenceStore(path);
  const deps = {
    store,
    analyze: async (item) => item.title.includes("Treasury")
      ? { material: false, confidence: "low", reason: "not material after context", telegramMessage: null }
      : material,
    shadow: async () => ({ material: false, score: 10, reason: "not material" }),
    deliver: async () => ({ chat: 1 }), now: () => at
  };
  assert.equal((await processArticle(article(plausible[0]), deps)).stage, "SENT");
  assert.equal((await processArticle(article(plausible[1]), deps)).stage, "AI");
  assert.equal((await processArticle(article("Iran announces Hormuz shipping shutdown"), deps)).stage, "SENT");
  const metrics = Object.values(JSON.parse(readFileSync(path, "utf8")).metrics)[0];
  assert.equal(metrics.plausibleMacroToSol, 2);
  assert.equal(metrics.deterministicMaterialToSol, 1);
  assert.equal(metrics.solReject, 1);
  assert.equal(metrics.solSend, 2);
});
