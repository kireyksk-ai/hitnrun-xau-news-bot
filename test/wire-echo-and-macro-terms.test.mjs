import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceStore } from "../dist/intelligence-store.js";
import { processArticle } from "../dist/pipeline.js";
import { assessEvent } from "../dist/event-intelligence.js";

const x = (handle, text, id, at) => ({ provider: "twitter-wire", providerId: id, title: `@${handle}: ${text}`, summary: "",
  url: `https://x.com/${handle}/status/${id}`, sourceName: "X", sourceMeta: { sourceClass: "FAST_WIRE" }, publishedAt: at });

test("same headline from several fast wires is judged by AI once", async () => {
  const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "xau-echo-")), "state.json"));
  let calls = 0; let clock = new Date("2026-09-23T14:26:00Z");
  const deps = { store, now: () => clock,
    analyze: async () => { calls++; return { material: false, confidence: "high", reason: "judged", telegramMessage: null }; },
    shadow: async () => ({ material: false, score: 10, reason: "judged" }), deliver: async () => ({ chat: 1 }) };
  await processArticle(x("FirstSquawk", "RUBIO: IRAN FIRED AT COMMERCIAL SHIPS THIS MORNING", "1", clock), deps);
  clock = new Date("2026-09-23T14:27:00Z");
  const echo = await processArticle(x("financialjuice", "US Secretary of State Rubio: Iran fired at commercial ships this morning.", "2", clock), deps);
  assert.equal(calls, 1);
  assert.equal(echo.stage, "DUPLICATE");
  assert.match(echo.reason, /CROSS_WIRE_ECHO/);
  // A different fact in the same storyline still reaches the AI.
  clock = new Date("2026-09-23T14:28:00Z");
  await processArticle(x("DeItaone", "RUBIO: IF THERE'S GOING TO BE A DEAL WITH IRAN, IT WILL INVOLVE HARD WORK OVER STRAIT", "3", clock), deps);
  assert.equal(calls, 2);
  // After 20 minutes the same wording is judged again.
  clock = new Date("2026-09-23T14:50:00Z");
  await processArticle(x("LiveSquawk", "US Sec. Of State Rubio: Iran Fired At Commercial Ships This Morning", "4", clock), deps);
  assert.equal(calls, 3);
});

test("macro headlines that used to fall through the keyword gate now reach Sol", () => {
  for (const title of [
    "@financialjuice: US Treasury to buy back up to $6B in longer-dated debt on Thursday; previously $2B",
    "@LiveSquawk: OECD Forecasts US 2026 Growth Of 2.2% (Vs 2.0% In June), 2.1% In 2027 (Vs 1.8%)",
    "@DeItaone: U.S. DIESEL EXPORT BAN COULD DEEPEN GLOBAL SHORTAGE",
    "Bloomberg Dollar Spot Index climbs for a fourth day to highest since July",
    "Euro-zone private-sector activity grows at fastest pace in more than three years"
  ]) {
    const event = assessEvent({ provider: "t", providerId: title, title, summary: "", url: "https://x.test", publishedAt: new Date(), sourceName: "Reuters" });
    assert.notEqual(event.candidateRoute, "OBVIOUS_NOISE", title);
  }
});

test("a noise word in a long wire body does not veto a macro headline", () => {
  const event = assessEvent({ provider: "twitter-wire", providerId: "h", url: "https://x.com/DeItaone/status/9", sourceName: "X", sourceMeta: { sourceClass: "FAST_WIRE" },
    title: "@DeItaone: IRAN TIES HORMUZ REOPENING TO U.S. COMPLIANCE",
    summary: "IRAN TIES HORMUZ REOPENING TO U.S. COMPLIANCE Iran's security chief reiterated that Tehran will not reopen the strait until the U.S. lifts its blockade.",
    publishedAt: new Date() });
  assert.notEqual(event.candidateRoute, "OBVIOUS_NOISE");
});
