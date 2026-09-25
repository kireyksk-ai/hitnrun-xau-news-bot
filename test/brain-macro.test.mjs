import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateLinkage, updateOfficial, fireRules, learnedConfidence, ruleDisabled, resolveFire, aggregate, statsFrom, battle, ruleContext, macroBrief, MACRO_GUIDE } from "../dist/brain-macro.js";
import { parseNum, familyOf, expectedBias, surpriseZ, reactionStats, historyLine, CalendarHistory } from "../dist/brain-calendar.js";
import { clearBrainMarketCache } from "../dist/brain-market.js";

const D = 86400_000, now = Date.parse("2026-09-23T12:00:00Z");
const days = (n, f) => { const out = []; for (let i = n; i >= 0; i--) out.push([now - i * D + 13 * 3600_000 - 12 * 3600_000, f(n - i)]); return out; };
const wave = (i) => Math.sin(i * 1.3) + Math.cos(i * 0.7);

test("linkage: gold trading against yields = RATE; with yields + high 30Y + reserve buying = CB", () => {
  const rate = evaluateLinkage({ now, daily: { XAU: days(40, (i) => 4300 - wave(i) * 20), US10Y: days(40, (i) => 4.2 + wave(i) * 0.05), DXY: days(40, (i) => 100 + wave(i) * 0.3), US30Y: days(40, () => 4.4) }, goldFlowNews30d: 0, geoShare7d: 0, geoSharePrev7d: 0 });
  assert.equal(rate.regime, "RATE"); assert.ok(rate.score > 0.3);
  const cb = evaluateLinkage({ now, daily: { XAU: days(40, (i) => 4300 + wave(i) * 20), US10Y: days(40, (i) => 4.2 + wave(i) * 0.05), DXY: days(40, (i) => 100 + wave(i) * 0.3), US30Y: days(40, () => 5.2) }, goldFlowNews30d: 10, geoShare7d: 0.3, geoSharePrev7d: 0.1 });
  assert.equal(cb.regime, "CB"); assert.ok(cb.score < -0.3);
  assert.ok(cb.unavailable.some((u) => u.includes("debt/GDP")), "unavailable inputs are stated, not guessed");
});

test("official linkage switch needs 72h, fast-switches on a 30Y shock, and learns from false switches", () => {
  const r = (h, regime) => ({ at: new Date(now + h * 3600_000).toISOString(), score: regime === "CB" ? -0.5 : 0.5, regime, confidence: 0.7, signals: [], unavailable: [] });
  let state = { official: "RATE", since: new Date(now).toISOString(), threshold: 0.3, falseSwitches: [], history: [], switches: [] };
  for (let h = 0; h <= 48; h += 12) { const u = updateOfficial(state, r(h, "CB")); state = u.state; assert.equal(u.switched, undefined); }
  for (let h = 60; h <= 72; h += 12) state = updateOfficial(state, r(h, "CB")).state;
  assert.equal(state.official, "CB", "held 72h");
  const fast = updateOfficial(state, r(73, "RATE"), 55);
  assert.equal(fast.state.official, "RATE"); assert.equal(fast.switched.fast, true);
  assert.equal(fast.state.falseSwitches.length, 1, "switch back within 48h = false switch"); assert.equal(fast.state.threshold, 0.4);
});

test("rule chain: rate-up is bearish only in RATE, cancelled (bullish) in CB; oil spike R1; learned confidence and disabling", () => {
  const base = { now, xau: 4300, geoShare7d: 0.1, geoSharePrev7d: 0.1 };
  assert.deepEqual(fireRules({ ...base, regime: "RATE", fedImplied5d: 20 }, [], {}).map((f) => `${f.rule}:${f.bias}`), ["R3:BEARISH"]);
  assert.deepEqual(fireRules({ ...base, regime: "CB", fedImplied5d: 20 }, [], {}).map((f) => `${f.rule}:${f.bias}`), ["R4:BULLISH"]);
  assert.deepEqual(fireRules({ ...base, regime: "RATE", oil24h: 4, oilZ30: 2 }, [], {}).map((f) => f.rule), ["R1"]);
  assert.deepEqual(fireRules({ ...base, regime: "CB", oil24h: 4, oilZ30: 2 }, [], {}).map((f) => `${f.rule}:${f.bias}`), ["R1:NEUTRAL"], "oil spike in CB = neutral (central banks absorb)");
  assert.deepEqual(fireRules({ ...base, regime: "RATE", us30y: 5.4, us30y5d: 10 }, [], {}).map((f) => `${f.rule}:${f.bias}`), ["R8:BULLISH"]);
  const withFiscal = aggregate([{ rule: "R1", bias: "BEARISH", confidence: 0.65 }, { rule: "R8", bias: "BULLISH", confidence: 0.6 }], {});
  assert.equal(withFiscal.bias, "BULLISH", "30Y > 5.3% overrides the oil rule");
  assert.equal(fireRules({ ...base, regime: "RATE", oil24h: 6, geoShare7d: 0.4, geoSharePrev7d: 0.1 }, [], {}).find((f) => f.rule === "R5").bias, "BEARISH");
  assert.equal(fireRules({ ...base, regime: "RATE", oil24h: 0.5, geoShare7d: 0.4, geoSharePrev7d: 0.1 }, [], {}).find((f) => f.rule === "R5").bias, "BULLISH");
  const once = fireRules({ ...base, regime: "RATE", fedImplied5d: 20 }, [], {});
  assert.equal(fireRules({ ...base, regime: "RATE", fedImplied5d: 20 }, once, {}).length, 0, "no refire within 12h");
  assert.equal(learnedConfidence(0.6, { n: 20, hits: 16 }), 0.7);
  assert.ok(ruleDisabled({ n: 30, hits: 10 }));
  const fired = once[0];
  assert.equal(resolveFire(fired, 4250, now + 1 * 3600_000).resolved, undefined, "not before horizon");
  const done = resolveFire(fired, 4250, now + 121 * 3600_000);
  assert.equal(done.correct, true); assert.equal(statsFrom([done]).R3.hits, 1);
  const agg = aggregate([{ ...fired, confidence: 0.6 }, { ...fired, rule: "R9", bias: "BEARISH", confidence: 0.5 }], {});
  assert.equal(agg.bias, "BEARISH");
});

test("battle tracker and context from daily bars", () => {
  const daily = { XAU: days(70, (i) => 4000 + i * 5), WTI: days(40, (i) => i === 40 ? 90 : 80 + (i % 3) * 0.2), FEDFUNDS: days(10, (i) => 96 - (i >= 8 ? 0.25 : 0)), US10Y: days(10, (i) => 4.2 + i * 0.02), US30Y: days(10, () => 5.1), DXY: days(10, () => 100) };
  const ctx = ruleContext(now, "RATE", daily, 0.1, 0.05);
  assert.ok(ctx.oil24h > 10); assert.ok(ctx.oilZ30 > 1.5); assert.equal(Math.round(ctx.fedImplied5d), 25);
  const link = { at: "", score: 0.5, regime: "RATE", confidence: 0.7, signals: [], unavailable: [] };
  const b = battle(ctx, link, 2, ctx.xau20d, ctx.xauZ20);
  assert.equal(b.camps.length, 4); assert.equal(b.camps[1].direction, "BEARISH");
  const brief = macroBrief({ at: "", linkage: link, official: "RATE", officialSince: new Date(now).toISOString(), threshold: 0.3, rules: { bias: "BEARISH", confidence: 0.6, votes: [], active: [] }, battle: b, unavailable: ["x"] });
  assert.match(brief, /MACRO_LINKAGE: rezim resmi RATE/); assert.match(brief, /BATTLE/); assert.match(MACRO_GUIDE, /not automatically bullish/);
});

test("calendar history: parse, family, regime-aware bias, surprise z, reaction stats", async () => {
  assert.equal(parseNum("3.2%"), 3.2); assert.equal(parseNum("-225K"), -225); assert.equal(parseNum(null), null);
  assert.equal(familyOf("CPI YoY"), "INFLATION"); assert.equal(familyOf("Nonfarm Payrolls"), "LABOR"); assert.equal(familyOf("Unemployment Rate"), "UNEMPLOYMENT");
  assert.equal(expectedBias("INFLATION", 0.2, "RATE"), "BEARISH"); assert.equal(expectedBias("INFLATION", 0.2, "CB"), "MIXED");
  assert.equal(expectedBias("UNEMPLOYMENT", 0.2, "RATE"), "BULLISH"); assert.equal(expectedBias("LABOR", 20, "RATE", "Initial Jobless Claims"), "BULLISH");
  const hist = [0.1, -0.2, 0.3, -0.1, 0.2].map((s, i) => ({ name: "CPI YoY", family: "INFLATION", surprise: s, resolved: true, xau5: -s * 2 }));
  assert.ok(surpriseZ(hist, "CPI YoY", 0.4) > 1);
  const st = reactionStats(hist, "CPI YoY", "INFLATION");
  assert.equal(st.beat.n, 3); assert.ok(st.beat.avg5 < 0); assert.match(historyLine(hist, { name: "CPI YoY" }), /di atas perkiraan → XAU 5m rata-rata -/);
  const t = Date.now() - 2 * 3600_000; const M = 60_000;
  const fetcher = async (url) => { const bars = []; for (let x = t - 30 * M; x <= Date.now(); x += M) bars.push([x, x < t ? 4300 : 4280]);
    return { ok: true, json: async () => ({ chart: { result: [{ timestamp: bars.map((b) => Math.floor(b[0] / 1000)), indicators: { quote: [{ close: bars.map((b) => b[1]) }] } }] } }) }; };
  clearBrainMarketCache();
  const ch = new CalendarHistory(join(mkdtempSync(join(tmpdir(), "cal-")), "c.json"));
  const added = ch.observe([{ id: "e1", name: "CPI YoY", country: "US", releaseAt: new Date(t).toISOString(), consensus: "3.0%", prior: "2.9%", actual: "3.3%", impact: "high", url: "" }], "RATE");
  assert.equal(added[0].surprise, 0.3); assert.equal(added[0].expectedBias, "BEARISH");
  const res = await ch.resolve(Date.now(), fetcher);
  assert.equal(res.length, 1); assert.ok(res[0].xau5 < -0.4);
  clearBrainMarketCache();
});

test("raw archive appends fetched items to a daily JSONL file", async () => {
  const { RawArchive } = await import("../dist/brain-store.js");
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = join(mkdtempSync(join(tmpdir(), "raw-")), "raw");
  const a = new RawArchive(dir); a.append("benzinga", { title: "x" }, new Date("2026-09-23T01:00:00Z"));
  const f = readdirSync(dir)[0]; assert.equal(f, "2026-09-23.jsonl");
  assert.equal(JSON.parse(readFileSync(join(dir, f), "utf8").trim()).item.title, "x");
});
