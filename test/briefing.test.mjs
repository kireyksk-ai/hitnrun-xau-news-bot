import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BriefingLedger, briefingPrompt, dueBriefing, upcomingEvents, validateBriefing } from "../dist/briefing.js";

// 2026-09-24 is a Thursday. Summer: Asia 07:30 WIB = 00:30Z, Europe 07:30 London (BST) = 06:30Z, US 08:00 New York (EDT) = 12:00Z.
const SCHED = { asiaWib: "07:30", europeLondon: "07:30", usNewYork: "08:00" };
test("three session briefings fire once inside their window", () => {
  assert.equal(dueBriefing(new Date("2026-09-24T00:30:00Z"), SCHED, {}), "ASIA");
  assert.equal(dueBriefing(new Date("2026-09-24T00:49:00Z"), SCHED, {}), "ASIA");
  assert.equal(dueBriefing(new Date("2026-09-24T00:50:00Z"), SCHED, {}), null);
  assert.equal(dueBriefing(new Date("2026-09-24T00:35:00Z"), SCHED, { ASIA: "2026-09-24" }), null);
  assert.equal(dueBriefing(new Date("2026-09-24T06:31:00Z"), SCHED, {}), "EROPA");
  assert.equal(dueBriefing(new Date("2026-09-24T12:05:00Z"), SCHED, {}), "US");
  assert.equal(dueBriefing(new Date("2026-09-24T14:05:00Z"), SCHED, {}), null);
});
test("Europe and US follow daylight saving (winter: 14:30 and 20:00 WIB)", async () => {
  const { sessionSlots } = await import("../dist/briefing.js");
  const summer = sessionSlots("2026-09-24", SCHED), winter = sessionSlots("2026-12-03", SCHED);
  assert.equal(new Date(summer.EROPA).toISOString(), "2026-09-24T06:30:00.000Z");
  assert.equal(new Date(summer.US).toISOString(), "2026-09-24T12:00:00.000Z");
  assert.equal(new Date(winter.EROPA).toISOString(), "2026-12-03T07:30:00.000Z");
  assert.equal(new Date(winter.US).toISOString(), "2026-12-03T13:00:00.000Z");
  assert.equal(new Date(winter.ASIA).toISOString(), "2026-12-03T00:30:00.000Z");
});
test("Saturday gets the Asia recap only; Sunday gets nothing; recap windows chain the sessions", async () => {
  const { recapSince } = await import("../dist/briefing.js");
  assert.equal(dueBriefing(new Date("2026-09-26T00:31:00Z"), SCHED, {}), "ASIA");
  assert.equal(dueBriefing(new Date("2026-09-26T06:31:00Z"), SCHED, {}), null);
  assert.equal(dueBriefing(new Date("2026-09-26T12:01:00Z"), SCHED, {}), null);
  assert.equal(dueBriefing(new Date("2026-09-27T00:31:00Z"), SCHED, {}), null);
  assert.equal(new Date(recapSince("EROPA", new Date("2026-09-24T06:31:00Z"), SCHED)).toISOString(), "2026-09-24T00:30:00.000Z");
  assert.equal(new Date(recapSince("US", new Date("2026-09-24T12:01:00Z"), SCHED)).toISOString(), "2026-09-24T06:30:00.000Z");
  assert.equal(new Date(recapSince("ASIA", new Date("2026-09-24T00:31:00Z"), SCHED)).toISOString(), "2026-09-23T12:00:00.000Z");
  // Monday Asia looks back to Friday's US session.
  assert.equal(new Date(recapSince("ASIA", new Date("2026-09-28T00:31:00Z"), SCHED)).toISOString(), "2026-09-25T12:00:00.000Z");
});
test("upcoming keeps high/medium events inside the window, in WIB", () => {
  const now = new Date("2026-09-24T00:30:00Z");
  const ev = (id, iso, impact) => ({ id, name: id, country: "US", releaseAt: iso, consensus: "1.0%", prior: "0.9%", actual: null, impact, url: "" });
  const out = upcomingEvents([ev("CPI", "2026-09-24T12:30:00Z", "high"), ev("Low", "2026-09-24T12:30:00Z", "low"),
    ev("Past", "2026-09-23T12:30:00Z", "high"), ev("Far", "2026-09-26T12:30:00Z", "high")], now, 16);
  assert.deepEqual(out.map((e) => e.name), ["CPI"]);
  assert.match(out[0].at, /19:30 WIB/);
});
test("prompt forbids zones and trading instructions and carries the facts", () => {
  const p = briefingPrompt({ kind: "US", nowWib: "Kamis, 24 Sep 2026", recapHours: 6, sentAlerts: [{ at: "2026-09-24T03:00:00Z", theme: "fed-policy", title: "Fed's Barr says inflation sticky" }],
    rejectedButMoved: [], market: "DXY 101.2", upcoming: [] });
  assert.match(p, /Tanpa zona, level harga, entry/);
  assert.match(p, /Evening guys\.\.\./);
  assert.match(p, /Sesi US — Kamis, 24 Sep 2026/);
  assert.match(p, /6 jam terakhir/);
  assert.match(p, /data AS, pembicara Fed/);
  assert.match(p, /jangan pernah menyebut "bot"/);
  assert.match(p, /Fed's Barr/);
  assert.match(p, /tidak ada rilis penting/);
});
const body = (extra = "") => `<b>☀️ Morning guys...</b>\n${"Intinya dolar lagi kuat jadi emas ketahan, yield juga naik tp minyak turun. ".repeat(6)}${extra}`;
test("validator passes a clean briefing and keeps only balanced <b>", () => {
  const r = validateBriefing(body("Inflasi < 3% & data kuat. <i>miring</i>"));
  assert.equal(r.ok, true);
  assert.match(r.text, /<b>☀️ Morning guys...<\/b>/);
  assert.match(r.text, /&lt; 3% &amp; data/);
  assert.doesNotMatch(r.text, /<i>/);
  const unbalanced = validateBriefing(body("<b>tanpa tutup"));
  assert.equal(unbalanced.ok, true);
  assert.doesNotMatch(unbalanced.text, /<b>/);
});
test("validator rejects trading instructions, links and off-topic text", () => {
  assert.equal(validateBriefing(body("Entry di area bawah.")).ok, false);
  assert.equal(validateBriefing(body("SL ketat ya.")).ok, false);
  assert.equal(validateBriefing(body("Cek https://x.com")).ok, false);
  assert.equal(validateBriefing(body("Sources: Yahoo")).ok, false);
  assert.equal(validateBriefing(body("Ini dari bot kita.")).ok, false);
  assert.equal(validateBriefing("pendek banget").ok, false);
  assert.equal(validateBriefing("kata ".repeat(100)).ok, false);
});
test("ledger persists the last sent day", () => {
  const path = join(mkdtempSync(join(tmpdir(), "brief-")), "b.json");
  new BriefingLedger(path).mark("ASIA", "2026-09-24");
  assert.deepEqual(new BriefingLedger(path).sent(), { ASIA: "2026-09-24" });
});
test("recap covers released data of the last 24h and the prompt demands every shared alert", async () => {
  const { releasedEvents } = await import("../dist/briefing.js");
  const now = new Date("2026-09-24T00:30:00Z");
  const ev = (id, iso, actual) => ({ id, name: id, country: "US", releaseAt: iso, consensus: "52.0", prior: "53.0", actual, impact: "high", url: "" });
  const out = releasedEvents([ev("PMI", "2026-09-23T13:45:00Z", "58.4"), ev("Old", "2026-09-22T12:30:00Z", "1"), ev("NoActual", "2026-09-23T14:00:00Z", null)], now, 24);
  assert.deepEqual(out.map((e) => e.name), ["PMI"]);
  const p = briefingPrompt({ kind: "ASIA", nowWib: "x", recapHours: 24, sentAlerts: [], rejectedButMoved: [], market: "", upcoming: [], released: out });
  assert.match(p, /SEMUA berita yang sudah dibagikan ke grup dalam 24 jam terakhir/);
  assert.match(p, /aktual 58\.4 \| perkiraan 52\.0/);
  assert.match(p, /24 jam ke depan/);
});
