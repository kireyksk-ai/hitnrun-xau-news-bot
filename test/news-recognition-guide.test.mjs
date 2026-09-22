import assert from "node:assert/strict";
import test from "node:test";
import { Editor, NEWS_RECOGNITION_GUIDE, SOURCE_RECOGNITION_GUIDE } from "../dist/editor.js";
import { assessEvent } from "../dist/event-intelligence.js";

const article = {
  provider: "test", providerId: "recognition", sourceName: "Reuters",
  title: "US Treasury auction tails sharply as real yields rise",
  summary: "The result differs from market expectations.",
  url: "https://example.test/auction", publishedAt: new Date("2026-09-23T00:00:00Z")
};

test("additive news recognition reaches both Sol judgments without changing output contracts", async () => {
  assert.match(NEWS_RECOGNITION_GUIDE, /China\/India physical demand/);
  assert.match(NEWS_RECOGNITION_GUIDE, /Hormuz escalation AND de-escalation/);
  assert.match(NEWS_RECOGNITION_GUIDE, /never invent missing values/);
  assert.match(SOURCE_RECOGNITION_GUIDE, /Startup Fortune is a separate publication from Fortune/);
  assert.match(SOURCE_RECOGNITION_GUIDE, /FedRateCalc is a third-party calendar/);
  const editor = new Editor("gpt-5.6-sol", "medium", "test-key");
  const calls = [];
  editor.client = { responses: { create: async (request) => {
    calls.push(request);
    return { output_text: calls.length === 1
      ? JSON.stringify({ material: false, confidence: "low", reason: "No verified new impact", judul: null, ringkasan: null, dampakEmas: null })
      : JSON.stringify({ material: false, score: 20, reason: "No verified new impact" }) };
  } } };
  await editor.assess(article);
  await editor.shadowAssess(article, assessEvent(article));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "gpt-5.6-sol");
  assert.equal(calls[0].reasoning.effort, "medium");
  assert.equal(calls[0].text.format.type, "json_schema");
  assert.match(calls[0].input[0].content, /ADDITIONAL XAU NEWS RECOGNITION GUIDE/);
  assert.match(calls[0].input[0].content, /ADDITIONAL SOURCE MEMORY GUIDE/);
  assert.match(calls[0].input[0].content, /When material=true, write ONLY three clean fields/);
  assert.match(calls[1].input[0].content, /ADDITIONAL XAU NEWS RECOGNITION GUIDE/);
  assert.match(calls[1].input[0].content, /ADDITIONAL SOURCE MEMORY GUIDE/);
  assert.match(calls[1].input[0].content, /Return JSON only: \{material:boolean, score:integer 0-100, reason:string\}/);
});
