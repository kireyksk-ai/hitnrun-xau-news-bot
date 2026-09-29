import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceStore } from "../dist/intelligence-store.js";

test("editor and brain call budgets survive a worker restart", () => {
  const path = join(mkdtempSync(join(tmpdir(), "xau-ai-budget-")), "state.json");
  const day = "2026-09-29";
  const first = new IntelligenceStore(path);
  assert.equal(first.reserveAiCall("editor", day, 2), true);
  assert.equal(first.reserveAiCall("brain", day, 1), true);
  const restarted = new IntelligenceStore(path);
  assert.equal(restarted.aiCallsToday("editor", day), 1);
  assert.equal(restarted.reserveAiCall("editor", day, 2), true);
  assert.equal(restarted.reserveAiCall("editor", day, 2), false);
  assert.equal(restarted.reserveAiCall("brain", day, 1), false);
  assert.equal(restarted.aiCallsToday("editor", "2026-09-30"), 0);
});

test("first budget migration accounts for articles already judged today", () => {
  const path = join(mkdtempSync(join(tmpdir(), "xau-ai-budget-seed-")), "state.json");
  const store = new IntelligenceStore(path);
  store.record({ id: "one", stage: "AI", event: { firstSeenAt: "2026-09-29T10:00:00Z" },
    audit: { aiCalled: true } });
  const restarted = new IntelligenceStore(path);
  assert.equal(restarted.aiCallsToday("editor", "2026-09-29"), 1);
  assert.equal(restarted.reserveAiCall("editor", "2026-09-29", 1), false);
});
