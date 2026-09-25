import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyse, Backtest, insightLine, reactionAt, regimeByMonth, releaseFigures, RELEASES, specFor, valueAt } from "../dist/brain-backtest.js";

const DAY = 86400_000, T0 = Date.parse("2021-01-04T00:00:00Z");
const spec = (k) => RELEASES.find((r) => r.key === k);
test("release figures: m/m from an index, change for payrolls, level with trend for claims", () => {
  const cpi = releaseFigures(spec("CPI"), [100, 100.2, 100.4, 100.5, 101.0]);
  assert.equal(cpi.actual, +((101.0 / 100.5 - 1) * 100).toFixed(4));
  assert.ok(cpi.actual > cpi.trend);
  const nfp = releaseFigures(spec("NFP"), [150000, 150200, 150350, 150500, 150900]);
  assert.equal(nfp.actual, 400); assert.equal(nfp.prior, 150);
  const claims = releaseFigures(spec("CLAIMS"), [220, 225, 230, 228, 210]);
  assert.equal(claims.actual, 210); assert.equal(claims.trend, (228 + 230 + 225 + 220) / 4);
  assert.equal(specFor("Core CPI m/m").key, "CORECPI"); assert.equal(specFor("CPI y/y").key, "CPI"); assert.equal(specFor("Initial Jobless Claims").key, "CLAIMS");
  assert.equal(specFor("Nonfarm Payrolls").key, "NFP"); assert.equal(specFor("Germany Ifo"), undefined);
});
test("regime by month: gold falling when real yields rise = RATE, gold ignoring them = CB", () => {
  const gold = [], real = [];
  let g = 1800, r = 0.5;
  for (let i = 0; i < 260; i++) {
    const shock = Math.sin(i * 1.7) * 0.05;
    r += shock; g *= 1 + (i < 130 ? -shock * 0.2 : Math.cos(i * 2.3) * 0.004);
    gold.push([T0 + i * DAY, g]); real.push([T0 + i * DAY, r]);
  }
  const reg = regimeByMonth(gold, real);
  assert.equal(reg["2021-04"], "RATE");
  assert.ok(["CB", "MIXED"].includes(reg["2021-09"]));
});
test("reaction: day move and the first hour after 08:30 ET", () => {
  const at = Date.parse("2024-03-12T12:30:00Z");
  const daily = { XAU: [[at - DAY, 2000], [at + 3 * 3600_000, 1990], [at + DAY, 1995]] };
  const hourly = { XAU: [[at - 30 * 60_000, 2000], [at + 30 * 60_000, 1985]], DXY: [[at - 30 * 60_000, 103], [at + 30 * 60_000, 103.5]], US10Y: [[at - 30 * 60_000, 41.0], [at + 30 * 60_000, 41.5]] };
  const r = reactionAt(at, daily, hourly);
  assert.equal(r.d1, -0.5); assert.equal(r.h1, -0.75); assert.equal(r.y10bp1, 5);
  assert.equal(valueAt([[1, 10], [5, 20]], 3), 10);
});
test("analysis learns a stable pattern, scores it out of sample, and writes a Sol line", () => {
  const events = [];
  for (let i = 0; i < 60; i++) {
    const hawkish = i % 2 === 0, at = T0 + i * 30 * DAY;
    events.push({ key: "CPI", family: "INFLATION", name: "CPI m/m", at, date: new Date(at).toISOString().slice(0, 10), actual: 0.3, prior: 0.2, trend: 0.2, surprise: hawkish ? 0.1 : -0.1, hawkish,
      reaction: { d1: hawkish ? -0.6 + (i % 5) * 0.05 : 0.5 - (i % 3) * 0.05, h1: hawkish ? -0.3 : 0.2 } });
  }
  const regimes = Object.fromEntries(events.map((e) => [e.date.slice(0, 7), "RATE"]));
  const { cells, walkForward } = analyse(events, regimes);
  assert.ok(cells["CPI|PANAS|RATE"].mean1d < 0); assert.equal(cells["CPI|PANAS|RATE"].confidence, "YAKIN");
  assert.ok(cells["CPI|DINGIN|ALL"].mean1d > 0);
  assert.ok(walkForward.accuracy > walkForward.baseline, JSON.stringify(walkForward));
  const line = insightLine({ years: 5, cells, walkForward }, "CPI m/m", "RATE");
  assert.match(line, /BACKTEST 5 THN/); assert.match(line, /CPI m\/m panas saat rezim RATE → XAU hari itu rata-rata -/); assert.match(line, /keyakinan YAKIN/); assert.match(line, /bukan konsensus/);
  assert.equal(insightLine({ years: 5, cells, walkForward }, "Germany Ifo", "RATE"), "");
});
test("runner walks every stage with a mocked network and resumes from disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bt-"));
  const now = Date.parse("2026-09-24T00:00:00Z");
  const days = Array.from({ length: 400 }, (_, i) => now - (400 - i) * DAY);
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (body, type = "application/json") => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": type } });
    if (u.includes("finance.yahoo")) return ok({ chart: { result: [{ timestamp: days.map((d) => d / 1000), indicators: { quote: [{ close: days.map((_, i) => 1800 + Math.sin(i) * 10 + i) }] } }] } });
    if (u.includes("fredgraph")) return ok("DATE,V\n" + days.map((d, i) => `${new Date(d).toISOString().slice(0, 10)},${(0.5 + Math.sin(i) * 0.1).toFixed(3)}`).join("\n"), "text/csv");
    if (u.includes("vintagedates")) return ok({ vintage_dates: ["2026-01-13", "2026-02-11"] });
    if (u.includes("observations")) { const d = new URL(u).searchParams.get("realtime_start"); return ok({ observations: [{ date: "2025-10-01", value: "100" }, { date: "2025-11-01", value: "100.2" }, { date: "2025-12-01", value: "100.4" }, { date: d === "2026-01-13" ? "2026-01-01" : "2026-01-01", value: "100.9" }] }); }
    if (u.includes("news.google")) return ok(`<rss><channel><item><title>Gold price jumps as Fed signals cuts - Reuters</title><link>https://x/1</link><pubDate>${new Date(Date.parse(new URL(u).searchParams.get("q").match(/after:(\S+)/)[1]) + DAY).toUTCString()}</pubDate></item></channel></rss>`, "application/rss+xml");
    return new Response("", { status: 404 });
  };
  const bt = new Backtest(dir, "KEY", 1, fetcher);
  for (let i = 0; i < 400; i++) await bt.step(now);
  const status = bt.status();
  assert.match(status, /BACKTEST 1 THN — selesai/);
  const r = bt.current();
  assert.ok(r.newsHeadlines > 0); assert.ok(Object.keys(r.regimeMonths).length > 0);
  assert.equal(r.events, RELEASES.length); // one real release per series; the second vintage has the same latest observation (revision day)
  const again = new Backtest(dir, "KEY", 1, fetcher);
  assert.equal(again.current().events, r.events);
});

test("without a FRED key the release history comes from ALFRED vintages: release day found by bisection", async () => {
  const { alfredPeriods, releaseWindow } = await import("../dist/brain-backtest.js");
  const dir = mkdtempSync(join(tmpdir(), "bt-alfred-"));
  const now = Date.parse("2026-09-24T00:00:00Z");
  const days = Array.from({ length: 400 }, (_, i) => now - (400 - i) * DAY);
  // Monthly data for month M is released on the 12th of M+1 (claims: the Thursday after the week-ending Saturday; GDP: the 28th after the quarter).
  const releaseOf = (id, obs) => {
    const d = new Date(`${obs}T00:00:00Z`);
    if (id === "ICSA") return new Date(d.getTime() + 5 * DAY).toISOString().slice(0, 10);
    d.setUTCMonth(d.getUTCMonth() + (id === "A191RL1Q225SBEA" ? 3 : 1)); d.setUTCDate(id === "A191RL1Q225SBEA" ? 28 : 12);
    return d.toISOString().slice(0, 10);
  };
  const obsList = (id) => {
    const out = [];
    if (id === "ICSA") { for (let t = Date.parse("2024-12-07T00:00:00Z"); t < now; t += 7 * DAY) out.push(new Date(t).toISOString().slice(0, 10)); return out; }
    const d = new Date("2024-09-01T00:00:00Z");
    for (; d.getTime() < now; d.setUTCMonth(d.getUTCMonth() + (id === "A191RL1Q225SBEA" ? 3 : 1))) out.push(d.toISOString().slice(0, 10));
    return out;
  };
  let probes = 0;
  const fetcher = async (url) => {
    const u = String(url);
    const ok = (body, type = "application/json") => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": type } });
    if (u.includes("finance.yahoo")) return ok({ chart: { result: [{ timestamp: days.map((d) => d / 1000), indicators: { quote: [{ close: days.map((_, i) => 1800 + Math.sin(i) * 10 + i) }] } }] } });
    if (u.includes("fred.stlouisfed.org/graph/fredgraph")) return ok("DATE,V\n" + days.map((d, i) => `${new Date(d).toISOString().slice(0, 10)},${(0.5 + Math.sin(i) * 0.1).toFixed(3)}`).join("\n"), "text/csv");
    if (u.includes("alfredgraph")) {
      probes++;
      const q = new URL(u).searchParams, id = q.get("id"), v = q.get("vintage_date");
      const rows = obsList(id).filter((o) => releaseOf(id, o) <= v).map((o, i) => `${o},${id === "ICSA" ? 220000 + (i % 5) * 1000 : 100 + i * 0.3}`);
      return ok(`observation_date,${id}_${v.replace(/-/g, "")}\n${rows.join("\n")}\n`, "application/csv");
    }
    if (u.includes("news.google")) return ok("<rss><channel></channel></rss>", "application/rss+xml");
    return new Response("", { status: 404 });
  };
  const bt = new Backtest(dir, undefined, 1, fetcher);
  for (let i = 0; i < 1500 && !/selesai/.test(bt.status()); i++) await bt.step(now);
  const lines = (await import("node:fs")).readFileSync(join(dir, "releases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cpi = lines.filter((e) => e.key === "CPI");
  assert.ok(cpi.length >= 10, `cpi ${cpi.length}`);
  assert.ok(cpi.every((e) => e.date.endsWith("-12")), JSON.stringify(cpi.map((e) => e.date)));
  assert.ok(lines.some((e) => e.key === "CORECPI" && e.date === cpi[0].date), "core read on the same release day");
  const claims = lines.filter((e) => e.key === "CLAIMS");
  assert.ok(claims.length >= 40 && claims.every((e) => new Date(`${e.date}T00:00:00Z`).getUTCDay() === 4), "claims on Thursdays");
  assert.ok(probes < 2600, `probes ${probes}`);
  assert.deepEqual(releaseWindow("W", "2026-09-19"), { lo: "2026-09-20", hi: "2026-09-28" });
  assert.equal(alfredPeriods("M", Date.parse("2026-06-15T00:00:00Z"), now)[0], "2026-04-01");
});
