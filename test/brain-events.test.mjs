import assert from "node:assert/strict";
import test from "node:test";
import { PLAYBOOK, matchPlaybook, resolveEntry, playbookPack, fedTone, mustReview, priorityOf } from "../dist/brain-events.js";
import { expectedBias, magnitudeOf } from "../dist/brain-calendar.js";

test("playbook knows every owner event and picks the specific one first", () => {
  for (const code of ["US_CPI", "US_CORE_CPI", "US_PCE", "US_CORE_PCE", "US_PPI", "US_NFP", "US_UNEMPLOYMENT", "US_AVG_HOURLY", "US_JOBLESS_CLAIMS", "US_JOLTS",
    "FOMC", "FOMC_MINUTES", "FED_SPEAK", "FED_DOT_PLOT", "FED_BALANCE_SHEET", "FED_INDEPENDENCE", "OIL_SPIKE", "OPEC_MEETING", "OPEC_SURPRISE", "HORMUZ_CLOSURE", "OIL_INVENTORY",
    "GEO_CONFLICT", "GEO_CEASEFIRE", "SANCTIONS", "US_DEBT_CEILING", "US_DEBT_40T", "US_30Y_YIELD", "US_TREASURY_AUCTION", "US_TREASURY_INTERVENTION", "US_FISCAL_STIMULUS",
    "DXY_MOVE", "USD_CREDIT", "DE_DOLLARIZATION", "CB_GOLD_BUY", "CB_GOLD_SELL", "CB_GOLD_DATA", "CN_PBOC_GOLD", "CB_DIVERSIFY"])
    assert.ok(PLAYBOOK.some((p) => p.code === code), code);
  assert.equal(matchPlaybook("US Core CPI rises 0.4% m/m")[0].code, "US_CORE_CPI");
  assert.equal(matchPlaybook("Nonfarm Payrolls")[0].code, "US_NFP");
  assert.equal(priorityOf("Initial Jobless Claims"), "CRITICAL");
  assert.ok(mustReview("Iran says Strait of Hormuz closed", 1)); assert.ok(!mustReview("Iran says Strait of Hormuz closed", 3));
});

test("regime-conditional bias follows the owner's rules", () => {
  const cpi = matchPlaybook("US CPI rises")[0];
  assert.equal(resolveEntry(cpi, "", { linkage: "RATE" }).bias, "BEARISH");
  assert.equal(resolveEntry(cpi, "", { linkage: "CB" }).bias, "BULLISH");
  const geo = PLAYBOOK.find((p) => p.code === "GEO_CONFLICT");
  assert.equal(resolveEntry(geo, "", { linkage: "RATE", oil24h: 6 }).bias, "BEARISH", "conflict + oil >5% → rate logic wins");
  assert.equal(resolveEntry(geo, "", { linkage: "CB", oil24h: 6 }).bias, "NEUTRAL", "CB absorbs: limited downside");
  assert.equal(resolveEntry(geo, "", { linkage: "RATE", oil24h: 0.4 }).bias, "BULLISH", "oil stable → safe haven");
  const oil = PLAYBOOK.find((p) => p.code === "OIL_SPIKE");
  assert.equal(resolveEntry(oil, "", { linkage: "RATE", oil24h: 4 }).bias, "BEARISH");
  assert.equal(resolveEntry(oil, "", { linkage: "RATE", oil24h: 4, us30y: 5.4 }).bias, "BULLISH", "30Y > 5.3% override");
  const fed = PLAYBOOK.find((p) => p.code === "FED_SPEAK");
  assert.equal(fedTone("Barr says further hikes likely, inflation sticky"), "HAWKISH");
  assert.equal(resolveEntry(fed, "Waller says rate cuts could come as inflation is cooling", { linkage: "RATE" }).bias, "BULLISH");
  assert.equal(resolveEntry(fed, "Barr says further hikes likely", { linkage: "CB" }).bias, "NEUTRAL", "Fed hawkish = noise in CB");
  assert.match(playbookPack("Iran threatens to close Hormuz as oil soars", { linkage: "RATE", oil24h: 7 }), /HORMUZ_CLOSURE .*bias sekarang BEARISH/);
});

test("calendar expected bias uses the playbook: claims/unemployment reversed, CPI up in CB bullish; NFP magnitude", () => {
  assert.equal(expectedBias("LABOR", 30, "RATE", "Initial Jobless Claims"), "BULLISH");
  assert.equal(expectedBias("INFLATION", 0.2, "CB", "CPI YoY"), "BULLISH");
  assert.equal(expectedBias("INFLATION", -0.2, "RATE", "CPI YoY"), "BULLISH");
  assert.equal(expectedBias("UNEMPLOYMENT", 0.1, "RATE", "Unemployment Rate"), "BULLISH");
  assert.equal(magnitudeOf("Nonfarm Payrolls", 70), "BESAR"); assert.equal(magnitudeOf("Nonfarm Payrolls", 10), "KECIL");
});
