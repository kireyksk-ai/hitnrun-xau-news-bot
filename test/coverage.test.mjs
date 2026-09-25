import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatFunnel, formatTrace, funnel, readArchive, referenceAudit, traceHeadline } from "../dist/coverage.js";
import { calendarMatch, extractFacts, needsFacts } from "../dist/article-facts.js";

const day = "2026-09-24";
const entry = (provider, id, title, at = `${day}T13:46:00.000Z`) => ({ fetchedAt: at, provider, item: { providerId: id, title, summary: "", url: `https://x/${id}` } });
const rec = (provider, id, title, stage, reason, extra = {}) => ({ id: `${id}-key-000000`, article: { provider, providerId: id, title, summary: "", url: "", publishedAt: `${day}T13:45:00.000Z` },
  event: { sourceTier: stage === "SOURCE" ? 3 : 1 }, stage, primaryDecision: stage === "SENT" ? "SEND" : "DROP", reason, audit: { prefilter: "REVIEW", aiCalled: stage !== "DUPLICATE" }, ...extra });

test("trace separates not found, held (tier 3), rejected and sent", () => {
  const archive = [entry("twitter-wire", "a", "US S&P Global Manufacturing PMI 58.4 vs 52.0 expected"), entry("benzinga", "b", "CFO survey: 5.3% expect recession"),
    entry("newsapi-wires", "c", "Houthis threaten Saudi oil facilities")];
  const records = [rec("twitter-wire", "a", archive[0].item.title, "SOURCE", "Tier-3 source needs independent corroboration"),
    rec("benzinga", "b", archive[1].item.title, "AI", "HARD_FILTER_REJECT: low"), rec("newsapi-wires", "c", archive[2].item.title, "SENT", "ok", { sentAt: `${day}T13:50:00.000Z` })];
  const pmi = traceHeadline("S&P Global US Manufacturing PMI 58.4", archive, records);
  assert.equal(pmi.status, "DITAHAN"); assert.equal(pmi.matches[0].tier, 3); assert.match(formatTrace("PMI 58.4", pmi), /Tier-3 source/);
  assert.equal(traceHeadline("Houthis threaten Saudi oil", archive, records).status, "TERKIRIM");
  assert.equal(traceHeadline("CFO survey recession 5.3%", archive, records).status, "DITOLAK");
  const none = traceHeadline("Japan intervenes in yen market", archive, records);
  assert.equal(none.status, "TIDAK_DITEMUKAN"); assert.match(formatTrace("Japan", none), /cakupan sumber/);
  // A number in the query must match: PMI 61.0 is a different fact from 58.4.
  assert.equal(traceHeadline("US Manufacturing PMI 61.0", archive, records).status, "TIDAK_DITEMUKAN");
});
test("funnel counts every stage per provider and the reference audit reports holes", () => {
  const archive = [entry("twitter-wire", "a", "PMI 58.4 beats"), entry("benzinga", "b", "CFO survey recession"), entry("newsapi-wires", "c", "Houthis threaten Saudi oil")];
  const records = [rec("twitter-wire", "a", "PMI 58.4 beats", "SOURCE", "Tier-3 source needs independent corroboration", { factsStatus: "HEADLINE_ONLY" }),
    rec("benzinga", "b", "CFO survey recession", "AI", "Not material", { factsStatus: "FULL" }), rec("newsapi-wires", "c", "Houthis threaten Saudi oil", "SENT", "ok", { sentAt: `${day}T13:50:00.000Z`, factsStatus: "FULL" })];
  const f = funnel(day, archive, records);
  assert.equal(f.stages.fetched, 3); assert.equal(f.stages.judgedBySol, 3); assert.equal(f.stages.sent, 1);
  assert.equal(f.withFacts, 2); assert.equal(f.headlineOnly, 1);
  assert.deepEqual(f.providers.find((p) => p.provider === "twitter-wire"), { provider: "twitter-wire", fetched: 1, toSol: 1, sent: 0, held: 1 });
  const audit = referenceAudit([{ title: "Houthis threaten Saudi oil facilities - Reuters" }, { title: "Fed's Waller says rate cuts can wait - CNBC" }, { title: "Celebrity wedding photos" }], archive, records);
  assert.equal(audit.total, 2); assert.equal(audit.byStatus.TERKIRIM, 1); assert.deepEqual(audit.missing, ["Fed's Waller says rate cuts can wait"]);
  const text = formatFunnel(f, audit);
  assert.match(text, /Sumber 3 item unik .* TERKIRIM 1/); assert.match(text, /TIDAK DITEMUKAN \(lubang sumber\)/); assert.match(text, /Tier-3 source/);
});
test("archive reader keeps one entry per provider item across repeated polls", () => {
  const dir = mkdtempSync(join(tmpdir(), "raw-"));
  const line = (e) => JSON.stringify(e) + "\n";
  writeFileSync(join(dir, `${day}.jsonl`), line(entry("benzinga", "b", "x")) + line(entry("benzinga", "b", "x")) + line(entry("twitter-wire", "a", "y")) + "{broken");
  assert.equal(readArchive(dir, new Date(`${day}T20:00:00Z`), 1).length, 2);
});
test("facts extractor keeps the sentences with numbers and comparisons, calendar match adds the official print", () => {
  const html = `<html><body><nav>Menu 123</nav><article><p>Markets were busy on Thursday as traders digested a range of news items.</p>
    <p>The S&P Global flash US manufacturing PMI rose to 58.4 in September from 53.0, well above the 52.0 economists had expected.</p>
    <p>Input prices climbed at the fastest pace in two years, the survey showed, while new orders jumped.</p><p>Read more about our coverage policies here and there.</p></article></body></html>`;
  const facts = extractFacts(html);
  assert.match(facts, /58\.4 in September from 53\.0, well above the 52\.0/);
  assert.doesNotMatch(facts, /Menu|coverage policies/);
  assert.equal(needsFacts("PMI jumps", "short"), true);
  assert.equal(needsFacts("PMI 58.4", "x".repeat(450) + " 58.4"), false);
  const ev = { id: "p", name: "S&P Global Manufacturing PMI", country: "US", releaseAt: "2026-09-24T13:45:00Z", consensus: "52.0", prior: "53.0", actual: "58.4", impact: "medium", url: "" };
  assert.match(calendarMatch("US manufacturing PMI surges to 58.4", [ev], Date.parse("2026-09-24T14:00:00Z")), /aktual 58\.4, perkiraan 52\.0, sebelumnya 53\.0/);
  assert.equal(calendarMatch("Gold rises on Iran", [ev], Date.parse("2026-09-24T14:00:00Z")), "");
});
