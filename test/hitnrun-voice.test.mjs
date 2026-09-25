import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { HITNRUN_VOICE_GUIDE } from "../dist/editor.js";
import { validateNewsOutput } from "../dist/news-output.js";

test("owner voice guide carries the owner's rules and core sentence", () => {
  for (const cue of [/Rapihin pikiran gw, jangan ganti karakter gw/, /gw, lo, kita/, /Never saya, Anda/, /ini tabrakan/, /no zones, levels, entries/, /never "pasti" or "dijamin"/])
    assert.match(HITNRUN_VOICE_GUIDE, cue);
  const source = readFileSync(new URL("../src/editor.ts", import.meta.url), "utf8");
  assert.equal(source.match(/\$\{HITNRUN_VOICE_GUIDE\}/g)?.length, 4, "voice must reach the primary writer, the prose repair, the briefing and the calendar text");
});

test("an alert in the owner's voice with trader words passes the NEWS gate", () => {
  const msg = "<b>⚠️ Barr Nambahin Bensin Hawkish</b>\n\nBarr barusan ngomong kenaikan kemaren blm cukup. Inflasi masih bandel, pasar kerja jg udah gk jadi alasan buat nahan, jadi pintu naik lg masih kebuka lebar.\n\nIntinya ini bukan cuma soal Barr. Abis PMI 58 kemaren arahnya emang udah keliatan kesini, makanya yield sama DXY naik bareng dan gold ketekan dari dua sisi. Buyer gold ada kok tp lg dipaksa ngelawan arus market. Selama Fed masih kompak hawkish kayak gini jangan heran klo emas susah napas.";
  const article = { provider: "t", providerId: "x", title: "Fed's Barr Says Further Rate Hikes Likely Needed", summary: "", url: "https://x.test", publishedAt: new Date() };
  assert.deepEqual(validateNewsOutput(msg, article), { ok: true });
});

test("a pasted English paragraph is still rejected", () => {
  const msg = "<b>⚠️ Barr hawkish</b>\n\nThe Fed governor said further rate hikes will likely be needed after the meeting, according to remarks announced before markets opened, and the president has said the government will act.\n\nThe gold price could fall after the policy meeting, and it would have to be watched against the dollar, emas.";
  const article = { provider: "t", providerId: "y", title: "x", summary: "", url: "https://x.test", publishedAt: new Date() };
  assert.equal(validateNewsOutput(msg, article).ok, false);
});
