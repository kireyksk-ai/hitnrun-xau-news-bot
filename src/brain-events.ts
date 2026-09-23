import type { Linkage } from "./brain-macro.js";

/**
 * Event playbook: every catalyst the owner considers important, with its source,
 * priority, cause→effect chain, and what it usually means for gold in each linkage
 * regime (RATE = rate-dominant, CB = central-bank/debasement-dominant, MIXED).
 * Conditional events (oil, conflict, 30Y) are resolved against live market numbers.
 * The playbook is evidence for Sol, not an automatic verdict.
 */
export type Priority = "CRITICAL" | "HIGH" | "MEDIUM";
export type GoldBias = "BULLISH" | "BEARISH" | "NEUTRAL" | "CONTEXTUAL";
/** Bias = gold reaction when the metric comes in HIGHER / the event happens as named. */
export type PlaybookEntry = {
  code: string; name: string; category: string; source: string; priority: Priority; match: RegExp; chain: string;
  bias: Record<Linkage, GoldBias>; note?: string;
};
const same = (b: GoldBias): Record<Linkage, GoldBias> => ({ RATE: b, CB: b, MIXED: b });

export const PLAYBOOK: PlaybookEntry[] = [
  // A. Inflation
  { code: "US_CORE_CPI", name: "US Core CPI", category: "INFLASI", source: "BLS", priority: "CRITICAL", match: /\bcore cpi\b|cpi.*(ex|excluding).*food/i,
    chain: "Core CPI naik → inflasi inti kuat → Fed tahan/naik lebih lama → real yield naik → emas turun", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "BEARISH" }, note: "reaksi biasanya lebih besar dari headline CPI" },
  { code: "US_CPI", name: "US CPI YoY/MoM", category: "INFLASI", source: "BLS", priority: "CRITICAL", match: /\b(cpi|consumer price)/i,
    chain: "CPI naik → ekspektasi Fed hawkish naik → yield naik → USD naik → emas turun", bias: { RATE: "BEARISH", CB: "BULLISH", MIXED: "BEARISH" }, note: "rezim CB: CPI naik bisa bullish (hedge inflasi & debasement)" },
  { code: "US_CORE_PCE", name: "US Core PCE", category: "INFLASI", source: "BEA", priority: "CRITICAL", match: /\bcore pce\b/i,
    chain: "Core PCE naik → Fed gak bisa pivot → hawkish berkepanjangan → emas tertekan", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "BEARISH" }, note: "gauge favorit Fed" },
  { code: "US_PCE", name: "US PCE Price Index", category: "INFLASI", source: "BEA", priority: "CRITICAL", match: /\bpce\b|personal consumption expenditure/i,
    chain: "PCE naik → gauge favorit Fed naik → rate path hawkish → yield naik → emas turun", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "BEARISH" } },
  { code: "US_PPI", name: "US PPI", category: "INFLASI", source: "BLS", priority: "CRITICAL", match: /\b(ppi|producer price)/i,
    chain: "PPI naik → biaya produsen naik → CPI ke depan naik → Fed hawkish → emas turun", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "BEARISH" }, note: "dampak tidak langsung" },
  // B. Labour
  { code: "US_NFP", name: "US Non-Farm Payrolls", category: "TENAGA KERJA", source: "BLS", priority: "CRITICAL", match: /non-?farm|payrolls?\b|\bnfp\b/i,
    chain: "NFP kuat → ekonomi gak butuh cut → Fed hawkish → yield naik → USD naik → emas turun", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "BEARISH" }, note: "surprise >50K dari konsensus = reaksi besar (emas bisa 1-2% dalam menit); <20K = kecil, sering diabaikan" },
  { code: "US_UNEMPLOYMENT", name: "US Unemployment Rate", category: "TENAGA KERJA", source: "BLS", priority: "CRITICAL", match: /unemployment rate|jobless rate/i,
    chain: "Pengangguran turun → pasar kerja ketat → upah naik → inflasi naik → Fed hawkish → emas turun", bias: { RATE: "BULLISH", CB: "NEUTRAL", MIXED: "BULLISH" }, note: "bias di sini untuk angka DI ATAS perkiraan (pengangguran naik = dovish = emas naik); turun = emas turun" },
  { code: "US_AVG_HOURLY", name: "US Average Hourly Earnings", category: "TENAGA KERJA", source: "BLS", priority: "HIGH", match: /average hourly earnings|wage growth/i,
    chain: "Upah naik → inflasi jasa naik → core PCE naik → Fed hawkish → emas turun", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "BEARISH" } },
  { code: "US_JOBLESS_CLAIMS", name: "US Initial Jobless Claims", category: "TENAGA KERJA", source: "DOL", priority: "CRITICAL", match: /jobless claims|initial claims|continuing claims/i,
    chain: "Claims naik → pasar kerja melemah → Fed dovish → yield turun → emas naik (kebalikan NFP)", bias: { RATE: "BULLISH", CB: "NEUTRAL", MIXED: "BULLISH" }, note: "arah: claims NAIK = emas naik; mingguan, dampak lebih kecil" },
  { code: "US_JOLTS", name: "US JOLTS Job Openings", category: "TENAGA KERJA", source: "BLS", priority: "HIGH", match: /\bjolts\b|job openings/i,
    chain: "Lowongan turun → pasar kerja dingin → Fed dovish → emas naik", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "BEARISH" }, note: "bias untuk angka DI ATAS perkiraan (lowongan banyak = hawkish = emas turun); lowongan turun = emas naik" },
  // C. Fed
  { code: "FED_DOT_PLOT", name: "Fed Dot Plot (SEP)", category: "FED", source: "Fed", priority: "CRITICAL", match: /dot plot|summary of economic projections|\bsep\b.*fed/i,
    chain: "Dot plot naik → rate path jangka panjang hawkish → emas turun", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "BEARISH" } },
  { code: "FOMC_MINUTES", name: "FOMC Minutes", category: "FED", source: "Fed", priority: "CRITICAL", match: /fomc minutes|minutes of the fed|fed minutes/i,
    chain: "Minutes hawkish → pasar reprice rate path → yield naik → emas turun", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "BEARISH" } },
  { code: "FOMC", name: "FOMC Rate Decision", category: "FED", source: "Fed", priority: "CRITICAL", match: /\bfomc\b|rate decision|fed (?:holds|raises|cuts|hikes|keeps)|federal funds rate/i,
    chain: "FOMC hawkish (naik/tahan) → yield naik → USD naik → emas turun", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "BEARISH" } },
  { code: "FED_BALANCE_SHEET", name: "Fed Balance Sheet / QT", category: "FED", source: "Fed", priority: "HIGH", match: /balance sheet|quantitative tightening|\bqt\b/i,
    chain: "QT dipercepat → likuiditas turun → emas turun", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "BEARISH" } },
  { code: "FED_INDEPENDENCE", name: "Fed Independence Risk", category: "FED", source: "Berita/politik", priority: "CRITICAL", match: /fed independence|fire (?:powell|the fed chair)|pressure on the fed|trump.*(powell|fed chair)/i,
    chain: "Intervensi politik ke Fed → kepercayaan USD turun → emas naik (hedge)", bias: same("BULLISH") },
  { code: "FED_SPEAK", name: "Fed Official Speech", category: "FED", source: "Fed", priority: "CRITICAL", match: /\b(fed(?:'s)?|powell|waller|barr|goolsbee|williams|hammack|logan|kashkari|bostic|daly|jefferson|bowman|musalem|schmid|paulson|barkin|cook)\b.*\b(says?|said|sees|warns?|signals?)\b/i,
    chain: "Pidato hawkish → ekspektasi rate naik → yield naik → emas turun (dovish sebaliknya)", bias: { RATE: "CONTEXTUAL", CB: "NEUTRAL", MIXED: "CONTEXTUAL" }, note: "arah ditentukan nada pidato (lihat FED_TONE)" },
  // D. Oil
  { code: "HORMUZ_CLOSURE", name: "Strait of Hormuz Closure", category: "OIL", source: "Berita geopolitik", priority: "HIGH", match: /hormuz/i,
    chain: "Hormuz tutup → oil spike → inflasi spike → Fed hawkish → emas turun (paradoks)", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "CONTEXTUAL" }, note: "cek oil: >5% = logika rate menang" },
  { code: "OPEC_SURPRISE", name: "OPEC Surprise Production", category: "OIL", source: "OPEC", priority: "HIGH", match: /opec.*(raise|increase|boost|hike).*(output|production)|(output|production) (increase|hike)/i,
    chain: "OPEC tambah produksi → oil turun → inflasi turun → Fed dovish → emas naik", bias: { RATE: "BULLISH", CB: "NEUTRAL", MIXED: "BULLISH" } },
  { code: "OPEC_MEETING", name: "OPEC+ Meeting / Cut", category: "OIL", source: "OPEC", priority: "HIGH", match: /\bopec\+?\b/i,
    chain: "OPEC cut → oil naik → inflasi naik → Fed hawkish → emas turun", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "BEARISH" } },
  { code: "OIL_INVENTORY", name: "US Crude Oil Inventories", category: "OIL", source: "EIA", priority: "MEDIUM", match: /crude (?:oil )?inventor|eia.*(stock|inventor)|api (?:crude|inventor)/i,
    chain: "Inventory naik → oil turun → inflasi turun → emas naik", bias: { RATE: "BULLISH", CB: "NEUTRAL", MIXED: "NEUTRAL" }, note: "dampak lemah" },
  { code: "OIL_SPIKE", name: "Oil Price Spike > 3%", category: "OIL", source: "Market", priority: "HIGH", match: /(oil|crude|brent|wti).*(surge|soar|jump|spike|rall)/i,
    chain: "Oil naik → ekspektasi inflasi naik → Fed hawkish → yield naik → emas turun", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "BEARISH" } },
  // E. Geopolitics
  { code: "GEO_CEASEFIRE", name: "Ceasefire / De-escalation", category: "GEOPOLITIK", source: "Berita", priority: "HIGH", match: /ceasefire|truce|de-?escalat|peace (?:deal|talks|agreement)/i,
    chain: "Ceasefire → oil turun → inflasi turun → Fed dovish → emas naik (paradoks; premi safe haven juga luntur)", bias: { RATE: "BULLISH", CB: "NEUTRAL", MIXED: "CONTEXTUAL" } },
  { code: "SANCTIONS", name: "New Sanctions", category: "GEOPOLITIK", source: "Berita", priority: "HIGH", match: /sanction/i,
    chain: "Sanksi ke produsen minyak → oil naik → inflasi naik → emas turun (via rate)", bias: { RATE: "BEARISH", CB: "NEUTRAL", MIXED: "CONTEXTUAL" } },
  { code: "GEO_CONFLICT", name: "Geopolitical Conflict / Escalation", category: "GEOPOLITIK", source: "Berita", priority: "HIGH", match: /\b(war|attack|strike|missile|invasion|escalat|military|troops|drone)\b/i,
    chain: "Konflik naik → cek oil: oil >5% → inflasi → Fed hawkish → yield naik → emas turun; oil stabil → safe haven → emas naik", bias: same("CONTEXTUAL"), note: "diputus oleh gerak oil 24 jam" },
  // F. Fiscal
  { code: "US_DEBT_CEILING", name: "US Debt Ceiling Crisis", category: "FISKAL", source: "Treasury", priority: "HIGH", match: /debt ceiling|debt limit|government shutdown/i,
    chain: "Krisis debt ceiling → risiko default → kepercayaan USD turun → emas naik", bias: same("BULLISH") },
  { code: "US_TREASURY_AUCTION", name: "US Treasury Auction", category: "FISKAL", source: "Treasury", priority: "HIGH", match: /(treasury|bond|note) auction|bid-to-cover|tail(?:ed)? auction/i,
    chain: "Lelang lemah (bid-to-cover turun) → yield naik → emas turun; kalau panik fiskal → emas naik", bias: { RATE: "BEARISH", CB: "BULLISH", MIXED: "CONTEXTUAL" } },
  { code: "US_TREASURY_INTERVENTION", name: "Treasury Buyback/Intervention", category: "FISKAL", source: "Treasury", priority: "HIGH", match: /buyback|treasury intervention|yield curve control/i,
    chain: "Treasury intervensi → yield turun → emas naik", bias: same("BULLISH") },
  { code: "US_FISCAL_STIMULUS", name: "US Fiscal Stimulus", category: "FISKAL", source: "Kongres", priority: "HIGH", match: /stimulus|spending bill|fiscal package|tax cut/i,
    chain: "Stimulus besar → utang naik → risiko debasement → emas naik", bias: { RATE: "NEUTRAL", CB: "BULLISH", MIXED: "BULLISH" } },
  { code: "US_DEBT_40T", name: "US Debt Threshold / Fiscal Risk", category: "FISKAL", source: "Treasury", priority: "HIGH", match: /national debt|\$\d+ ?trillion debt|debt (?:tops|surpasses|hits)|interest (?:expense|costs?) (?:tops|surpass)|credit rating|downgrade.*(us|u\.s\.|sovereign)/i,
    chain: "Utang naik → risiko fiskal naik → risiko kredit sovereign naik → emas naik", bias: same("BULLISH") },
  { code: "US_30Y_YIELD", name: "US 30Y Yield Spike", category: "FISKAL", source: "Market", priority: "HIGH", match: /30-year (?:yield|treasury|bond)|long bond|long-end/i,
    chain: "30Y > 5.3% → stres fiskal → safe haven → emas naik (logic switch)", bias: { RATE: "BEARISH", CB: "BULLISH", MIXED: "CONTEXTUAL" }, note: "di atas 5.3% logika pindah ke risiko fiskal" },
  // G. Dollar
  { code: "DE_DOLLARIZATION", name: "De-dollarization", category: "DOLAR", source: "Berita", priority: "MEDIUM", match: /de-?dollari[sz]ation|move away from the dollar|reduce (?:dollar|usd) reserves|brics currency/i,
    chain: "Negara kurangi cadangan USD → beli emas → emas naik", bias: same("BULLISH") },
  { code: "USD_CREDIT", name: "USD Credit Concern", category: "DOLAR", source: "Berita", priority: "MEDIUM", match: /confidence in the dollar|dollar (?:credibility|confidence)|reserve currency status/i,
    chain: "Kepercayaan USD turun → diversifikasi cadangan → emas naik", bias: same("BULLISH") },
  { code: "DXY_MOVE", name: "DXY Spike/Drop > 0.5%", category: "DOLAR", source: "Market", priority: "MEDIUM", match: /\b(dollar|dxy|greenback)\b.*\b(surge|jump|rall|slump|slide|drop|tumble|fall|high|low)/i,
    chain: "DXY naik → emas dalam USD lebih mahal → emas turun; DXY turun → emas naik", bias: same("CONTEXTUAL") },
  // H. Central banks
  { code: "CB_GOLD_SELL", name: "Central Bank Gold Sale", category: "BANK SENTRAL", source: "IMF/Berita", priority: "MEDIUM", match: /central bank.*(sell|sold|sale).*gold|gold (?:sale|selling) by/i,
    chain: "CB jual emas → supply naik → emas turun (jarang)", bias: same("BEARISH") },
  { code: "CN_PBOC_GOLD", name: "PBoC Gold Purchase", category: "BANK SENTRAL", source: "PBoC", priority: "MEDIUM", match: /pboc.*gold|china.*central bank.*gold|people's bank.*gold/i,
    chain: "China beli emas → permintaan struktural → emas naik", bias: same("BULLISH") },
  { code: "CB_GOLD_DATA", name: "IMF / WGC Gold Reserve Data", category: "BANK SENTRAL", source: "IMF/WGC", priority: "MEDIUM", match: /world gold council|imf.*(gold|reserve) data|gold reserves (?:rose|fell|data)/i,
    chain: "Data cadangan rilis → konfirmasi tren pembelian → emas naik/turun sesuai tren", bias: same("CONTEXTUAL") },
  { code: "CB_DIVERSIFY", name: "Reserve Diversification", category: "BANK SENTRAL", source: "Berita", priority: "MEDIUM", match: /reserve diversification|diversify.*reserves/i,
    chain: "Negara diversifikasi dari USD → beli emas → emas naik", bias: same("BULLISH") },
  { code: "CB_GOLD_BUY", name: "Central Bank Gold Purchase", category: "BANK SENTRAL", source: "IMF/Berita", priority: "MEDIUM", match: /central bank.*(buy|bought|purchas|add).*gold|gold (?:purchases|buying) by central banks|official sector.*gold/i,
    chain: "CB beli emas → permintaan naik → emas naik (lantai struktural)", bias: same("BULLISH") }
];

export function matchPlaybook(text: string, limit = 3): PlaybookEntry[] {
  const hits = PLAYBOOK.filter((p) => p.match.test(text));
  // Specific beats generic (core CPI over CPI, dot plot over FOMC): the list is ordered that way.
  const order: Record<Priority, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  return hits.sort((a, b) => order[a.priority] - order[b.priority]).slice(0, limit);
}
export function isPlaybookEvent(text: string): boolean { return PLAYBOOK.some((p) => p.match.test(text)); }
/** Owner-priority news that must always be reviewed by Sol: CRITICAL/HIGH playbook events from trusted sources. */
export function mustReview(text: string, sourceTier: number): boolean { const p = matchPlaybook(text, 1)[0]; return Boolean(p && sourceTier <= 2 && (p.priority === "CRITICAL" || p.priority === "HIGH")); }
export function priorityOf(name: string): Priority | undefined { return matchPlaybook(name, 1)[0]?.priority; }

const HAWK = /\b(hike|hikes|higher for longer|more work|not yet|premature|sticky|persistent|restrictive|tighten|upside risk|further increases?|vigilant|not confident)\b/i;
const DOVE = /\b(cut|cuts|easing|ease|progress|cooling|patient|downside risk|slowing|lower rates|accommodat|pause)\b/i;
export function fedTone(text: string): "HAWKISH" | "DOVISH" | "MIXED" | "UNCLEAR" {
  const h = HAWK.test(text), d = DOVE.test(text);
  return h && d ? "MIXED" : h ? "HAWKISH" : d ? "DOVISH" : "UNCLEAR";
}

export type Live = { linkage: Linkage; oil24h?: number; us30y?: number; dxy24h?: number };
export type Resolved = { code: string; name: string; priority: Priority; bias: GoldBias; chain: string; why: string };
/** Resolves an entry's bias for the current regime and live market numbers (the owner's conditional rules). */
export function resolveEntry(p: PlaybookEntry, text: string, live: Live): Resolved {
  let bias = p.bias[live.linkage];
  let why = `rezim ${live.linkage}`;
  const oil = live.oil24h;
  if (p.code === "GEO_CONFLICT" || p.code === "HORMUZ_CLOSURE" || p.code === "SANCTIONS") {
    if (oil !== undefined && oil > 5) { bias = live.linkage === "CB" ? "NEUTRAL" : "BEARISH"; why = `oil +${oil.toFixed(1)}% 24j (>5%): safe haven kalah sama logika rate${live.linkage === "CB" ? ", tapi rezim CB → turun terbatas" : ""}`; }
    else if (oil !== undefined && Math.abs(oil) < 2 && p.code === "GEO_CONFLICT") { bias = "BULLISH"; why = `oil stabil (${oil.toFixed(1)}%): logika klasik safe haven berlaku`; }
    else why = `oil ${oil === undefined ? "n/a" : `${oil.toFixed(1)}%`}: belum ada sinyal oil yang jelas`;
  }
  if (p.code === "OIL_SPIKE" && oil !== undefined) {
    if (oil > 3) { bias = live.linkage === "CB" ? "NEUTRAL" : "BEARISH"; why = `oil +${oil.toFixed(1)}% (>3%) di rezim ${live.linkage}`; }
  }
  if (p.code === "FED_SPEAK") {
    const tone = fedTone(text);
    bias = live.linkage === "CB" ? "NEUTRAL" : tone === "HAWKISH" ? "BEARISH" : tone === "DOVISH" ? "BULLISH" : "CONTEXTUAL";
    why = `nada ${tone}${live.linkage === "CB" ? ", rezim CB: pidato Fed cenderung noise" : ""}`;
  }
  if (p.code === "DXY_MOVE" && live.dxy24h !== undefined && Math.abs(live.dxy24h) > 0.5) { bias = live.dxy24h > 0 ? "BEARISH" : "BULLISH"; why = `DXY ${live.dxy24h.toFixed(2)}% 24j`; }
  // Fiscal override: a 30Y above 5.3% switches the logic toward sovereign risk.
  if (live.us30y !== undefined && live.us30y > 5.3 && ["OIL_SPIKE", "US_30Y_YIELD", "US_TREASURY_AUCTION"].includes(p.code)) { bias = "BULLISH"; why += `; 30Y ${live.us30y.toFixed(2)}% > 5.3% → stres fiskal, logika switch (override)`; }
  return { code: p.code, name: p.name, priority: p.priority, bias, chain: p.chain, why: p.note ? `${why}; ${p.note}` : why };
}

export function playbookPack(text: string, live: Live): string {
  const hits = matchPlaybook(text);
  if (!hits.length) return "";
  return `EVENT_PLAYBOOK (pemilik menganggap semua event ini penting; bias sesuai rezim & data live, bukan vonis otomatis):\n` +
    hits.map((p) => { const r = resolveEntry(p, text, live); return `- ${r.code} [${r.priority}] ${r.name}: ${r.chain} | bias sekarang ${r.bias} (${r.why})`; }).join("\n");
}

export const REGIME_RULES_SUMMARY = `REGIME RULES (owner): RATE regime — CPI up, strong NFP, hawkish Fed, oil spike, conflict+oil spike → gold DOWN. CB regime — CPI up → neutral/bullish, strong NFP → neutral, hawkish Fed → noise, oil spike → limited downside, conflict+oil spike → limited downside (central banks absorb). A 30Y yield above 5.3% switches the logic to fiscal/sovereign risk → gold UP. Conflict: check oil first (>5% → rate logic wins, gold down; oil stable → safe haven, gold up). Ceasefire can be gold-bullish via lower oil/inflation/Fed.`;
