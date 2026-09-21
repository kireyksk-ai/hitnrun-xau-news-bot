import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceStore } from "../dist/intelligence-store.js";
import { processArticle } from "../dist/pipeline.js";

// Every case traverses the same production processArticle gate. The AI stub
// deliberately says SEND for everything, so false positives expose hard-gate bugs.
const trumpMarket = [
  "Trump announces new tariffs on Chinese imports", "Trump orders additional sanctions on Iran oil exports",
  "Trump says he is open to meeting Iran's president", "Trump announces ceasefire talks with Israel and Iran",
  "Trump orders US military strikes on Iranian missile sites", "Trump rejects proposed Iran ceasefire deal",
  "Trump announces new Treasury debt financing plan", "Trump calls for Fed rate cut in official policy statement",
  "Trump threatens tariffs on European steel imports", "Trump announces China trade agreement reducing tariffs",
  "Trump orders release of strategic oil reserves", "Trump says US will block Iran oil tankers",
  "Trump announces sanctions on Russian energy companies", "Trump accepts direct negotiations with Iran",
  "Trump cancels planned Iran summit after attack", "Trump announces fiscal stimulus package",
  "Trump imposes sanctions on Saudi oil shipping network", "Trump declares Hormuz shipping protection mission",
  "Trump announces major tax policy change", "Trump rejects proposed Fed independence restrictions"
];
const trumpNoise = [
  "Trump attacks CNN and Politico over White House press access", "Trump attacks CNN coverage of Iran without announcing policy",
  "Trump criticizes Politico reporting on Fed rates without a policy change", "Trump complains about White House media seating",
  "Trump attacks judge over personal dispute", "Trump celebrates poll numbers at rally",
  "Trump endorses local candidate", "Trump congratulates sports champion",
  "Trump attends charity gala", "Trump announces birthday celebration",
  "Trump comments on television ratings", "Trump criticizes newspaper editor",
  "Trump praises campaign volunteer", "Trump attacks late-night television host",
  "Trump shares old campaign photograph", "Trump announces award for supporter",
  "Trump discusses court scheduling without policy impact", "Trump comments on social media follower count",
  "Trump attacks CNN anchor for interview style", "Trump criticizes Politico headline about polling"
];
const fedMacro = [
  "Fed announces surprise rate hike", "Fed official Goolsbee rejects rate cuts to finance government debt",
  "FOMC announces larger balance sheet reduction", "Fed chair signals new inflation policy guidance",
  "US CPI surges above consensus", "US PCE inflation rises above consensus",
  "US NFP payrolls plunge below consensus", "US unemployment rate rises sharply",
  "US retail sales plunge below consensus", "US GDP revised sharply lower"
];
const geoOil = [
  "Iran attacks oil export terminal", "Hormuz tanker traffic disrupted after new threat",
  "Saudi announces major oil export shutdown", "OPEC announces surprise production cut",
  "Iran agrees to ceasefire talks with US", "Israel launches major strike on Iranian energy facility",
  "US Treasury announces new sanctions on Iran oil buyers", "Houthi missiles strike Red Sea oil tanker",
  "Saudi reopens major oil export route", "Iran rejects US ceasefire proposal"
];
const noise = [
  "Minor disruption at local oil storage site", "Oil market weekly outlook repeats old forecasts",
  "Analyst opinion says gold could rise someday", "Fed speech preview repeats known consensus",
  "No new details on Iran sanctions story", "Routine maintenance at small oil depot",
  "Trump repeats old tariff view without new policy", "Iran conflict roundup repeats yesterday's facts",
  "Gold price rises during quiet session", "Local retail fuel station temporarily closed"
];
export const cases = [
  ...trumpMarket.map((title) => ({ title, expected: true, group: "Trump market" })),
  ...trumpNoise.map((title) => ({ title, expected: false, group: "Trump noise" })),
  ...fedMacro.map((title) => ({ title, expected: true, group: "Fed/macro" })),
  ...geoOil.map((title) => ({ title, expected: true, group: "Geopolitics/oil" })),
  ...noise.map((title) => ({ title, expected: false, group: "Noise" }))
];

test("70-case production pipeline confusion matrix", async () => {
  let tp = 0, tn = 0, fp = 0, fn = 0;
  const errors = [];
  for (const [index, item] of cases.entries()) {
    const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "xau-reg-")), "state.json"));
    const article = { provider: "regression", providerId: `case-${index}`, title: item.title, summary: item.title,
      url: `https://example.test/${index}`, sourceName: "Reuters", publishedAt: new Date("2026-09-22T00:00:00Z") };
    const result = await processArticle(article, { store,
      analyze: async () => ({ material: true, confidence: "high", reason: "adversarial AI", telegramMessage: "<b>⚠️ PERUBAHAN KEBIJAKAN MATERIAL</b>\n\nAda perkembangan baru yang dapat mengubah ekspektasi pasar terhadap kebijakan ekonomi dan risiko global. Fakta ini dinilai cukup material untuk diteruskan sebagai informasi trader.\n\nBuat emas, jalurnya berjalan melalui perubahan ekspektasi kebijakan, yield, dolar, atau premi risiko. Arah emas belum jelas sampai dampak awal terlihat lebih konsisten." }),
      shadow: async () => ({ material: true, score: 90, reason: "adversarial shadow" }),
      deliver: async () => ({ chat: 1 }), now: () => new Date("2026-09-22T00:01:00Z") });
    const actual = result.stage === "SENT";
    if (actual && item.expected) tp++; else if (!actual && !item.expected) tn++;
    else { if (actual) fp++; else fn++; errors.push({ group: item.group, title: item.title, expected: item.expected ? "SEND" : "DROP", actual: result.stage, reason: result.reason }); }
  }
  console.log(JSON.stringify({ tp, tn, fp, fn, errors }, null, 2));
  assert.equal(cases.length, 70);
  assert.equal(fp, 0, "False positives must be fixed before deployment");
  assert.equal(fn, 0, "False negatives must be fixed before deployment");
});

