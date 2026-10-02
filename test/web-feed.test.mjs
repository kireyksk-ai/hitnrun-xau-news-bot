import test from "node:test";
import assert from "node:assert/strict";
import { plainPost, webMarker, webSafe } from "../dist/web-feed.js";

test("web feed reads the marker and plain text of a Telegram post", () => {
  const post = "<b>🔴 Yield 10Y AS tembus level tertinggi 24 tahun</b>\n\nDolar &amp; yield naik bareng.";
  assert.equal(webMarker(post), "red");
  assert.equal(webMarker("<b>⚪ konteks</b>"), "white");
  assert.equal(webMarker("<b>Berita</b>"), "yellow");
  assert.equal(plainPost(post), "🔴 Yield 10Y AS tembus level tertinggi 24 tahun\n\nDolar & yield naik bareng.");
});

test("web feed blocks trade calls, levels, links and media names", () => {
  assert.equal(webSafe("US 10-year yield hits a 24-year high; a stronger dollar weighs on gold."), true);
  for (const bad of ["Buy gold now", "SELL below resistance", "Gold could test $4,200", "Read more at https://x.com", "Bloomberg reports", "Our AI says", "target hit", "join our Telegram"]) {
    assert.equal(webSafe(bad), false, bad);
  }
});
