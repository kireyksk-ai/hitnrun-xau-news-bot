import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { valueAt, move, correlation, realisedVol, stateAt, clearBrainMarketCache } from "../dist/brain-market.js";
import { evaluateRegime, detectShift, catalystOf, RegimeLedger } from "../dist/brain-regime.js";
import { EpisodeLedger, dueMarks, takeMark, marketContextAt } from "../dist/brain-episodes.js";
import { labelEpisode, threshold, LessonBook, lessonFrom } from "../dist/brain-labeler.js";
import { retrieveEpisodes, experiencePack, relevantLessons } from "../dist/brain-retrieval.js";
import { finalizeAction, DEFAULT_KNOBS, replayAction } from "../dist/brain-decision.js";
import { metrics, tradeStats, tradesOf, formatMetrics } from "../dist/brain-eval.js";
import { PolicyRegistry, effectiveAutonomy, riskHalt } from "../dist/brain-policy.js";
import { internalFrom } from "../dist/editor.js";
import { validateNewsOutput } from "../dist/news-output.js";
import { IntelligenceStore } from "../dist/intelligence-store.js";
import { processArticle } from "../dist/pipeline.js";
import { MarketBrain } from "../dist/brain.js";

const dir = () => mkdtempSync(join(tmpdir(), "brain-"));
const H = 3600_000, M = 60_000;

// ---------- synthetic Yahoo ----------
function yahooStub(pathFor) {
  return async (url) => {
    const u = new URL(String(url)); const symbol = decodeURIComponent(u.pathname.split("/").pop()); const interval = u.searchParams.get("interval");
    const bars = pathFor(symbol, interval);
    return { ok: true, status: 200, json: async () => ({ chart: { result: [{ timestamp: bars.map((b) => Math.floor(b[0] / 1000)), indicators: { quote: [{ close: bars.map((b) => b[1]) }] } }] } }) };
  };
}
function minuteBars(from, to, f) { const out = []; for (let t = Math.floor(from / M) * M; t <= to; t += M) out.push([t, f(t)]); return out; }

test("valueAt respects tolerance and ordering; move uses bp for yields", () => {
  const bars = [[0, 1], [60_000, 2], [120_000, 3]];
  assert.equal(valueAt(bars, 90_000), 2);
  assert.equal(valueAt(bars, 10 * 60_000, 60_000), undefined);
  assert.equal(move("US10Y", 4.1, 4.15).toFixed(1), "5.0");
  assert.equal(move("XAU", 100, 101), 1);
});

test("correlation and realised volatility are computed from aligned bars", () => {
  const t0 = Date.parse("2026-09-01T00:00:00Z");
  const a = [], b = [];
  for (let i = 0; i < 60; i++) { const x = Math.sin(i / 3); a.push([t0 + i * H, 100 + x]); b.push([t0 + i * H, 100 - x]); }
  assert.ok(correlation(a, b, t0).r < -0.9);
  assert.ok(realisedVol(minuteBars(t0, t0 + 70 * M, (t) => 100 + ((t / M) % 2) * 0.1), t0 + 70 * M, 60) > 0);
});

test("regime engine names the dollar driver, conflicts and confirmed shifts", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const hours = (f) => { const out = []; for (let i = 240; i >= 0; i--) out.push([now - i * H, f(i)]); return out; };
  const dxy = hours((i) => 100 + (240 - i) * 0.004 + Math.sin(i) * 0.05);
  const xau = hours((i) => 4400 - (240 - i) * 0.4 - Math.sin(i) * 3);
  const reading = evaluateRegime({ now, bars: { XAU: xau, DXY: dxy, US10Y: hours(() => 4.2), US2Y: hours(() => 3.9), WTI: hours(() => 80), SPX: hours(() => 6000), VIX: hours(() => 15) },
    catalystCounts: { GEOPOLITICS: 6, DOLLAR: 2 } });
  assert.equal(reading.primary, "DOLLAR");
  assert.ok(reading.scores.find((s) => s.regime === "DOLLAR").evidence[0].includes("corr XAU-DXY"));
  assert.ok(reading.conflicts.some((c) => c.includes("GEOPOLITICS")) || reading.supporting.length >= 0);
  const mk = (p, at) => ({ ...reading, primary: p, at });
  assert.equal(detectShift([mk("DOLLAR", "a"), mk("GEOPOLITICS", "b")]), undefined, "one reading is not a shift");
  assert.deepEqual(detectShift([mk("DOLLAR", "a"), mk("GEOPOLITICS", "b"), mk("GEOPOLITICS", "c")]), { at: "b", from: "DOLLAR", to: "GEOPOLITICS", confirmedAfterReadings: 2 });
  const ledger = new RegimeLedger(join(dir(), "r.json"));
  ledger.add(mk("DOLLAR", "a")); ledger.add(mk("GEOPOLITICS", "b")); const s = ledger.add(mk("GEOPOLITICS", "c"));
  assert.equal(s.to, "GEOPOLITICS"); assert.equal(ledger.confirmed(), "GEOPOLITICS");
  assert.equal(catalystOf("us-macro-cpi"), "INFLATION"); assert.equal(catalystOf("iran-gulf-conflict-hormuz"), "GEOPOLITICS"); assert.equal(catalystOf("us-macro-jobless-claims"), "LABOR");
});

function episode(over = {}) {
  return { id: over.id ?? Math.random().toString(36).slice(2), at: "2026-09-20T12:00:00.000Z", title: "Fed's Barr says more hikes likely", fact: "fed barr says more rate hikes likely inflation sticky",
    provider: "t", source: "Reuters", tier: 1, credibility: 95, storyKey: "fed-policy", catalyst: "FED", changeType: "NEW_INFORMATION", stage: "SENT", published: true,
    outcomeReason: "", reviewed: true, session: "NEW_YORK", regime: { primary: "RATES_FED", supporting: [], conflicts: [], confidence: 60 },
    market0: { XAU: 4300, DXY: 100 }, pre: { m15: { XAU: 0 }, m60: {} }, vol60: 0.03,
    decision: { action: "SELL", direction: "BEARISH", confidence: 70, horizonMinutes: 60, evidenceFor: [], evidenceAgainst: [] },
    finalAction: "SELL", guardrails: [], policyVersion: "v1", marks: {}, ...over };
}
const marks = (xs) => Object.fromEntries(Object.entries(xs).map(([k, v]) => [k, { at: "", state: {}, moves: { XAU: v, DXY: 0.1, US10Y: 2 } }]));

test("outcome labeler: correct, wrong, late, spike, reversed, timing, no reaction, missed", () => {
  const thr = threshold(60, 0.03);
  assert.equal(labelEpisode(episode({ marks: marks({ 1: -0.05, 5: -0.1, 15: -0.2, 60: -thr }) })).label, "CORRECT");
  assert.equal(labelEpisode(episode({ marks: marks({ 1: 0.05, 15: 0.1, 60: thr }) })).label, "WRONG");
  assert.equal(labelEpisode(episode({ pre: { m15: { XAU: -0.4 }, m60: {} }, marks: marks({ 15: 0, 60: -0.02 }) })).label, "LATE");
  assert.equal(labelEpisode(episode({ marks: marks({ 1: -0.3, 5: -0.35, 15: -0.1, 60: -0.05 }) })).label, "SPIKE_ONLY");
  assert.equal(labelEpisode(episode({ marks: marks({ 1: -0.3, 5: -0.2, 60: thr }) })).label, "REVERSED");
  assert.equal(labelEpisode(episode({ marks: marks({ 15: 0, 60: -0.02, 240: -1.0, 1440: -1.5 }) })).label, "RIGHT_DIRECTION_WRONG_TIMING");
  const flat = labelEpisode(episode({ marks: marks({ 15: 0.01, 60: 0.02 }) }));
  assert.equal(flat.label, "NO_REACTION"); assert.equal(flat.final, false, "not final before the 24h mark");
  assert.equal(labelEpisode(episode({ published: false, stage: "AI", decision: undefined, marks: marks({ 5: 0.4, 15: 0.5, 60: 0.6 }) })).label, "MISSED_MOVE");
  assert.equal(labelEpisode(episode({ published: false, stage: "AI", decision: undefined, marks: marks({ 5: 0.01, 60: 0.02 }) })).label, "CORRECT_REJECT");
});

test("lessons: concrete, reinforced on repeat, weakened by later correct calls, permanent on disk", () => {
  const path = join(dir(), "l.json"); const book = new LessonBook(path);
  const wrong = episode({ marks: marks({ 60: 0.6, 1440: 0.7 }) }); wrong.label = labelEpisode(wrong);
  assert.equal(wrong.label.label, "WRONG");
  const a = book.learn(wrong); assert.ok(a.created); assert.match(a.lesson.text, /Katalis FED saat rezim RATES_FED: arah bearish salah/);
  const b = book.learn({ ...wrong, id: "x2" }); assert.equal(b.created, false); assert.equal(b.lesson.support, 2);
  const right = episode({ marks: marks({ 60: -0.6, 1440: -0.7 }) }); right.label = labelEpisode(right); book.contradict(right);
  const reloaded = new LessonBook(path);
  assert.equal(reloaded.get(a.lesson.key).support, 2); assert.equal(reloaded.get(a.lesson.key).contradict, 1);
  assert.ok(reloaded.strength(reloaded.get(a.lesson.key)) < 1);
  const falseAlert = episode({ marks: marks({ 15: 0.01, 60: 0.0, 1440: 0.02 }) }); falseAlert.label = labelEpisode(falseAlert);
  assert.match(lessonFrom(falseAlert).key, /^FALSE_ALERT\|FED/);
});

test("retrieval prefers similar, recent, same-regime episodes and packs lessons", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const base = { label: { label: "WRONG", final: true, at: "", threshold: 0.3, note: "" } };
  const similarOld = episode({ id: "old", at: "2026-06-01T00:00:00Z", ...base });
  const similarNew = episode({ id: "new", at: "2026-09-20T00:00:00Z", ...base });
  const otherRegime = episode({ id: "geo", at: "2026-09-21T00:00:00Z", regime: { primary: "GEOPOLITICS", supporting: [], conflicts: [], confidence: 50 }, ...base });
  const unrelated = episode({ id: "oil", at: "2026-09-21T00:00:00Z", fact: "opec output cut crude", catalyst: "ENERGY", storyKey: "oil-supply", ...base });
  const found = retrieveEpisodes([similarOld, similarNew, otherRegime, unrelated], { fact: "fed barr says more hikes likely", catalyst: "FED", storyKey: "fed-policy", regime: "RATES_FED", session: "NEW_YORK", tier: 1, now });
  assert.equal(found[0].episode.id, "new");
  assert.ok(found.some((f) => f.episode.id === "old"));
  assert.ok(found.find((f) => f.episode.id === "new").score > found.find((f) => f.episode.id === "geo").score, "same regime outranks other regime at similar age");
  assert.ok(!found.some((f) => f.episode.id === "oil"));
  const book = new LessonBook(join(dir(), "l.json")); const w = episode({ marks: marks({ 60: 0.6, 1440: 0.7 }) }); w.label = labelEpisode(w); book.learn(w);
  const pack = experiencePack(found, relevantLessons(book, "FED", "RATES_FED"), book, now);
  assert.match(pack, /EXPERIENCE_PACK/); assert.match(pack, /LESSONS/); assert.match(pack, /hasil WRONG/);
});

test("guardrails never force a position and downgrade to WAIT / NO_TRADE", () => {
  const d = { action: "BUY", direction: "BULLISH", confidence: 75, horizonMinutes: 60, evidenceFor: [], evidenceAgainst: [] };
  const ok = { ok: true, fresh: ["XAU", "DXY", "US10Y"], stale: [], missing: [], note: "OK" };
  assert.equal(finalizeAction({ published: true, decision: d, health: ok, preMove15: 0 }, DEFAULT_KNOBS).action, "BUY");
  assert.equal(finalizeAction({ published: true, decision: { ...d, confidence: 55 }, health: ok }, DEFAULT_KNOBS).action, "WAIT");
  assert.equal(finalizeAction({ published: true, decision: d, health: { ...ok, ok: false, note: "XAU stale" } }, DEFAULT_KNOBS).action, "WAIT");
  assert.equal(finalizeAction({ published: true, decision: d, health: ok, preMove15: 0.4 }, DEFAULT_KNOBS).action, "WAIT");
  assert.equal(finalizeAction({ published: true, decision: { ...d, direction: "BEARISH" }, health: ok }, DEFAULT_KNOBS).action, "WAIT");
  assert.equal(finalizeAction({ published: false, decision: d, health: ok }, DEFAULT_KNOBS).action, "NO_TRADE");
  assert.equal(finalizeAction({ published: true, decision: d, health: ok, critic: { verdict: "DOWNGRADE", reasons: ["priced in"], pricedIn: true, preMoved: true, whipsawRisk: "HIGH", sourceIssue: false, crossMarketConflict: false } }, DEFAULT_KNOBS).action, "WAIT");
  assert.equal(finalizeAction({ published: true, decision: d, health: ok, killSwitch: true }, DEFAULT_KNOBS).action, "NO_TRADE");
  assert.equal(finalizeAction({ published: true, decision: d, health: ok, halted: "rugi harian" }, DEFAULT_KNOBS).action, "NO_TRADE");
});

test("evaluation: expectancy after cost, profit factor, drawdown, false alerts, calibration", () => {
  const eps = [
    episode({ id: "a", at: "2026-09-20T01:00:00Z", marks: marks({ 60: -0.5 }), label: { label: "CORRECT", final: true } }),
    episode({ id: "b", at: "2026-09-20T02:00:00Z", marks: marks({ 60: 0.3 }), label: { label: "WRONG", final: true } }),
    episode({ id: "c", at: "2026-09-20T03:00:00Z", finalAction: "WAIT", marks: marks({ 60: 0.01 }), label: { label: "NO_REACTION", final: true } })
  ];
  const t = tradesOf(eps, 0.03); assert.equal(t.length, 2);
  const s = tradeStats(t);
  assert.equal(+s.expectancy.toFixed(3), +(((0.5 - 0.03) + (-0.3 - 0.03)) / 2).toFixed(3));
  assert.equal(+s.maxDrawdown.toFixed(2), 0.33);
  const m = metrics(eps, 0.03);
  assert.equal(m.falseAlerts, 1); assert.equal(m.trades, 2); assert.equal(m.waits, 1);
  assert.match(formatMetrics(m, "T"), /expectancy/); assert.match(formatMetrics(m, "T"), /bukan sinyal trading/);
});

test("policy: candidate replayed, needs samples, owner approval, rollback, autonomy and risk halt", () => {
  const reg = new PolicyRegistry(join(dir(), "p.json"));
  assert.equal(reg.active().id, "v1");
  const cand = reg.propose({ minTradeConfidence: 75 }, "", "high-confidence only");
  assert.equal(cand.status, "CANDIDATE"); assert.equal(reg.propose({}, "", "x"), undefined, "one candidate at a time");
  // 50 labeled episodes: confidence 70 calls lose, 80 calls win -> raising the bar is better.
  const eps = [];
  for (let i = 0; i < 50; i++) {
    const win = i % 2 === 0;
    eps.push(episode({ id: `e${i}`, at: new Date(Date.parse("2026-09-01T00:00:00Z") + i * H).toISOString(), health: { ok: true, fresh: ["XAU"], stale: [], missing: [], note: "OK" },
      decision: { action: "SELL", direction: "BEARISH", confidence: win ? 80 : 70, horizonMinutes: 60, evidenceFor: [], evidenceAgainst: [] },
      marks: marks({ 60: win ? -0.5 : 0.4 }), label: { label: win ? "CORRECT" : "WRONG", final: true } }));
  }
  assert.equal(replayAction(eps[1], { ...DEFAULT_KNOBS, minTradeConfidence: 75 }), "WAIT");
  const small = reg.evaluate(eps.slice(0, 10)); assert.match(small.verdict, /SAMPLE_KURANG/);
  const more = []; for (let i = 0; i < 4; i++) more.push(...eps.map((e) => ({ ...e, id: `${e.id}-${i}` })));
  const ev = reg.evaluate(more); assert.equal(ev.verdict, "LEBIH_BAIK"); assert.equal(reg.candidate().status, "READY_FOR_APPROVAL");
  assert.equal(reg.active().id, "v1", "never promoted without the owner");
  assert.match(reg.approve("v2"), /aktif/); assert.equal(reg.active().id, "v2"); assert.equal(reg.active().knobs.minTradeConfidence, 75);
  assert.match(reg.rollback("v1", "test"), /rollback ke v1/); assert.equal(reg.active().id, "v1");
  assert.ok(reg.log().some((l) => l.event === "ROLLBACK"));
  assert.equal(effectiveAutonomy("LIVE", { trades: 10, expectancy: 0.1, profitFactor: 2, maxDrawdown: 1 }).level, "SHADOW");
  assert.match(effectiveAutonomy("LIVE", { trades: 10, expectancy: 0.1, profitFactor: 2, maxDrawdown: 1 }).note, /LIVE ditolak/);
  assert.equal(effectiveAutonomy("DEMO", { trades: 150, expectancy: 0.05, profitFactor: 1.4, maxDrawdown: 2 }).level, "DEMO");
  const now = Date.parse("2026-09-23T05:00:00Z");
  assert.match(riskHalt([{ at: "2026-09-23T01:00:00Z", net: -0.7 }, { at: "2026-09-23T02:00:00Z", net: -0.5 }], now, { dailyLossPct: 1, maxDrawdownPct: 5 }), /rugi harian/);
  assert.equal(riskHalt([{ at: "2026-09-20T01:00:00Z", net: 0.7 }], now, { dailyLossPct: 1, maxDrawdownPct: 5 }), undefined);
});

test("Sol's internal assessment is parsed and never allowed into the NEWS text", () => {
  const d = { material: true, confidence: "high", reason: "r", judul: "a", ringkasan: "b", dampakEmas: "c", potensiArah: "BEARISH", keyakinan: 72, horizonJam: 4,
    keputusanInternal: "sell", buktiPendukung: ["DXY naik"], buktiBertentangan: ["Iran"], kondisiAktivasi: "yield lanjut naik", invalidasi: "DXY balik turun", risikoUtama: "headline Iran",
    katalisBerikutnya: "claims", alasanPasar: "pasar fokus Fed", bedaDenganMasaLalu: "dulu rezim geopolitik", narasiDominan: "Fed hawkish" };
  const i = internalFrom(d);
  assert.equal(i.action, "SELL"); assert.equal(i.direction, "BEARISH"); assert.equal(i.horizonMinutes, 240); assert.deepEqual(i.evidenceFor, ["DXY naik"]);
  assert.equal(internalFrom({ ...d, material: false, potensiArah: null, keputusanInternal: null }).action, "NO_TRADE");
  const msg = "<b>⚠️ Barr Nambahin Bensin Hawkish</b>\n\nBarr barusan ngomong kenaikan kemaren blm cukup. Inflasi masih bandel, pasar kerja jg udah gk jadi alasan buat nahan, jadi pintu naik lg masih kebuka lebar.\n\nIntinya yield sama DXY naik bareng dan gold ketekan dari dua sisi. Buyer gold ada kok tp lg dipaksa ngelawan arus market. Keputusan SELL dulu selama Fed masih kompak hawkish kayak gini.";
  const article = { provider: "t", providerId: "x", title: "Fed's Barr", summary: "", url: "https://x.test", publishedAt: new Date() };
  assert.equal(validateNewsOutput(msg, article).ok, false);
});

const news = "<b>⚠️ DIPLOMASI IRAN BERUBAH</b>\n\nTrump membuka peluang pertemuan langsung dengan Presiden Iran. Ini merupakan perkembangan baru karena jalur diplomasi resmi kini kembali dibicarakan di tengah konflik yang masih berjalan.\n\nDampak ke emas: premi safe haven bisa menipis kalau jalur diplomasi makin nyata, tapi dolar dan yield tetap perlu dipantau karena pasar belum yakin konflik benar-benar mereda.";
function pipelineSetup(critic) {
  const store = new IntelligenceStore(join(dir(), "state.json"));
  const deliveries = [];
  const primary = { material: true, reason: "Diplomacy changes conflict path", telegramMessage: news, internal: { action: "SELL", direction: "BEARISH", confidence: 70, horizonMinutes: 60, evidenceFor: [], evidenceAgainst: [] } };
  const deps = { store, analyze: async () => primary, shadow: async () => ({ material: true, score: 90, reason: "new" }), critic,
    deliver: async (m) => { deliveries.push(m); return { chat: 12 }; }, now: () => new Date("2026-09-22T00:01:00Z") };
  const article = { provider: "test", providerId: "p1", title: "Trump says he is open to meeting Iran's president", summary: "", url: "https://example.test", publishedAt: new Date("2026-09-22T00:00:00Z"), sourceName: "Reuters" };
  return { deps, deliveries, article };
}

test("critic: only a source issue can block; other objections downgrade while the news still goes out", async () => {
  const soft = pipelineSetup(async () => ({ verdict: "BLOCK", reasons: ["priced in"], pricedIn: true, preMoved: true, whipsawRisk: "HIGH", sourceIssue: false, crossMarketConflict: false }));
  const r1 = await processArticle(soft.article, soft.deps);
  assert.equal(r1.stage, "SENT"); assert.equal(r1.brain.critic.verdict, "DOWNGRADE"); assert.equal(r1.brain.internal.action, "SELL");
  const hard = pipelineSetup(async () => ({ verdict: "BLOCK", reasons: ["salah atribusi"], pricedIn: false, preMoved: false, whipsawRisk: "LOW", sourceIssue: true, crossMarketConflict: false }));
  const r2 = await processArticle(hard.article, hard.deps);
  assert.equal(r2.stage, "CRITIC"); assert.equal(hard.deliveries.length, 0);
  const broken = pipelineSetup(async () => { throw new Error("down"); });
  const r3 = await processArticle(broken.article, broken.deps);
  assert.equal(r3.stage, "SENT"); assert.equal(r3.brain.critic.verdict, "SKIPPED");
});

test("closed loop end-to-end: episode -> marks -> label -> lesson -> retrieved in the next decision; restart-safe", async () => {
  const realFetch = globalThis.fetch;
  const now = Date.now();
  const newsAt = now - 26 * H;
  // Gold rises after a Fed headline the brain called BEARISH -> WRONG -> lesson.
  globalThis.fetch = yahooStub((symbol, interval) => {
    const step = interval === "60m" ? H : interval === "5m" ? 5 * M : M;
    const out = []; for (let t = Math.floor((now - 5 * 86400_000) / step) * step; t <= now; t += step) {
      const after = Math.max(0, (t - newsAt) / M);
      const v = symbol === "GC=F" ? 4300 + Math.min(after, 600) * 0.5 : symbol === "DX-Y.NYB" ? 100 - Math.min(after, 600) * 0.0005 : symbol === "^TNX" ? 4.2 : symbol === "CL=F" ? 80 : symbol === "^VIX" ? 15 : symbol === "^GSPC" ? 6000 : 3.9;
      out.push([t, v]);
    }
    return out;
  });
  clearBrainMarketCache();
  try {
    const base = dir(); const store = new IntelligenceStore(join(base, "state.json"));
    const editor = { lesson: async () => ({ lesson: "Kalau DXY melemah saat headline Fed hawkish, jangan buru-buru bearish emas.", conditions: "katalis FED, DXY turun" }), critic: async () => ({ verdict: "PASS", reasons: [], pricedIn: false, preMoved: false, whipsawRisk: "LOW", sourceIssue: false, crossMarketConflict: false }) };
    const reports = [];
    const brain = new MarketBrain(store, editor, { basePath: join(base, "bot"), autonomy: "SHADOW", killSwitch: false, aiCallsPerDay: 10, dailyLossPct: 1, maxDrawdownPct: 5, report: async (t) => { reports.push(t); } });
    await brain.regimeTick(true);
    assert.ok(brain.regime.current(), "regime reading stored");
    const record = { id: "evt1", article: { provider: "t", providerId: "1", title: "Fed's Barr says further hikes likely", summary: "", url: "https://x", publishedAt: new Date(newsAt), sourceName: "Reuters" },
      event: { key: "evt1", storyKey: "fed-policy", fact: "fed barr says further rate hikes likely inflation", sourceTier: 1, changeType: "NEW_INFORMATION", firstSeenAt: new Date(newsAt).toISOString() },
      stage: "SENT", primaryDecision: "SEND", reason: "hawkish", audit: { aiCalled: true },
      brain: { internal: { action: "SELL", direction: "BEARISH", confidence: 72, horizonMinutes: 60, evidenceFor: ["hawkish"], evidenceAgainst: [] }, critic: { verdict: "PASS", reasons: [], pricedIn: false, preMoved: false, whipsawRisk: "LOW", sourceIssue: false, crossMarketConflict: false } } };
    await brain.onResult(record);
    // Move the episode back in time to the news moment, as if created then.
    const e = brain.episodes.get("evt1");
    const ctx = await marketContextAt(newsAt);
    brain.episodes.upsert({ ...e, at: new Date(newsAt).toISOString(), ...ctx });
    assert.equal(brain.episodes.get("evt1").finalAction, "SELL");
    assert.deepEqual(dueMarks(brain.episodes.get("evt1"), now), [1, 5, 15, 30, 60, 240, 1440]);
    await brain.markTick();
    const done = brain.episodes.get("evt1");
    assert.ok(done.marks["60"].moves.XAU > 0.5, "gold rose after the call");
    assert.ok(done.marks["60"].moves.DXY < 0, "cross-asset reaction recorded");
    assert.equal(done.label.label, "WRONG"); assert.equal(done.label.final, true);
    const lessons = brain.lessons.all();
    assert.equal(lessons.length, 1); assert.match(lessons[0].key, /^WRONG\|FED\|/); assert.match(lessons[0].solText, /DXY melemah/);
    // The next similar decision retrieves the episode and the lesson.
    const pack = brain.contextFor({ key: "evt2", storyKey: "fed-policy", fact: "fed barr repeats further rate hikes likely", sourceTier: 1 }, { title: "Fed's Barr repeats hikes", summary: "" });
    assert.match(pack, /hasil WRONG/); assert.match(pack, /DXY melemah/); assert.match(pack, /REGIME/);
    // Restart safety: everything reloads from disk.
    brain.flush();
    const again = new MarketBrain(store, editor, { basePath: join(base, "bot"), autonomy: "SHADOW", killSwitch: false, aiCallsPerDay: 10, dailyLossPct: 1, maxDrawdownPct: 5, report: async () => {} });
    assert.equal(again.episodes.get("evt1").label.label, "WRONG"); assert.equal(again.lessons.all().length, 1);
    assert.ok(readdirSync(base).some((f) => f.includes(".bak-")), "migration backup written");
    assert.match(again.status(), /Market Brain/);
  } finally { globalThis.fetch = realFetch; clearBrainMarketCache(); }
});

test("episode ledger persists across restarts and prunes lite episodes", () => {
  const path = join(dir(), "e.json");
  const l = new EpisodeLedger(path); l.upsert(episode({ id: "keep" })); l.flush();
  assert.ok(existsSync(path)); assert.equal(new EpisodeLedger(path).get("keep").id, "keep");
});

test("stateAt/takeMark read point-in-time values from a stubbed feed", async () => {
  const t0 = Date.now() - 2 * H;
  const fetcher = yahooStub(() => minuteBars(Date.now() - 3 * H, Date.now(), (t) => 100 + (t - t0) / M * 0.01));
  clearBrainMarketCache();
  const s = await stateAt(t0 + 60 * M, fetcher);
  assert.ok(Math.abs(s.XAU - 100.6) < 0.02);
  const e = episode({ at: new Date(t0).toISOString(), market0: { XAU: 100 } });
  const mark = await takeMark(e, 60, Date.now(), fetcher);
  assert.ok(Math.abs(mark.moves.XAU - 0.6) < 0.05);
  clearBrainMarketCache();
});
