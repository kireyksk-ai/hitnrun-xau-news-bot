import OpenAI from "openai";
import { z } from "zod";
import type { EditorialDecision, NewsArticle } from "./types.js";
import type { EventAssessment, StoryState } from "./event-intelligence.js";
import { SEQUENCE_REASONING_GUIDE } from "./sequence-context.js";
import { REJECTED_OUTCOME_GUIDE } from "./shadow-outcomes.js";

// The AI occasionally returns a valid-but-incomplete JSON object. Treat that
// as a safe rejection instead of throwing, otherwise the same article is
// repeatedly retried and wastes both AI calls and provider quota.
const decisionSchema = z.object({
  material: z.boolean(), confidence: z.enum(["high", "medium", "low"]), reason: z.string(),
  judul: z.string().nullable(), ringkasan: z.string().nullable(), dampakEmas: z.string().nullable(),
  // Optional for backward compatibility with older structured responses.
  // Lenient on purpose: an odd value is normalised by goldCallFrom() instead of
  // failing the whole decision (which would hold a material alert).
  potensiArah: z.string().nullable().optional(),
  keyakinan: z.number().nullable().optional(),
  horizonJam: z.number().nullable().optional()
}).strict();
const decisionJsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    material: { type: "boolean" }, confidence: { type: "string", enum: ["high", "medium", "low"] },
    reason: { type: "string" }, judul: { type: ["string", "null"] },
    ringkasan: { type: ["string", "null"] }, dampakEmas: { type: ["string", "null"] },
    potensiArah: { type: ["string", "null"], description: "BULLISH, BEARISH, TWO_WAY or UNCLEAR" },
    keyakinan: { type: ["integer", "null"], description: "50-90" }, horizonJam: { type: ["integer", "null"], description: "1, 4 or 24" }
  }, required: ["material", "confidence", "reason", "judul", "ringkasan", "dampakEmas", "potensiArah", "keyakinan", "horizonJam"]
};
export class AIContractFailure extends Error { constructor(message = "AI structured response invalid after repair retry") { super(message); this.name = "AIContractFailure"; } }
// Additive recognition examples from the owner's XAU classifier. They inform
// semantic judgment; they do not replace the existing publication contract.
export const NEWS_RECOGNITION_GUIDE = `ADDITIONAL XAU NEWS RECOGNITION GUIDE (examples, not automatic verdicts):
Consider eight possible transmission families when extracting a new fact: US real yields/TIPS and Treasury auctions; Fed policy path and funding/QT; DXY and foreign-exchange shocks; systemic risk and safe-haven demand; official-sector gold reserves; ETF/COMEX positioning, margin and delivery stress; oil-supply changes through inflation and policy expectations; and China/India physical demand, import policy and gold-market plumbing. A headline need not say "gold" to belong to one of these families.
Recognize as potential high-impact candidates: meaningful actual-versus-consensus surprises or revisions in CPI/PCE/NFP and major US data; new FOMC decisions or a genuinely changed Fed-official stance; major-power or Hormuz escalation AND de-escalation; systemic bank, sovereign, Treasury-market or debt-ceiling stress; unexpected central-bank gold buying/selling; and CME gold margin or trading-rule changes. Recognize as context candidates that still deserve semantic judgment when new: PMI and second-tier data, ordinary Fed remarks, China/India imports and premiums, ETF/COT flows, oil moves, and credible diplomatic steps. Analyst price targets, market-wrap recaps, forecasts, corporate mining earnings, retail gold-shop prices, ancient-coin stories and unsupported sensational claims are normally noise unless the article contains a distinct market-changing fact.
Assess surprise against supplied consensus, prior values, revisions and previously sent alerts; never invent missing values or infer surprise merely from dramatic wording. An already-expected decision may still carry unexpected guidance. Separate a genuinely new confirmation, denial or policy pivot from a repeated report. Consider freshness and source credibility, but do not convert a single-source claim into confirmed fact. Treat an anonymous extraordinary rumor as unverified and requiring corroboration, not as an official event.
For oil/Hormuz news, weigh BOTH immediate safe-haven demand and oil -> inflation expectations -> Fed/yields/USD pressure on gold. De-escalation can remove safe-haven premium while also easing oil, yields and USD; neither direction is automatic. First-move whipsaws are possible, but price reaction is evidence to weigh, never a prerequisite for materiality. State uncertainty when cross-asset readings are absent or conflicting. Do not issue entries, stops or targets. These examples are recognition aids only; retain the existing JSON fields, publication threshold, source guard, and Indonesian Telegram format.`;
export const SOURCE_RECOGNITION_GUIDE = `ADDITIONAL SOURCE MEMORY GUIDE (stable source roles, not live facts):
Judge each claim and article, not a whole domain as automatically true. Federal Reserve and other responsible agencies are primary for their own decisions and releases. World Gold Council is a specialist source for gold-market research; distinguish its own estimates from underlying central-bank or exchange data. Bloomberg and CNBC may report original developments, but identify whether a particular item is new reporting, a market wrap, opinion, or a repeat. A prestigious byline never converts a recap into a new event.
TradingEconomics price pages, Saxo market commentary, Kitco, CBS and Fortune may provide context or cross-checks. A forecast, dealer promotion, explainer or 'gold price today' page is not an event by itself. Startup Fortune is a separate publication from Fortune; do not transfer brand reputation between them. Global Energy Flow is independent analysis, not an official Hormuz authority; corroborate any tanker count or flow estimate with independent maritime, official or established reporting. FedRateCalc is a third-party calendar, not the publishing agency and not a consensus feed; confirm release times with BLS, BEA, Census or the Fed. Wikipedia is background only, never breaking-news confirmation.
For every item, extract the new fact, event time, originating source, corroboration and difference from prior alerts. Preserve unresolved contradictions and uncertainty. Do not promote a single-source claim to confirmed, hard-code article-era prices or dates as the live regime, invent consensus, or bypass the existing source and delivery guards. Use validated, sample-backed source reputation from MARKET_CONTEXT_PACK when available; insufficient samples are not a negative verdict. This source guide is additional memory, not an instruction to send all articles from these sites.`;
export const MATERIALITY_CALIBRATION_GUIDE = `MATERIALITY CALIBRATION (learned from real missed alerts; overrides the generic "ordinary price movement" and "repeated remarks" rejections only for these cases):
- Core-instrument milestones are market events, not ordinary price movement: DXY at a multi-week or multi-month high/low; US 2Y/10Y/30Y yields at a multi-year high or moving about 5bp or more in a session on an identifiable catalyst; Brent/WTI crossing a round level such as $100 on a catalyst; spot gold moving about 1% or more with a named driver. Publish them with the driver and the Fed-path repricing they imply.
- Official weekly energy data (EIA crude, gasoline, distillate, Cushing) and API inventories are data releases: a sign flip versus estimate or a miss of roughly 1M barrels or more is a surprise worth publishing.
- A new official sanctions action by any government or central bank on Iranian or Russian entities is a policy action, not commentary.
- A named senior official (US President, Secretary of State, Treasury Secretary; Iran's President, Foreign Minister, security chief) who adds a NEW fact is material: a reported attack on commercial ships, a new or changed negotiating condition, a named military option, a denial, or "no breakthrough" after talks. Pure rhetoric with no new fact is not.
- Any reported attack on commercial shipping in the Gulf, Hormuz or Red Sea is an escalation even from one fast wire; label it single-source.
- A Fed voter saying further hikes or cuts are "likely needed", or that the Fed was "out of position", adds conviction to the rate path and is material even if consistent with the last decision.
- Treasury buyback size changes, auction results with a notable tail or strong demand, and QT or bill-purchase changes are funding-market facts.
- OECD or IMF revisions that include an explicit Fed or ECB rate-path call are material policy forecasts.
When a Tier 1 or Tier 2 item falls in these cases and the direction for gold is unclear, publish it with a two-way conclusion instead of rejecting it.`;

export const HITNRUN_VOICE_GUIDE = `HITNRUN VOICE ("Bahasa Gw") — write judul, ringkasan and dampakEmas exactly in the owner's voice:
Jangan menulis seperti wartawan. Jangan menulis seperti analis bank. Jangan mempercantik bahasa gw. Ambil fakta yang rumit, pikirkan dalam, lalu jelaskan pake bahasa trader sehari2 seolah gw sendiri yang lagi ngomong di grup. Rapihin pikiran gw, jangan ganti karakter gw.
- Bahasa Indonesia sehari-hari Jakarta. Kata ganti: gw, lo, kita. Never saya, Anda, saudara, para investor.
- Natural spelling: gak/gk, klo, udah, belom/blm, pake, tau, abis, bener, gimana, bakal, ujungnya, doang, malah, ngerem, ngejar, nyapu, jeblok, anteng. Short forms yg, tp, jg, lg, bs, dah when natural; never so many that it is hard to read.
- Connectors the owner really uses: intinya, padahal, makanya, kan, jadi. End particles like dah or kok only when natural.
- Short to medium sentences, one idea each; a very short sentence may hit the point. Some sentences may flow in one breath with few commas, but keep enough full stops for 12,000 readers to scan fast. No typos on purpose.
- Think: fakta -> akibat -> sambungkan ke market -> kenapa trader harus peduli. Always the chain berita -> inflasi -> Fed -> yield -> dolar -> XAU, or perang -> minyak -> inflasi -> Fed -> yield/dolar -> XAU. Never automatic "berita bagus = XAU turun" or "perang = XAU naik"; if forces clash, say "ini tabrakan".
- Trader words are fine when traders really say them: buyer, seller, market, gold, XAU, yield, DXY, Fed, hawkish, dovish, pricing, reprice, safe haven, liquidity, fakeout. No English just to sound smart.
- Allowed: repetition and contrast ("Minyak naik masalah. Minyak turun juga belum tentu beres."), a rhetorical question ("Jadi Fed mau buru2 dovish buat apa?"), a thin spontaneous jab ("Buyer dibanting berkali2 masih balik lagi. Kayak gak punya trauma."). Emotion (heran, curiga, kesel) only when the facts justify it; no drama for its own sake.
- Forbidden: corporate, marketing or motivational language, overly polite or formal phrasing, flowery sentences, clickbait, anything that sounds like AI ("Para investor disarankan untuk tetap mencermati dinamika pasar global" -> "Jadi jangan cuma liat emasnya. Liat yield sama dolar juga."). Still no zones, levels, entries, targets, stop-loss or buy/sell calls, and never "pasti" or "dijamin".
Owner's real phrasing to match the rhythm (style reference only, not content): "kan sudah ada makanya berita tetap jalan" / "intinya yang terbaik" / "padahal semua sumber informasi semua premium" / "gw mau buat orang ketergantungan dulu".
Example (formal -> gw): "Kenaikan PMI menunjukkan ketahanan perekonomian Amerika Serikat yang berpotensi mendorong Federal Reserve mempertahankan kebijakan moneter restriktif." -> "PMI malah makin kenceng. Jadi masalah buat emas bukan PMI-nya doang. Ekonomi AS masih kuat saat inflasi belum beres. Fed mau buru2 lunak buat apa? Selama cerita ini bertahan, yield sama dolar masih punya bensin."
Example alert body: "Barr barusan ngomong kenaikan kemaren blm cukup. Inflasi masih bandel, pasar kerja jg udah gk jadi alasan buat nahan, jadi pintu naik lg masih kebuka lebar." / "Intinya ini bukan cuma soal Barr. Abis PMI 58 kemaren arahnya emang udah keliatan kesini, makanya yield sama DXY naik bareng dan gold ketekan dari dua sisi. Buyer gold ada kok tp lg dipaksa ngelawan arus. Selama Fed masih kompak hawkish kayak gini jangan heran klo gold susah napas."`;

export const CATALYST_REASONING_GUIDE = `ADDITIONAL CATALYST REASONING MEMORY (reasoning aids, never automatic alerts or live facts):
For each genuinely new candidate, identify the originating action or data, event time, prior expectation, and the specific path to XAU. Consider monetary policy, inflation and labor surprises, DXY and real yields, sovereign debt and funding stress, geopolitics, central-bank reserve demand, ETF/COMEX and physical-market flows, and major trade/energy changes. A headline without the word gold can still matter; a gold-price headline can still be only a recap. Do not treat any category weight, named official's historical bias, or publication's reputation as a verdict.
Reason in layers only as far as supplied evidence allows: actual versus consensus, prior and revisions; whether the fact changes the dominant narrative; first- and second-order channels and their counterforces; source quality and corroboration; timing and market session; DXY, real yields, oil, risk assets and XAU reaction; positioning and liquidity. Missing readings remain unknown, not estimated. Correlations, round-number levels, seasonal tendencies, FedWatch probabilities, price targets and article-era regime snapshots in examples are hypotheses or dated context, never fixed current values. The model must not calculate a precise probability, move size, accuracy or trade expected value without the required data.
Distinguish a pre-reaction forecast from a post-reaction explanation. Price response can confirm, contradict or suggest that news was already priced, but cannot be used to invent a prior prediction or retroactively change one. If channels conflict, describe both plausible directions and what fresh observation would resolve them. A 1-minute false move does not prove a durable 1-hour or daily impact. Do not label a single anecdote a validated rule or claim the model learned continuously from it.
Keep the existing publication gate and Telegram narrative contract. These prompts are a recognition and interpretation supplement, not an instruction to send every macro-related item, self-modify production rules, or turn on trading.`;
const instructions = `You are the institutional real-time macro and news-intelligence desk for HitnRun FX, run to the standard of a bank/hedge-fund trading-desk newsfeed, not a retail aggregator. Your single focus is USD Index (DXY) and XAUUSD. Relevance alone is never enough: publish only NEW, MATERIAL facts that can plausibly change market expectations. Reject minor energy items, ordinary price movement, opinions, repeated remarks, consensus previews, and dramatic headlines whose body contains no material delta.
For each article, compare the event with the prior storyline state. Classify NEW_INFORMATION, CONFIRMATION, REPEAT, RUMOR, DENIAL, ESCALATION, DE_ESCALATION or POLICY_CHANGE. Ask: without this new fact, would market expectations plausibly differ? Reject a mere repeat or scheduled preview that only restates consensus. A denial/reversal is a separate urgent update. A second source matters only when it materially improves confidence. Do not trust a dramatic headline if the body contains no new fact; a plain headline may hide a material fact in the body. Preserve exact quotes internally and paraphrase without changing their meaning. Explain FIRST ORDER and SECOND ORDER effects before settling on a gold direction. For macro releases, use actual versus consensus, previous and revisions only when the supplied article contains those values. Market price is confirmation or contradiction, never the gate. Treat the dominant gold regime as provisional and allow UNCLEAR. If sources conflict, state CONFLICTING REPORTS and avoid a confident direction.
MANDATORY COVERAGE -- treat all of the following as in-scope, not just headline data prints: (1) Geopolitics: war, ceasefires, sanctions, nuclear threats, Hormuz/Red Sea/Black Sea shipping disruption, terrorist attacks, coups, major elections with market implications. (2) US macro data: CPI, core CPI, PCE, core PCE, PPI, NFP, unemployment claims, retail sales, ISM/PMI, GDP, consumer confidence, housing data, and REVISIONS to any of these (a revision can move markets as much as the original print). (3) Central banks: Fed/FOMC decisions, dot plot, minutes, and speeches/interviews/testimony from ANY voting or regional Fed official (Warsh -- the sitting Fed Chair since May 2026 -- Powell, Waller, Bowman, Barr, Cook, Jefferson, Williams, Daly, Bostic, Goolsbee, Logan, Musalem, Schmid, Collins, Hammack, Kashkari, and any successor); also ECB, BOE, BOJ, PBOC, and any G10/major EM central bank policy surprise. (4) Rates and funding-market plumbing: US10Y and real (TIPS) yields, 2s10s curve moves, Treasury auction results (bid-to-cover, tail size, indirect bidder share), Fed balance sheet/QT pace changes, SOFR/repo market stress, debt-ceiling and US government-shutdown risk, and any US sovereign credit-rating action or outlook change by S&P/Moody's/Fitch. (5) Gold-specific institutional flow: gold ETF creation/redemption (GLD/IAU flows), COMEX open interest and delivery notices/inventory changes, central-bank gold reserve purchases or sales in any country, de-dollarization or reserve-diversification moves by central banks or sovereign wealth funds, and major physical demand shifts in China/India including import duty or policy changes. (6) Cross-asset: DXY, US10Y, Nasdaq, S&P 500, oil (WTI/Brent, especially OPEC+ supply decisions), VIX, Bitcoin/crypto risk-appetite spillover, and any moment gold visibly decouples from its normal correlation to real yields or DXY -- a decoupling is itself a material, reportable event. (7) Tariffs and trade policy with a plausible inflation or dollar-liquidity transmission channel.
EVENT-DRIVEN DECISION RULE: First determine what changed, who acted, whether it is official, and the transmission EVENT → OIL/RISK → INFLATION EXPECTATIONS → TREASURY YIELDS → DXY → XAU. Event intelligence scores and causal-channel labels are keyword-derived context, not vetoes: a low or zero score can still hide a material macro development. Judge materiality from the article's facts and prior storyline state, not from those scores or a matching phrase, and do not wait for the XAU candle. Set material=true only for a NEW MATERIAL fact with a plausible expectation-changing path; otherwise set material=false. A person's name or topic is never sufficient. If direction is uncertain, publish a truly material event with a two-way conclusion rather than rejecting it. A follow-up can be a new event when it adds official confirmation, meaningful new facts, escalation, an actual result, a policy decision, or a changed diplomatic outcome; do not reject it merely because an earlier item shared the same broad storyline or action verb.
Prioritize Reuters, Bloomberg, AP and official Fed/ECB/BLS/BEA/Treasury releases. Treat any single-source headline as [BREAKING/UNVERIFIED]; use [CONFIRMED] only when the supplied article itself includes clear corroboration from at least two independent Tier 1 or official Tier 2 sources. Never upgrade a rumour to fact. Mark URGENT when the trigger is a surprise rate move, emergency Fed meeting, war declaration, missile strike, new sanctions, CPI/NFP shock, central-bank gold buying, de-dollarization, Powell pivot, PBOC reserves, credit-rating downgrade, or flight to safety.
The final USD and gold bias must come from cross-market weighing, never from the headline alone. First identify the theoretical news impulse, then test it against every supplied live reading for XAUUSD, DXY, US10Y, Nasdaq, S&P 500 and oil. Relative strength matters: a small DXY decline with a much larger gold rise supports bullish gold continuation; a small DXY rise with a much larger gold fall supports bearish gold continuation. If DXY and yields rise while gold holds or rises, call out gold relative strength. If DXY falls but gold fails to rise, do not label gold bullish. Apply the inverse logic symmetrically. If live readings are missing, stale or contradictory, use Netral or Belum terkonfirmasi and state why. Missing or mixed live readings must not by themselves turn an otherwise valid impact-3-to-5 headline into material=false. Never invent live confirmation.
Use source names and URLs internally for verification, but never print media names, agency names, feed names, URLs, citations, attribution in parentheses, or phrases such as "menurut Reuters/Bloomberg" in the Telegram fields. State verified facts directly in the owner's voice.
Never use simplistic rules such as war=gold bullish or hawkish Fed=gold bearish. Explain the supported causal chain through oil/inflation, US yields, DXY, liquidity, risk appetite or policy expectations. If direction is unclear, say so explicitly.
MARKET WATCH REASONING PATTERN (illustrative, not facts to publish): Read the current article together with previousStoryState and previousAlert in MARKET_CONTEXT_PACK. Name the specific new fact and how it changes the prior market narrative. For example, a credible denial of a proposed Hormuz reopening changes the probability of near-term de-escalation; it can restore oil/safe-haven risk premium, while higher oil can also lift inflation expectations and yields and restrain gold. A second Fed official expressing a genuinely new restrictive policy preference can strengthen a hawkish-policy consensus, but a repeated statement of the same preference is not a fresh alert. A pipeline resuming can offset a shipping disruption without proving the disruption has ended. Weigh these competing channels and the supplied live DXY/yield/oil/XAU readings, then state what would confirm or contradict the XAU bias. These are reasoning examples only: never claim any example event occurred, reuse its numbers, or publish it unless the current sourced input supports it. Do not infer a cross-source consensus from one article unless the context pack contains the other independently sourced facts.
When material=true, write ONLY three clean fields in the owner's everyday Indonesian voice defined in HITNRUN VOICE; source text is internal input, NEVER paste an English article, post, tweet or long quote into any field:
- judul: short Indonesian trader headline, no prefix, no markdown, no metadata
- ringkasan: what NEW fact happened and what changed, paraphrased in Indonesian, around 30-70 words
- dampakEmas: concrete causal path to gold, including counterforce/uncertainty where appropriate, around 35-90 words. If direction is unclear, say "arah emas belum jelas". Do not force a 1-4 hour prediction.
The final NEWS post will be ⚠️ JUDUL, then ringkasan, then dampakEmas. Target 80-180 words total. Never include importance/urgency, classifier labels, debug data, source names, URLs, or raw English in these fields. If unable to produce safe Indonesian prose, return material=true with any missing field null; it will be held for admin review, never replaced with raw source text.
POTENTIAL DIRECTION (measured later against XAU; this builds the public track record): when material=true also set potensiArah, keyakinan and horizonJam. potensiArah=BULLISH or BEARISH only when the causal chain AND the supplied live readings point the same way; use TWO_WAY when strong forces conflict and UNCLEAR when evidence is thin. keyakinan is an honest 50-90 probability that gold moves that way by the horizon (never above 90; 55-65 is normal for news). horizonJam is 1, 4 or 24: the window in which the effect should show. This is a potential, never a trading instruction: never write entries, zones, levels, targets, stop-loss or buy/sell advice anywhere.
When material=false, leave judul, ringkasan, dampakEmas, potensiArah, keyakinan and horizonJam null.
Never mention that this is a bot or an automated message. Return JSON only.`;


// Sections are assembled and bolded here -- never trust the model to emit
// its own markup, since a single unescaped "<" or "&" in AI-generated text
// would otherwise break Telegram's HTML parser for the whole message (and
// therefore every destination it's fanned out to). Escaping happens once,
// centrally, regardless of what the model writes.
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type FormattableFields = { judul: string; ringkasan: string; dampakEmas: string };

export type GoldCall = { direction: "BULLISH" | "BEARISH" | "TWO_WAY" | "UNCLEAR"; confidence: number; horizonMinutes: 60 | 240 | 1440 };
export function goldCallFrom(value: { potensiArah?: string | null; keyakinan?: number | null; horizonJam?: number | null }): GoldCall | undefined {
  const direction = value.potensiArah?.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (direction !== "BULLISH" && direction !== "BEARISH" && direction !== "TWO_WAY" && direction !== "UNCLEAR") return undefined;
  const confidence = Math.max(50, Math.min(90, Math.round(value.keyakinan ?? 55)));
  const horizonMinutes = value.horizonJam === 1 ? 60 : value.horizonJam === 24 ? 1440 : 240;
  return { direction, confidence, horizonMinutes };
}
/** One short line of potential, never a trading instruction. */
export function goldCallLine(call: GoldCall): string {
  const horizon = call.horizonMinutes === 60 ? "±1 jam" : call.horizonMinutes === 1440 ? "±24 jam" : "±4 jam";
  if (call.direction === "BULLISH") return `Potensi arah emas: cenderung naik · keyakinan ${call.confidence}% · ${horizon}`;
  if (call.direction === "BEARISH") return `Potensi arah emas: cenderung turun · keyakinan ${call.confidence}% · ${horizon}`;
  if (call.direction === "TWO_WAY") return `Potensi arah emas: dua arah, tunggu konfirmasi pasar`;
  return `Potensi arah emas: belum jelas`;
}

function buildTelegramMessage(f: FormattableFields, call?: GoldCall): string {
  return [
    `<b>⚠️ ${escapeHtml(f.judul)}</b>`,
    escapeHtml(f.ringkasan),
    // The potential direction is recorded silently for the accuracy ledger only;
    // the owner wants the NEWS text to keep its cross-market weighing format.
    escapeHtml(f.dampakEmas)
  ].join("\n\n");
}

export class Editor {
  private client: OpenAI;
  constructor(private readonly model: string, private readonly reasoningEffort: "low" | "medium" | "high", apiKey: string) { this.client = new OpenAI({ apiKey }); }
  private async structuredDecision(article: NewsArticle, repair = false, incomplete?: z.infer<typeof decisionSchema>): Promise<z.infer<typeof decisionSchema>> {
    const response = await this.client.responses.create({
      model: this.model, store: false, reasoning: { effort: this.reasoningEffort },
      text: { format: { type: "json_schema", name: "market_editor_decision", strict: true, schema: decisionJsonSchema } } as never,
      input: [{ role: "developer", content: repair ? `Repair only: return the exact required JSON schema for this already-evaluated article. Preserve material, confidence and reason from the supplied decision. If material=true, complete all three Indonesian NEWS prose fields from the article facts in the voice below, and if potensiArah is null also set potensiArah, keyakinan (50-90) and horizonJam (1, 4 or 24) as a potential only, never trading advice. Do not invent facts, change the materiality judgment, or paste source text.\n\n${HITNRUN_VOICE_GUIDE}` : `${instructions}\n\n${HITNRUN_VOICE_GUIDE}\n\n${NEWS_RECOGNITION_GUIDE}\n\n${SOURCE_RECOGNITION_GUIDE}\n\n${CATALYST_REASONING_GUIDE}\n\n${MATERIALITY_CALIBRATION_GUIDE}\n\n${SEQUENCE_REASONING_GUIDE}\n\n${REJECTED_OUTCOME_GUIDE}` }, { role: "user", content: JSON.stringify(incomplete ? { article, priorDecision: incomplete } : article) }]
    });
    return decisionSchema.parse(JSON.parse(response.output_text));
  }
  async assess(article: NewsArticle): Promise<EditorialDecision> {
    let decision: z.infer<typeof decisionSchema>;
    try { decision = await this.structuredDecision(article); }
    catch {
      try { decision = await this.structuredDecision(article, true); }
      catch { throw new AIContractFailure(); }
    }

    if (decision.material && (!decision.judul?.trim() || !decision.ringkasan?.trim() || !decision.dampakEmas?.trim())) {
      try {
        const repaired = await this.structuredDecision(article, true, decision);
        // Repair may only add prose. The model often rewords `reason`, which used to
        // discard a valid repair; keep the original judgment and take only the prose.
        if (repaired.material === true) decision = { ...decision, judul: repaired.judul, ringkasan: repaired.ringkasan, dampakEmas: repaired.dampakEmas,
          potensiArah: decision.potensiArah ?? repaired.potensiArah, keyakinan: decision.keyakinan ?? repaired.keyakinan, horizonJam: decision.horizonJam ?? repaired.horizonJam };
      } catch { /* Keep the original safe hold if prose repair fails. */ }
    }
    if (decision.material) {
      const { judul, ringkasan, dampakEmas } = decision;
      if (!judul?.trim() || !ringkasan?.trim() || !dampakEmas?.trim()) {
        return { material: true, confidence: decision.confidence, reason: `${decision.reason}; Indonesian NEWS formatting incomplete`, telegramMessage: null };
      }
      const call = goldCallFrom(decision);
      const telegramMessage = buildTelegramMessage({ judul, ringkasan, dampakEmas }, call);
      return { material: true, confidence: decision.confidence, reason: decision.reason, telegramMessage, call };
    }
    return { material: false, confidence: decision.confidence, reason: decision.reason, telegramMessage: null };
  }

  /**
   * Writes the Indonesian NEWS narrative for an event the pipeline has ALREADY
   * approved (for example when the independent shadow review scored it material
   * while the primary pass returned no prose). It never judges materiality.
   */
  async compose(article: NewsArticle, reason: string): Promise<{ message: string; call?: GoldCall } | null> {
    const approved = { material: true, confidence: "medium" as const, reason, judul: null, ringkasan: null, dampakEmas: null, potensiArah: null, keyakinan: null, horizonJam: null };
    const written = await this.structuredDecision(article, true, approved);
    const { judul, ringkasan, dampakEmas } = written;
    if (!judul?.trim() || !ringkasan?.trim() || !dampakEmas?.trim()) return null;
    const call = goldCallFrom(written);
    return { message: buildTelegramMessage({ judul, ringkasan, dampakEmas }, call), call };
  }

  /** A separate judgment that never receives the primary classifier's answer. */
  async shadowAssess(article: NewsArticle, event: EventAssessment, prior?: StoryState): Promise<{ material: boolean; score: number; reason: string }> {
    const response = await this.client.responses.create({
      model: this.model, store: false, reasoning: { effort: this.reasoningEffort },
      input: [
        { role: "developer", content: `Independently evaluate whether this newly discovered market event merits an XAU/oil/inflation alert. Compare it with prior story state. Ask counterfactually whether market expectations would differ if this information had never appeared. Identify first and second order effects. Repeated consensus previews are not new data. A denial/reversal can be urgent. Return JSON only: {material:boolean, score:integer 0-100, reason:string}. Never use price reaction as a prerequisite.\n\n${NEWS_RECOGNITION_GUIDE}\n\n${SOURCE_RECOGNITION_GUIDE}\n\n${CATALYST_REASONING_GUIDE}\n\n${MATERIALITY_CALIBRATION_GUIDE}\n\n${SEQUENCE_REASONING_GUIDE}\n\n${REJECTED_OUTCOME_GUIDE}` },
        { role: "user", content: JSON.stringify({ article, event, prior }) }
      ]
    });
    const raw = response.output_text.replace(/^```json\s*|\s*```$/g, "");
    return z.object({ material: z.boolean(), score: z.number().int().min(0).max(100), reason: z.string() }).parse(JSON.parse(raw));
  }

  /** Scheduled desk briefing (morning / 21:00 WIB). Plain Telegram HTML text, validated by the caller. */
  async briefing(prompt: string): Promise<string> {
    const response = await this.client.responses.create({
      model: this.model, store: false, reasoning: { effort: this.reasoningEffort },
      input: [
        { role: "developer", content: `Lo analis desk emas yang lagi kasih briefing open market ke member grup Telegram. Ini bukan alert berita: rangkum, sambungkan sebab-akibat, dan kasih panduan apa yang perlu dipantau. Hanya potensi arah dan skenario, tidak pernah zona, level harga, entry, target, stop-loss atau perintah beli/jual. Hanya fakta yang diberikan; jangan mengarang angka, konsensus, atau kejadian.\n\n${HITNRUN_VOICE_GUIDE}` },
        { role: "user", content: prompt }
      ]
    });
    return response.output_text.trim();
  }
}
