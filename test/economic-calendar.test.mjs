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
    assert.match(message, /financecalendar\.com/);
    assert.ok(!/entry|stop loss|take profit/i.test(message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no invented surprise or unsafe markup", () => {
  assert.match(compareActual("5%", null), /belum/);
  assert.match(compareActual("5%", "4K"), /Satuan/);
  const message = formatCalendarMessage({ ...event, name: "CPI <script>" }, "WARNING", calendarNarrative(event, "WARNING", ""));
  assert.match(message, /&lt;script&gt;/);
  assert.match(message, /CLEAR POSISI UNTUK HINDARI RISIKO/);
  assert.match(message, /Jangan judi/);
  assert.match(message, /financecalendar\.com/);
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
  assert.match(message, /HASIL BERITA KALENDER/);
  assert.doesNotMatch(message, /3 BINTANG|⭐⭐⭐|U READY4/);
});
