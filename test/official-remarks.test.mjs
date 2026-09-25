import test from "node:test";
import assert from "node:assert/strict";
import { officialRemark, remarksDigest, remarksBlock } from "../dist/official-remarks.js";

const yes = [
  "Fed's Williams: Persistent supply shocks are making the inflation fight harder",
  "USTR's Greer: We have reached agreements with China on a sub-set of goods we can trade",
  "@FirstSquawk: TRUMP SAYS IRAN MUST OPEN HORMUZ OR FACE STRIKES",
  "Saudi energy minister says OPEC+ ready to raise output",
  "Iran's Araghchi says talks with US on nuclear deal can resume",
  "ECB's Schnabel: Rate cuts are not on the table while inflation stays sticky",
  "Bessent says tariffs on China will stay until deal is signed",
  "Kremlin: Putin open to ceasefire talks on Ukraine"
];
const no = [
  "Eaton Adds European Power Capacity as Data Center Demand Keeps Rising",
  "How To Trade SPY, QQQ, And 6 Mega Caps As Durable Goods Data, Michigan Sentiment Set Up Key Volatility Windows",
  "Gold price forecast: Why 4,432 could decide whether the bullish move extends",
  "Week ahead preview: Powell, PCE and payrolls",
  "Nvidia shares jump after earnings beat"
];

test("official remarks on money, prices, trade and war are recognised; stock and preview noise is not", () => {
  for (const t of yes) assert.ok(officialRemark({ title: t, summary: "" }), `should match: ${t}`);
  for (const t of no) assert.equal(officialRemark({ title: t, summary: "" }), undefined, `should not match: ${t}`);
  assert.equal(officialRemark({ title: yes[0], summary: "" }).who, "Williams");
});

test("digest keeps newest distinct remarks and renders WIB times", () => {
  const now = Date.parse("2026-09-25T14:00:00Z");
  const items = [
    { title: yes[0], publishedAt: "2026-09-25T10:13:35Z" },
    { title: yes[0], publishedAt: "2026-09-25T10:14:00Z" },
    { title: yes[1], publishedAt: "2026-09-25T12:47:20Z" },
    { title: no[0], publishedAt: "2026-09-25T12:50:00Z" },
    { title: yes[2], publishedAt: "2026-09-24T01:00:00Z" }
  ];
  const d = remarksDigest(items, now - 6 * 3600_000);
  assert.deepEqual(d.map((l) => l.who), ["Greer", "Williams"]);
  assert.match(remarksBlock(d, "UCAPAN PEJABAT"), /19:47 WIB USTR's Greer/);
});

test("an official remark Sol calls minor is still published (must-send), and tier-3 copies still wait for corroboration", async () => {
  const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { IntelligenceStore } = await import("../dist/intelligence-store.js");
  const { processArticle } = await import("../dist/pipeline.js");
  const article = { provider: "twitter-wire", providerId: "kb-1", sourceName: "X", url: "https://x.com/FirstSquawk/status/1",
    title: "@FirstSquawk: KATAYAMA AND BESSENT REAFFIRMED THAT YEN UNDERVALUATION IS MATTER OF CONCERN", summary: "",
    publishedAt: new Date("2026-09-25T13:55:00Z"), sourceMeta: { sourceClass: "FAST_WIRE" } };
  const prose = "<b>⚠️ AS dan Jepang sepakat yen terlalu lemah</b>\n\nMenkeu Jepang Katayama dan Menkeu AS Bessent menegaskan pelemahan yen jadi perhatian bersama, sinyal kuat bahwa intervensi untuk menguatkan yen makin mungkin terjadi.\n\nBuat emas, yen yang menguat biasanya menekan dolar, jadi ini cenderung memberi ruang emas naik selama dolar melemah.";
  const run = async (a, mustSend) => {
    const sent = [];
    const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "xau-must-")), "state.json"));
    const r = await processArticle(a, { store, analyze: async () => ({ material: false, confidence: "low", reason: "minor", telegramMessage: null }),
      shadow: async () => ({ material: false, score: 20, reason: "minor" }), compose: async () => ({ message: prose }),
      deliver: async (m) => { sent.push(m); return { chat: 1 }; }, mustSend });
    return { r, sent };
  };
  const forced = await run(article, () => true);
  assert.equal(forced.r.stage, "SENT"); assert.equal(forced.sent.length, 1); assert.match(forced.r.reason, /OFFICIAL_REMARK_MUST_SEND/);
  const normal = await run({ ...article, providerId: "kb-2" }, () => false);
  assert.equal(normal.sent.length, 0, "without the rule Sol's judgment stands");
  const weak = await run({ ...article, providerId: "kb-3", provider: "google-news-rss", sourceName: "Some Blog", url: "https://blog.example/x", title: "Bessent says tariffs on China stay", sourceMeta: undefined }, () => true);
  assert.equal(weak.sent.length, 0, "an unverified source still needs corroboration");
});

test("a tier-3 copy is held for corroboration without spending any AI call", async () => {
  const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { IntelligenceStore } = await import("../dist/intelligence-store.js");
  const { processArticle } = await import("../dist/pipeline.js");
  let calls = 0;
  const store = new IntelligenceStore(join(mkdtempSync(join(tmpdir(), "xau-t3-")), "state.json"));
  const r = await processArticle({ provider: "news-hunter", providerId: "t3", sourceName: "Some Blog", url: "https://blog.example/fed",
    title: "Fed signals another rate hike as inflation stays hot", summary: "Fed officials signal more hikes.", publishedAt: new Date() },
    { store, analyze: async () => { calls++; throw new Error("must not be called"); }, shadow: async () => { calls++; throw new Error("must not be called"); },
      deliver: async () => ({ chat: 1 }) });
  assert.equal(calls, 0);
  assert.equal(r.stage, "SOURCE");
});
