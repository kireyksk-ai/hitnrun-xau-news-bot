import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Members, formatChannelPost, formatMembers, formatRequest } from "../dist/members.js";

const req = (account, telegram, at = "2026-10-05T01:00:00.000Z") => ({ id: `x-${account}`, at, account, email: "a@b.co", telegram, country: "India", notes: "" });

test("requests, Start and decisions are matched by Telegram username and survive a restart", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mem-")), "members.json");
  const m = new Members(path);
  const a = m.addRequest(req("12345678", "@Trader_One"));
  assert.equal(a.telegram, "trader_one");
  assert.equal(a.status, "pending");
  assert.match(formatRequest(req("12345678", "@Trader_One"), a), /akun baru[\s\S]*belum Start bot[\s\S]*\/approve 12345678/);
  assert.match(formatRequest({ ...req("12345678", "@Trader_One"), path: "switch" }, a), /PINDAH IB/);
  const linked = m.recordStart("Trader_One", 77, 99);
  assert.equal(linked.length, 1);
  assert.equal(m.get("12345678").chatId, 99);
  m.setStatus("12345678", "approved");
  const again = new Members(path);
  assert.equal(again.get("12345678").status, "approved");
  assert.equal(again.lastRequestAt, "2026-10-05T01:00:00.000Z");
  // A Start before the request also links.
  again.recordStart("early_bird", 5, 6);
  assert.equal(again.addRequest(req("87654321", "early_bird", "2026-10-05T02:00:00.000Z")).chatId, 6);
  assert.match(formatMembers(again.all()), /1 aktif, 1 menunggu/);
});

test("real-time channel post shows marker, impact and watch, escaped", () => {
  const post = formatChannelPost("alert", "red", { headline: "Yields <jump>", note: "Dollar & yields up.", impact: "bearish", watch: "Fed speakers" });
  assert.match(post, /^🔴 <b>Yields &lt;jump&gt;<\/b>/);
  assert.match(post, /Dollar &amp; yields up\./);
  assert.match(post, /↘ Bearish for gold/);
  assert.match(post, /👀 Watch: Fed speakers/);
  assert.match(formatChannelPost("desk", "yellow", { headline: "H", note: "N", impact: "mixed", watch: "" }), /^🧭 <b>DESK UPDATE — H<\/b>/);
});
