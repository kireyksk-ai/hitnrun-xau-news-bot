import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalendarLedger, calendarNarrative, compareActual, dueStage, formatCalendarMessage, formatWib, parseCalendarEvents } from "../dist/economic-calendar.js";

const releaseAt = "2026-09-24T01:30:00.000Z";
const event = { id: "https://www.financecalendar.com/event/australia-labour-force-september-2026/", name: "Australia Labour Force", country: "", releaseAt, consensus: "4.5%", prior: "4.4%", actual: null, impact: "high", url: "https://www.financecalendar.com/event/australia-labour-force-september-2026/" };

test("timed calendar events of every impact with explicit UTC offset are accepted", () => {
  const data = { events: [
    { name: event.name, time_utc: "2026-09-24T01:30:00+00:00", url: event.url, impact: "high", all_day: false, consensus: "4.5%", prior: "4.4%", actual: null },
    { name: "Minor PMI", time_utc: releaseAt, url: "https://www.financecalendar.com/event/minor-pmi/", impact: "medium", all_day: false },
    { name: "Holiday", time_utc: releaseAt, url: "https://www.financecalendar.com/event/holiday/", impact: "high", all_day: true },
    { name: "Bad time", time_utc: "2026-09-24T01:30:00", url: "https://www.financecalendar.com/event/bad-time/", impact: "high", all_day: false }
  ] };
  assert.deepEqual(parseCalendarEvents(data), [event, { id: "https://www.financecalendar.com/event/minor-pmi/", name: "Minor PMI", country: "", releaseAt, consensus: null, prior: null, actual: null, impact: "medium", url: "https://www.financecalendar.com/event/minor-pmi/" }]);
});

test("WIB conversion and 10-minute warning window", () => {
  assert.match(formatWib(releaseAt), /08\.30 WIB/);
  const t = Date.parse(releaseAt);
  assert.equal(dueStage(event, t - 10 * 60000, {}, ["a"]), "WARNING");
  assert.equal(dueStage(event, t - 7 * 60000, {}, ["a"]), "WARNING");
  assert.equal(dueStage(event, t - 9 * 60000, { warnedTo: { a: 1 } }, ["a"]), null);
  assert.equal(dueStage(event, t - 9 * 60000, { warnedTo: { a: 1 } }, ["a", "b"]), "WARNING");
  assert.equal(dueStage({ ...event, actual: "4.7%" }, t + 59000, { releaseAt }, ["a"]), null);
  assert.equal(dueStage({ ...event, actual: "4.7%" }, t + 60000, { releaseAt }, ["a"]), "ACTUAL");
  const medium = { ...event, impact: "medium", actual: "56.1" };
  assert.equal(dueStage(medium, t - 9 * 60000, {}, ["a"]), null);
  assert.equal(dueStage(medium, t + 60000, { releaseAt }, ["a"]), "ACTUAL");
  assert.equal(dueStage(medium, t + 48 * 3600000, { releaseAt }, ["a"]), "ACTUAL");
  assert.equal(dueStage(medium, t + 60000, {}, ["a"]), null);
});

test("forecast snapshot survives restart and post-release output is factual", () => {
  const dir = mkdtempSync(join(tmpdir(), "hitnrun-calendar-"));
  try {
    const path = join(dir, "calendar.json");
    const first = new CalendarLedger(path);
    first.observe(event, Date.parse(releaseAt) - 3600000);
    first.mark(event.id, "WARNING", { a: 11 });
    const second = new CalendarLedger(path);
    assert.equal(second.get(event.id).firstSeenForecast, "4.5%");
    assert.equal(second.get(event.id).warnedTo.a, 11);
    const released = { ...event, actual: "4.7%", consensus: "4.6%" };
    const explanation = calendarNarrative(released, "ACTUAL", "Emas turun | DXY naik | US10Y naik", second.get(event.id));
    const message = formatCalendarMessage(released, "ACTUAL", explanation, second.get(event.id));
    assert.match(message, /Actual: 4\.7% \| Forecast: 4\.5%/);
    assert.match(message, /Actual di atas konsensus/);
    assert.doesNotMatch(message, /financecalendar\.com|Sumber kalender/, "owner: no source line");
    assert.ok(!/entry|stop loss|take profit/i.test(message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no invented surprise or unsafe markup", () => {
  assert.match(compareActual("5%", null), /belum/);
  assert.match(compareActual("5%", "4K"), /Satuan/);
  const message = formatCalendarMessage({ ...event, name: "US CPI <script>" }, "WARNING", calendarNarrative(event, "WARNING", ""));
  assert.match(message, /&lt;script&gt;/);
  assert.match(message, /CLEAR POSISI UNTUK HINDARI RISIKO/);
  assert.match(message, /Jangan judi/);
  assert.doesNotMatch(message, /financecalendar\.com|Sumber kalender/, "owner: no source line");
});

test("narrative follows observed cross-asset sentiment without forcing a gold direction", () => {
  const rising = calendarNarrative(event, "WARNING", "Emas turun (-0.30%) | DXY naik (0.20%) | US10Y naik (0.10%)");
  const falling = calendarNarrative(event, "WARNING", "Emas naik (0.30%) | DXY turun (-0.20%) | US10Y turun (-0.10%)");
  assert.match(rising.narrative, /penahan bagi emas/);
  assert.match(falling.narrative, /tekanan suku bunga.*mereda/);
  assert.notEqual(rising.narrative, falling.narrative);
  assert.match(rising.narrative, /bukan bukti reaksi khusus/);
});

test("non-high result is news without a three-star warning label", () => {
  const medium = { ...event, impact: "medium", actual: "56.1" };
  const message = formatCalendarMessage(medium, "ACTUAL", calendarNarrative(medium, "ACTUAL", ""));
  assert.match(message, /📰 HASIL 🇦🇺 AUSTRALIA \(AUD\)/);
  assert.doesNotMatch(message, /3 BINTANG|⭐⭐⭐|U READY4/);
});

test("alarm header only for 3-star USD; other currencies get a calm labelled header and their gold link", async () => {
  const { currencyOf, goldLinkNote } = await import("../dist/economic-calendar.js");
  assert.equal(currencyOf(event), "AUD"); assert.equal(currencyOf({ ...event, name: "Initial Jobless Claims", url: "" }), "USD");
  assert.equal(currencyOf({ ...event, name: "German Ifo Business Climate", url: "" }), "EUR");
  const aud = formatCalendarMessage(event, "WARNING", { meaning: "a", narrative: "b" });
  assert.match(aud, /📅 RILIS 🇦🇺 AUSTRALIA \(AUD\) — ⭐⭐⭐/); assert.match(aud, /Australia Labour Force \(AUD\)/); assert.doesNotMatch(aud, /U READY4|CLEAR POSISI/);
  const usdMedium = formatCalendarMessage({ ...event, name: "US Durable Goods", url: "", impact: "medium" }, "WARNING", { meaning: "a", narrative: "b" });
  assert.doesNotMatch(usdMedium, /U READY4/);
  const usdHigh = formatCalendarMessage({ ...event, name: "US Nonfarm Payrolls", url: "" }, "WARNING", { meaning: "a", narrative: "b" });
  assert.match(usdHigh, /U READY4 NEWSSSSS 🚨\n🇺🇸 AMERIKA SERIKAT \(USD\) — ⭐⭐⭐/);
  assert.match(goldLinkNote("AUD"), /gak masuk hitungan DXY/);
});

test("US results become one institutional note: every print, revision, seven sections, under Telegram's limit", async () => {
  const { formatCalendarDeep, printFacts } = await import("../dist/economic-calendar.js");
  const base = { country: "US", releaseAt: "2026-10-14T12:30:00Z", impact: "high", url: "" };
  const cpi = { ...base, id: "a", name: "Core CPI m/m", consensus: "0.3%", prior: "0.3%", actual: "0.4%" };
  const yoy = { ...base, id: "b", name: "CPI y/y", consensus: "2.9%", prior: "2.9%", actual: "2.8%" };
  const f = printFacts(cpi, { firstSeenForecast: "0.3%", firstSeenPrior: "0.2%" });
  assert.equal(f.versus, "DI ATAS"); assert.equal(f.revisedPrior, "0.3%"); assert.equal(f.prior, "0.2%");
  const long = "Kalimat analisa yang panjang dan lengkap. ".repeat(40);
  const dive = { angka: long, kualitas: long, fed: long, transmisi: long, emas: long, risiko: long, berikutnya: long };
  const msg = formatCalendarDeep([{ event: cpi, saved: { firstSeenPrior: "0.2%" } }, { event: yoy, saved: {} }], dive);
  assert.ok(msg.length <= 4096, `length ${msg.length}`);
  for (const t of ["Angka vs ekspektasi", "Kualitas dan detail data", "Implikasi untuk The Fed", "Transmisi ke dolar dan yield", "Dampak ke emas", "Yang bisa membalik", "Yang dipantau berikutnya"]) assert.match(msg, new RegExp(t));
  assert.match(msg, /🇺🇸 AMERIKA SERIKAT \(USD\)/);
  assert.match(msg, /Core CPI m\/m: <b>0\.4%<\/b> vs perkiraan 0\.3%.*di atas perkiraan.*direvisi 0\.2% → 0\.3%/);
  assert.match(msg, /CPI y\/y: <b>2\.8%<\/b>.*di bawah perkiraan/);
  assert.doesNotMatch(msg, /https?:|entry|stop loss/i);
});

test("an owner-critical US release with an empty country field still gets the pre-release warning", async () => {
  const { dueStage, currencyOf } = await import("../dist/economic-calendar.js");
  const { priorityOf } = await import("../dist/brain-events.js");
  const e = { id: "c", name: "Initial Jobless Claims", country: "", releaseAt: "2026-09-24T12:30:00Z", consensus: "235K", prior: "196K", actual: null, impact: "medium",
    url: "https://www.financecalendar.com/event/us-initial-jobless-claims-september-24-2026/" };
  const upgraded = e.impact !== "high" && currencyOf(e) === "USD" && priorityOf(e.name) === "CRITICAL" ? { ...e, impact: "high" } : e;
  assert.equal(upgraded.impact, "high");
  assert.equal(dueStage(upgraded, Date.parse("2026-09-24T12:25:00Z"), {}), "WARNING");
});
