import assert from "node:assert/strict";
import test from "node:test";
import { queryFor } from "../dist/providers/twitter-wire.js";

test("X wire query stays below the API's 512-character limit", () => {
  const accounts = ["DeItaone", "FirstSquawk", "LiveSquawk", "zerohedge", "unusual_whales", "financialjuice", "WatcherGuru"];
  const query = queryFor(accounts);
  assert.ok(query.length <= 512, `query length ${query.length}`);
  for (const topic of ["PMI", "OECD", "mortgage", "ECB", "eurozone", "DXY"]) assert.match(query, new RegExp(`\\b${topic}\\b`));
});

test("Bloomberg newsroom accounts fit the query and count as trusted reporters", async () => {
  const { sourceTier } = await import("../dist/event-intelligence.js");
  const { sourceClassFor } = await import("../dist/actor-registry.js");
  const all = ["DeItaone", "FirstSquawk", "LiveSquawk", "zerohedge", "unusual_whales", "financialjuice", "WatcherGuru", "business", "markets", "economics", "BloombergTV"];
  assert.ok(queryFor(all).length <= 512, `query length ${queryFor(all).length}`);
  const tweet = { provider: "twitter-wire", url: "https://x.com/business/status/123", sourceName: "X / Twitter Wire", sourceMeta: { sourceClass: sourceClassFor("business") } };
  assert.equal(sourceTier(tweet), 2);
  assert.equal(sourceTier({ ...tweet, url: "https://x.com/zerohedge/status/1", sourceMeta: { sourceClass: sourceClassFor("zerohedge") } }), 3);
});
