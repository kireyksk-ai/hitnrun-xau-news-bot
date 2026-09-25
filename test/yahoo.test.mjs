import assert from "node:assert/strict";
import test from "node:test";
import { resetYahooForTests, ttlFor, yahooFetch } from "../dist/yahoo.js";

test("yahoo gate caches by interval, rotates hosts, and backs off on 429 while serving the last good data", async () => {
  resetYahooForTests();
  let t = 1_000_000, calls = [];
  const now = () => t;
  let mode = "ok";
  const net = async (url, init) => { calls.push([String(url), init.headers["User-Agent"]]); return mode === "ok" ? new Response('{"v":1}', { status: 200 }) : new Response("slow down", { status: 429 }); };
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?range=1d&interval=5m";
  assert.equal(ttlFor(url), 120_000);
  assert.equal(await (await yahooFetch(url, { headers: { "User-Agent": "HitnRunFX/1.0" } }, net, now)).text(), '{"v":1}');
  await yahooFetch(url, {}, net, now);
  assert.equal(calls.length, 1, "second call inside TTL served from cache");
  assert.match(calls[0][1], /Mozilla/, "browser-like UA always sent");
  t += 130_000; mode = "429";
  const stale = await yahooFetch(url, {}, net, now);
  assert.equal(stale.status, 200); assert.equal(await stale.text(), '{"v":1}');
  assert.equal(calls.length, 2); assert.match(calls[1][0], /query2/);
  const other = await yahooFetch("https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?range=1d&interval=5m", {}, net, now);
  assert.equal(other.status, 429); assert.equal(calls.length, 2, "cooldown: no network call");
  t += 4 * 60_000; mode = "ok";
  assert.equal((await yahooFetch("https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?range=1d&interval=5m", {}, net, now)).status, 200);
});
