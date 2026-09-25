import test from "node:test";
import assert from "node:assert/strict";
import { parseInvestingLive } from "../dist/providers/investinglive.js";
import { sourceTier } from "../dist/event-intelligence.js";

const item = (title, date, desc = "") => `<item><title><![CDATA[${title}]]></title><link>https://investinglive.com/x/${encodeURIComponent(title)}</link><pubDate>${date}</pubDate><description><![CDATA[<p>${desc}</p>]]></description></item>`;
const xml = `<?xml version="1.0"?><rss><channel>${[
  item("Fed's Williams: Persistent supply shocks are making the inflation fight harder", "Fri, 25 Sep 2026 10:13:35 +0000"),
  item("US August durable goods orders 0.0% vs -0.4% expected", "Fri, 25 Sep 2026 12:30:12 +0000"),
  item("USTR's Greer: We have reached agreements with China on a sub-set of goods", "Fri, 25 Sep 2026 12:47:20 +0000"),
  item("Why risk management in trading matters if you want to stay in the game", "Fri, 25 Sep 2026 07:10:05 +0000"),
  item("This Nasdaq 100 technical analysis slightly favors the bears for today", "Fri, 25 Sep 2026 07:53:22 +0000"),
  item("Ethereum struggles amid macro headwinds, but renewed US-Iran hopes limit the downside", "Fri, 25 Sep 2026 09:19:18 +0000"),
  item("Fed's Hammack: old story", "Thu, 24 Sep 2026 10:00:00 +0000")
].join("")}</channel></rss>`;

test("investingLive keeps Fed speakers, data prints and policy lines; drops education, TA, crypto and old items", () => {
  const got = parseInvestingLive(xml, new Date("2026-09-25T00:00:00Z"));
  assert.deepEqual(got.map((a) => a.title), [
    "Fed's Williams: Persistent supply shocks are making the inflation fight harder",
    "US August durable goods orders 0.0% vs -0.4% expected",
    "USTR's Greer: We have reached agreements with China on a sub-set of goods"
  ]);
  assert.equal(got[1].publishedAt.toISOString(), "2026-09-25T12:30:12.000Z");
  assert.equal(got[0].provider, "investinglive");
  assert.equal(sourceTier(got[0]), 2, "treated as a credible fast desk");
});

test("calendar hunts search newsroom wording, not calendar titles", async () => {
  const { huntQuery, formatSpeechQuiet } = await import("../dist/economic-calendar.js");
  const ev = (name, country = "USD") => ({ id: "x", name, country, releaseAt: "2026-09-25T13:20:00Z", consensus: null, prior: null, actual: null, impact: "high", url: "" });
  assert.equal(huntQuery(ev("FOMC Member Schmid Speaks")).query, "Fed Schmid");
  assert.equal(huntQuery(ev("FOMC Member Schmid Speaks")).minutes, 180);
  assert.equal(huntQuery(ev("ECB President Lagarde Speaks", "EUR")).query, "ECB Lagarde");
  const data = { ...ev("Core Durable Goods Orders m/m"), consensus: "0.6%", prior: "0.2%" };
  assert.equal(huntQuery(data).query, '"Core Durable Goods Orders" US');
  const quiet = formatSpeechQuiet(ev("FOMC Member Schmid Speaks"));
  assert.match(quiet, /HASIL/);
  assert.doesNotMatch(quiet, /\b(BUY|SELL|bot|AI)\b|https?:/);
});
