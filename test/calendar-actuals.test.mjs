import assert from "node:assert/strict";
import test from "node:test";
import { ActualCapture, extractActual, mentionPattern } from "../dist/calendar-actuals.js";
import { canonicalName, currencyOf, parseForexFactory } from "../dist/economic-calendar.js";
import { priorityOf } from "../dist/brain-events.js";

const claims = { id: "ff:usd-unemployment-claims:2026-09-24T12:30:00.000Z", name: "Initial Jobless Claims", country: "USD", releaseAt: "2026-09-24T12:30:00.000Z", consensus: "201K", prior: "196K", actual: null, impact: "medium", url: "" };
test("wire headlines give the actual in the calendar's own format", () => {
  assert.equal(extractActual("Dow Tumbles Over 100 Points; US Jobless Claims Fall to 197,000", claims), "197K");
  assert.equal(extractActual("US INITIAL JOBLESS CLAIMS 197K VS. EST. 201K; PRIOR 196K", claims), "197K");
  assert.equal(extractActual("U.S. Initial Jobless Claims 201,500 vs 201,000 Est.", claims), "201.5K");
  assert.equal(extractActual("Jobless claims data due at 08:30 ET; economists expect 201K", claims), null);
  assert.equal(extractActual("Gold rises 1% as dollar slips", claims), null);
  const cpi = { name: "Core CPI m/m", consensus: "0.3%", prior: "0.2%" };
  assert.equal(extractActual("US CORE CPI RISES 0.4% M/M, EST. 0.3%", cpi), "0.4%");
  assert.equal(extractActual("US CPI 2026 outlook: core CPI seen at 3%", cpi), null);
  const nfp = { name: "Nonfarm Payrolls", consensus: "150K", prior: "142K" };
  assert.equal(extractActual("US nonfarm payrolls rise 254,000 in September, beating forecasts", nfp), "254K");
  assert.ok(mentionPattern("Core CPI m/m").test("core CPI")); assert.ok(!mentionPattern("Core CPI m/m").test("headline CPI"));
});
test("capture needs a trusted source or two agreeing ones, and only right after the release", () => {
  const now = Date.parse("2026-09-24T12:31:00Z"), cap = new ActualCapture();
  const art = (provider, author, title) => ({ provider, author, title, summary: "", sourceName: "" });
  assert.deepEqual(cap.offer(art("twitter-wire", "someone", "Jobless claims fall to 197,000"), 3, [claims], now), []);
  const got = cap.offer(art("twitter-wire", "other", "US jobless claims 197K"), 3, [claims], now + 20_000);
  assert.equal(got.length, 1); assert.equal(got[0].actual, "197K");
  const cap2 = new ActualCapture();
  assert.equal(cap2.offer(art("benzinga", "", "US Jobless Claims Fall to 197,000"), 2, [claims], now)[0].actual, "197K");
  assert.deepEqual(new ActualCapture().offer(art("benzinga", "", "US Jobless Claims Fall to 197,000"), 2, [claims], now + 2 * 3600_000), []);
});
test("ForexFactory rows become calendar events the playbook recognises", () => {
  const rows = [{ title: "Unemployment Claims", country: "USD", date: "2026-09-24T08:30:00-04:00", impact: "Medium", forecast: "201K", previous: "196K" },
    { title: "German ifo Business Climate", country: "EUR", date: "2026-09-24T04:00:00-04:00", impact: "Low", forecast: "89.1", previous: "88.8" },
    { title: "Bank Holiday", country: "JPY", date: "2026-09-24T00:00:00-04:00", impact: "Holiday", forecast: "", previous: "" }];
  const ev = parseForexFactory(rows);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].name, "Initial Jobless Claims"); assert.equal(ev[0].releaseAt, "2026-09-24T12:30:00.000Z"); assert.equal(ev[0].consensus, "201K"); assert.equal(ev[0].actual, null);
  assert.equal(currencyOf(ev[0]), "USD"); assert.equal(currencyOf(ev[1]), "EUR"); assert.equal(priorityOf(ev[0].name), "CRITICAL");
  assert.equal(canonicalName("Non-Farm Employment Change"), "Nonfarm Payrolls");
});
test("calendar fetch prefers ForexFactory and falls back to the secondary feed", async () => {
  const { fetchCalendarEvents } = await import("../dist/economic-calendar.js");
  const now = new Date("2026-09-24T13:00:00Z");
  const fc = { events: [{ name: "Jobless claims", time_utc: "2026-09-24T12:30:00+00:00", all_day: false, impact: "medium", consensus: "Around 235,000", prior: "196,000", actual: "197,000", url: "https://www.financecalendar.com/event/us-initial-jobless-claims-september-24-2026/" }] };
  const ffRows = [{ title: "Unemployment Claims", country: "USD", date: "2026-09-24T08:30:00-04:00", impact: "Medium", forecast: "201K", previous: "196K" }];
  const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
  const both = await fetchCalendarEvents(async (u) => String(u).includes("faireconomy") ? (String(u).includes("thisweek") ? ok(ffRows) : new Response("", { status: 404 })) : ok(fc), now);
  assert.equal(both.length, 1); assert.equal(both[0].consensus, "201K"); assert.equal(both[0].actual, "197,000");
});
