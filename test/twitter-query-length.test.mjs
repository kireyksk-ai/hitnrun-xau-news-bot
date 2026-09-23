import assert from "node:assert/strict";
import test from "node:test";
import { queryFor } from "../dist/providers/twitter-wire.js";

test("X wire query stays below the API's 512-character limit", () => {
  const accounts = ["DeItaone", "FirstSquawk", "LiveSquawk", "zerohedge", "unusual_whales", "financialjuice", "WatcherGuru"];
  const query = queryFor(accounts);
  assert.ok(query.length <= 512, `query length ${query.length}`);
  for (const topic of ["PMI", "OECD", "mortgage", "ECB", "eurozone", "DXY"]) assert.match(query, new RegExp(`\\b${topic}\\b`));
});
