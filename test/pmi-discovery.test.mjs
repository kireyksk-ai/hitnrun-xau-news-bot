import assert from "node:assert/strict";
import test from "node:test";
import { BenzingaWireProvider } from "../dist/providers/benzinga-wire.js";
import { assessEvent } from "../dist/event-intelligence.js";

test("Benzinga PMI release is discovered and routed as scheduled macro", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ results: [
    { benzinga_id: 1, title: "US flash composite PMI climbs to 58.4 as business activity accelerates", teaser: "S&P Global reports stronger orders, hiring and input prices.", url: "https://example.com/pmi", published: "2026-09-23T13:46:00Z" },
    { benzinga_id: 2, title: "Small company product launch", teaser: "No macro data.", url: "https://example.com/company", published: "2026-09-23T13:46:00Z" }
  ] }), { status: 200 });
  try {
    const articles = await new BenzingaWireProvider("test-key").fetchLatest(new Date("2026-09-23T13:45:00Z"));
    assert.equal(articles.length, 1);
    const event = assessEvent(articles[0]);
    assert.equal(event.unscheduled, false);
    assert.equal(event.storyKey, "us-macro-pmi");
    assert.notEqual(event.candidateRoute, "OBVIOUS_NOISE");
  } finally { globalThis.fetch = originalFetch; }
});
