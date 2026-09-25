import test from "node:test";
import assert from "node:assert/strict";
import { fillActualsFromNasdaq, matchRow, parseNasdaq, resetNasdaqCache } from "../dist/calendar-nasdaq.js";
import { currencyOf } from "../dist/economic-calendar.js";

// Real shapes from api.nasdaq.com (rows for ?date=D are the US-Eastern day D-1, times US-Eastern).
const day25 = { data: { rows: [
  { gmt: "08:30", country: "United States", eventName: "Continuing Jobless Claims", actual: "1,719K", consensus: " ", previous: "1,700K" },
  { gmt: "08:30", country: "United States", eventName: "Initial Jobless Claims", actual: "197K", consensus: "235K", previous: "231K" },
  { gmt: "08:30", country: "United States", eventName: "Jobless Claims 4-Week Avg.", actual: "202.25K", consensus: " ", previous: "210K" },
  { gmt: "08:30", country: "United States", eventName: "Core Retail Sales (MoM)", actual: "0.5%", consensus: "0.3%", previous: "0.2%" },
  { gmt: "08:30", country: "United States", eventName: "Retail Sales (MoM)", actual: "0.7%", consensus: "0.4%", previous: "0.1%" },
  { gmt: "04:10", country: "United States", eventName: "FOMC Member Williams Speaks", actual: "&nbsp;", consensus: " ", previous: "&nbsp;" },
  { gmt: "All Day", country: "Japan", eventName: "Holiday", actual: " ", consensus: " ", previous: " " }
] } };
const day24 = { data: { rows: [
  { gmt: "09:45", country: "United States", eventName: "S&P Global Manufacturing PMI", actual: "57.0", consensus: "53.6", previous: "53.9" },
  { gmt: "09:45", country: "United States", eventName: "S&P Global Services PMI", actual: "58.7", consensus: "55.8", previous: "56.5" },
  { gmt: "03:30", country: "Germany", eventName: "HCOB Germany Manufacturing PMI", actual: "53.8", consensus: "54.1", previous: "54.3" },
  { gmt: "04:00", country: "Euro Zone", eventName: "HCOB Eurozone Manufacturing PMI", actual: "52.7", consensus: "52.6", previous: "52.7" }
] } };
const ev = (name, releaseAt, country = "USD") => ({ id: name, name, country, releaseAt, impact: "high", consensus: "1", prior: "1", actual: null, url: "" });

test("rows are placed on the right UTC time and speeches have no actual", () => {
  const rows = parseNasdaq(day25, "2026-09-25");
  assert.ok(rows.some((r) => r.name === "Initial Jobless Claims" && r.at === Date.parse("2026-09-24T12:30:00Z")));
  assert.equal(rows.find((r) => /Williams/.test(r.name)).actual, null);
});

test("names match the same release only", () => {
  const rows = parseNasdaq(day25, "2026-09-25");
  assert.equal(matchRow(ev("Initial Jobless Claims", "2026-09-24T12:30:00Z"), "USD", rows).actual, "197K");
  assert.equal(matchRow(ev("Retail Sales m/m", "2026-09-24T12:30:00Z"), "USD", rows).actual, "0.7%");
  assert.equal(matchRow(ev("Core Retail Sales m/m", "2026-09-24T12:30:00Z"), "USD", rows).actual, "0.5%");
  assert.equal(matchRow(ev("Initial Jobless Claims", "2026-09-17T12:30:00Z"), "USD", rows), undefined, "a week apart is not the same release");
  const pmi = parseNasdaq(day24, "2026-09-24");
  assert.equal(matchRow(ev("Flash Manufacturing PMI", "2026-09-23T13:45:00Z"), "USD", pmi).actual, "57.0");
  assert.equal(matchRow(ev("Flash Services PMI", "2026-09-23T13:45:00Z"), "USD", pmi).actual, "58.7");
  assert.equal(matchRow(ev("German Flash Manufacturing PMI", "2026-09-23T07:30:00Z", "EUR"), "EUR", pmi).actual, "53.8");
  assert.equal(matchRow(ev("Flash Manufacturing PMI", "2026-09-23T08:00:00Z", "EUR"), "EUR", pmi).actual, "52.7");
});

test("fill only recent released events and survive a failing source", async () => {
  resetNasdaqCache();
  const net = async (url) => new Response(JSON.stringify(url.includes("2026-09-25") ? day25 : { data: { rows: [] } }), { status: 200 });
  const events = [ev("Initial Jobless Claims", "2026-09-24T12:30:00Z"), ev("Initial Jobless Claims", "2026-10-01T12:30:00Z")];
  const out = await fillActualsFromNasdaq(events, currencyOf, net, Date.parse("2026-09-24T12:33:00Z"));
  assert.equal(out[0].actual, "197K"); assert.equal(out[1].actual, null, "future release untouched");
  resetNasdaqCache();
  const down = await fillActualsFromNasdaq(events, currencyOf, async () => { throw new Error("blocked"); }, Date.parse("2026-09-24T12:33:00Z"));
  assert.equal(down[0].actual, null);
});
