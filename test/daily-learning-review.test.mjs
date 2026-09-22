import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceStore } from "../dist/intelligence-store.js";
import { formatDailyLearningReview } from "../dist/daily-learning-review.js";

const now = new Date("2026-09-23T12:00:00Z");

test("daily reflection never invents accuracy or a trading prediction", () => {
  const path = join(mkdtempSync(join(tmpdir(), "daily-review-")), "state.json");
  const store = new IntelligenceStore(path);
  const before = JSON.stringify(store.marketBrain());
  const report = formatDailyLearningReview(store, now);
  assert.match(report, /BELUM TERUKUR/);
  assert.match(report, /Aturan produksi yang diubah otomatis: 0/);
  assert.match(report, /Phase 5\/trading: OFF/);
  assert.equal(JSON.stringify(store.marketBrain()), before);
  assert.equal(formatDailyLearningReview(new IntelligenceStore(path), now), report);
});

test("daily accuracy counts only completed directional scorecards in the last 24 hours", () => {
  const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "daily-score-")), "state.json"));
  const base = { hypothesisId: "event", createdAt: now.toISOString(), horizon: "INTRADAY",
    causalChannel: "FED", regime: "UNCLEAR", marketState: "UNCLEAR", dueAt: now.toISOString(),
    evaluatedAt: now.toISOString(), state: "EVALUATED" };
  store.recordScorecard({ ...base, id: "hit", direction: "UP", xauReturn: 0.4 });
  store.recordScorecard({ ...base, id: "miss", direction: "UP", xauReturn: -0.2 });
  store.recordScorecard({ ...base, id: "unlabeled", xauReturn: 0.8 });
  const report = formatDailyLearningReview(store, now);
  assert.match(report, /akurasi arah: 50% \(1\/2\)/);
});
