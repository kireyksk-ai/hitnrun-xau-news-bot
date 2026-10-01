import test from "node:test";
import assert from "node:assert/strict";
import { deskHeadlines, deskOutput, dueDeskSlot } from "../dist/desk-update.js";

test("desk slots run on weekdays only, once per slot, Friday midnight included", () => {
  const at = (iso) => new Date(iso);
  assert.equal(dueDeskSlot(at("2026-10-01T05:05:00Z"), new Set()), "2026-10-01T12"); // Thu 12:05 WIB
  assert.equal(dueDeskSlot(at("2026-10-01T05:05:00Z"), new Set(["2026-10-01T12"])), null);
  assert.equal(dueDeskSlot(at("2026-10-01T05:25:00Z"), new Set()), null, "slot window is 20 minutes");
  assert.equal(dueDeskSlot(at("2026-10-03T05:05:00Z"), new Set()), null, "Saturday");
  assert.equal(dueDeskSlot(at("2026-10-02T17:05:00Z"), new Set()), "2026-10-03T00", "Friday 24:00 WIB");
  assert.equal(dueDeskSlot(at("2026-10-04T17:05:00Z"), new Set()), null, "Sunday 24:00 is not a trading day close");
});

test("desk headlines keep market topics, merge wire duplicates and drop noise", () => {
  const now = Date.parse("2026-10-01T09:00:00Z");
  const items = [
    { title: "@FirstSquawk: US 10-YEAR TREASURY YIELD HITS 5.342%, HIGHEST SINCE 2002", publishedAt: "2026-10-01T08:50:00Z" },
    { title: "US 10-year Treasury yield hits 5.342%, highest since 2002 - Reuters", publishedAt: "2026-10-01T08:51:00Z" },
    { title: "Sonos launches new soundbar lineup", publishedAt: "2026-10-01T08:40:00Z" },
    { title: "Chinese refiners suspend October fuel exports, PetroChina cancels cargoes", publishedAt: "2026-10-01T08:30:00Z" },
    { title: "Old Fed story", publishedAt: "2026-09-30T01:00:00Z" }
  ];
  const h = deskHeadlines(items, now - 3 * 3_600_000);
  assert.equal(h.length, 2);
  assert.match(h[0], /15:51 WIB US 10-year Treasury yield hits 5\.342%/);
});

test("desk output must be a real update without levels, links or trade calls", () => {
  const body = "🧭 UPDATE XAU\nBond market ambil alih kemudi\n\n" + "Yield 10 tahun AS cetak tertinggi sejak 2002 walau odds hike Oktober turun, jadi mesin yang nekan emas pindah dari Fed ke pasar obligasi. ".repeat(4);
  assert.match(deskOutput(body), /^<b>🧭 UPDATE XAU<\/b>/);
  assert.equal(deskOutput("TIDAK_ADA_UPDATE"), null);
  assert.equal(deskOutput(body + " Area $4,200 jadi kunci."), null, "no gold price levels");
  assert.equal(deskOutput(body + " https://x.com"), null);
  assert.equal(deskOutput(body + " BUY sekarang"), null);
});
