import assert from "node:assert/strict";
import test from "node:test";
import { benzingaRelevant, benzingaTopicHits } from "../dist/providers/benzinga-wire.js";

test("substring false positives from today's logs no longer pass the Benzinga gate", () => {
  for (const title of [
    "Cracker Barrel Battles Consumer Pressure With $7.99 Breakfast, $8.99 Entrees",
    "The Anti-AI ETF? Wedbush Wants to Own What AI Can't Replace",
    "Agentic Commerce Could Hurt Booking, Intuit While Helping Meta, Microsoft, Joseph Carlson Says",
    "Palantir Stock Flips $188 Into Support, Eyes $200 Next"
  ]) assert.equal(benzingaRelevant({ title, teaser: "", body: "The software company moved toward an award-winning forward outlook." }), false, title);
});

test("real macro headlines still pass, including acronyms and squawk-style titles", () => {
  for (const title of [
    "Fed's Barr Says Further Rate Hikes Likely Needed To Ensure Timely Return To 2% Inflation",
    "USA Crude Oil Inventories 2.969M Barrel Build Vs 0.700M Barrel Draw Est.",
    "US Treasury Says It Will Buy Back Up To $6B Of 20-To-30-Year Debt In September 24 Liquidity Support Operation",
    "Iran's Pezeshkian Begins Speech At UN General Assembly 2026; United States Delegation Walks Out",
    "USA Gasoline Inventories 1.686M Barrel Draw Vs 0.100M Barrel Build Est."
  ]) assert.equal(benzingaRelevant({ title, teaser: "", body: "" }), true, title);
  const hits = benzingaTopicHits("EUR/USD slips as ECB speaks");
  assert.ok(hits.includes("eur") && hits.includes("ecb"), hits.join(","));
  assert.equal(benzingaTopicHits("a new cot for the eur-opean baby").includes("cot"), false);
});

test("a long body needs several distinct macro topics to pass on its own", () => {
  assert.equal(benzingaRelevant({ title: "Company update", teaser: "", body: "Oil was mentioned once." }), false);
  assert.equal(benzingaRelevant({ title: "Markets wrap", teaser: "", body: "<p>Treasury yields rose as the Fed signaled hikes while oil and the dollar climbed.</p>" }), true);
});
