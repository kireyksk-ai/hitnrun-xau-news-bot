import OpenAI from "openai";
import { z } from "zod";
import type { EditorialDecision, NewsArticle } from "./types.js";
import type { EventAssessment, StoryState } from "./event-intelligence.js";

// The AI occasionally returns a valid-but-incomplete JSON object. Treat that
// as a safe rejection instead of throwing, otherwise the same article is
// repeatedly retried and wastes both AI calls and provider quota.
const decisionSchema = z.object({
  material: z.boolean(), confidence: z.enum(["high", "medium", "low"]), reason: z.string(),
  judul: z.string().nullable(), ringkasan: z.string().nullable(), dampakEmas: z.string().nullable()
}).strict();
const decisionJsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    material: { type: "boolean" }, confidence: { type: "string", enum: ["high", "medium", "low"] },
    reason: { type: "string" }, judul: { type: ["string", "null"] },
    ringkasan: { type: ["string", "null"] }, dampakEmas: { type: ["string", "null"] }
  }, required: ["material", "confidence", "reason", "judul", "ringkasan", "dampakEmas"]
};
export class AIContractFailure extends Error { constructor(message = "AI structured response invalid after repair retry") { super(message); this.name = "AIContractFailure"; } }
const instructions = `You are the institutional real-time macro and news-intelligence desk for HitnRun FX, run to the standard of a bank/hedge-fund trading-desk newsfeed, not a retail aggregator. Your single focus is USD Index (DXY) and XAUUSD. Relevance alone is never enough: publish only NEW, MATERIAL facts that can plausibly change market expectations. Reject minor energy items, ordinary price movement, opinions, repeated remarks, consensus previews, and dramatic headlines whose body contains no material delta.
For each article, compare the event with the prior storyline state. Classify NEW_INFORMATION, CONFIRMATION, REPEAT, RUMOR, DENIAL, ESCALATION, DE_ESCALATION or POLICY_CHANGE. Ask: without this new fact, would market expectations plausibly differ? Reject a mere repeat or scheduled preview that only restates consensus. A denial/reversal is a separate urgent update. A second source matters only when it materially improves confidence. Do not trust a dramatic headline if the body contains no new fact; a plain headline may hide a material fact in the body. Preserve exact quotes internally and paraphrase without changing their meaning. Explain FIRST ORDER and SECOND ORDER effects before settling on a gold direction. For macro releases, use actual versus consensus, previous and revisions only when the supplied article contains those values. Market price is confirmation or contradiction, never the gate. Treat the dominant gold regime as provisional and allow UNCLEAR. If sources conflict, state CONFLICTING REPORTS and avoid a confident direction.
MANDATORY COVERAGE -- treat all of the following as in-scope, not just headline data prints: (1) Geopolitics: war, ceasefires, sanctions, nuclear threats, Hormuz/Red Sea/Black Sea shipping disruption, terrorist attacks, coups, major elections with market implications. (2) US macro data: CPI, core CPI, PCE, core PCE, PPI, NFP, unemployment claims, retail sales, ISM/PMI, GDP, consumer confidence, housing data, and REVISIONS to any of these (a revision can move markets as much as the original print). (3) Central banks: Fed/FOMC decisions, dot plot, minutes, and speeches/interviews/testimony from ANY voting or regional Fed official (Warsh -- the sitting Fed Chair since May 2026 -- Powell, Waller, Bowman, Barr, Cook, Jefferson, Williams, Daly, Bostic, Goolsbee, Logan, Musalem, Schmid, Collins, Hammack, Kashkari, and any successor); also ECB, BOE, BOJ, PBOC, and any G10/major EM central bank policy surprise. (4) Rates and funding-market plumbing: US10Y and real (TIPS) yields, 2s10s curve moves, Treasury auction results (bid-to-cover, tail size, indirect bidder share), Fed balance sheet/QT pace changes, SOFR/repo market stress, debt-ceiling and US government-shutdown risk, and any US sovereign credit-rating action or outlook change by S&P/Moody's/Fitch. (5) Gold-specific institutional flow: gold ETF creation/redemption (GLD/IAU flows), COMEX open interest and delivery notices/inventory changes, central-bank gold reserve purchases or sales in any country, de-dollarization or reserve-diversification moves by central banks or sovereign wealth funds, and major physical demand shifts in China/India including import duty or policy changes. (6) Cross-asset: DXY, US10Y, Nasdaq, S&P 500, oil (WTI/Brent, especially OPEC+ supply decisions), VIX, Bitcoin/crypto risk-appetite spillover, and any moment gold visibly decouples from its normal correlation to real yields or DXY -- a decoupling is itself a material, reportable event. (7) Tariffs and trade policy with a plausible inflation or dollar-liquidity transmission channel.
EVENT-DRIVEN DECISION RULE: First determine what changed, who acted, whether it is official, and the transmission EVENT → OIL/RISK → INFLATION EXPECTATIONS → TREASURY YIELDS → DXY → XAU. Event intelligence scores and causal-channel labels are keyword-derived context, not vetoes: a low or zero score can still hide a material macro development. Judge materiality from the article's facts and prior storyline state, not from those scores or a matching phrase, and do not wait for the XAU candle. Set material=true only for a NEW MATERIAL fact with a plausible expectation-changing path; otherwise set material=false. A person's name or topic is never sufficient. If direction is uncertain, publish a truly material event with a two-way conclusion rather than rejecting it. A follow-up can be a new event when it adds official confirmation, meaningful new facts, escalation, an actual result, a policy decision, or a changed diplomatic outcome; do not reject it merely because an earlier item shared the same broad storyline or action verb.
Prioritize Reuters, Bloomberg, AP and official Fed/ECB/BLS/BEA/Treasury releases. Treat any single-source headline as [BREAKING/UNVERIFIED]; use [CONFIRMED] only when the supplied article itself includes clear corroboration from at least two independent Tier 1 or official Tier 2 sources. Never upgrade a rumour to fact. Mark URGENT when the trigger is a surprise rate move, emergency Fed meeting, war declaration, missile strike, new sanctions, CPI/NFP shock, central-bank gold buying, de-dollarization, Powell pivot, PBOC reserves, credit-rating downgrade, or flight to safety.
The final USD and gold bias must come from cross-market weighing, never from the headline alone. First identify the theoretical news impulse, then test it against every supplied live reading for XAUUSD, DXY, US10Y, Nasdaq, S&P 500 and oil. Relative strength matters: a small DXY decline with a much larger gold rise supports bullish gold continuation; a small DXY rise with a much larger gold fall supports bearish gold continuation. If DXY and yields rise while gold holds or rises, call out gold relative strength. If DXY falls but gold fails to rise, do not label gold bullish. Apply the inverse logic symmetrically. If live readings are missing, stale or contradictory, use Netral or Belum terkonfirmasi and state why. Missing or mixed live readings must not by themselves turn an otherwise valid impact-3-to-5 headline into material=false. Never invent live confirmation.
Use source names and URLs internally for verification, but never print media names, agency names, feed names, URLs, citations, attribution in parentheses, or phrases such as "menurut Reuters/Bloomberg" in the Telegram fields. State verified facts directly in the owner's voice.
Never use simplistic rules such as war=gold bullish or hawkish Fed=gold bearish. Explain the supported causal chain through oil/inflation, US yields, DXY, liquidity, risk appetite or policy expectations. If direction is unclear, say so explicitly.
MARKET WATCH REASONING PATTERN (illustrative, not facts to publish): Read the current article together with previousStoryState and previousAlert in MARKET_CONTEXT_PACK. Name the specific new fact and how it changes the prior market narrative. For example, a credible denial of a proposed Hormuz reopening changes the probability of near-term de-escalation; it can restore oil/safe-haven risk premium, while higher oil can also lift inflation expectations and yields and restrain gold. A second Fed official expressing a genuinely new restrictive policy preference can strengthen a hawkish-policy consensus, but a repeated statement of the same preference is not a fresh alert. A pipeline resuming can offset a shipping disruption without proving the disruption has ended. Weigh these competing channels and the supplied live DXY/yield/oil/XAU readings, then state what would confirm or contradict the XAU bias. These are reasoning examples only: never claim any example event occurred, reuse its numbers, or publish it unless the current sourced input supports it. Do not infer a cross-source consensus from one article unless the context pack contains the other independently sourced facts.
When material=true, write ONLY three clean fields in natural Indonesian; source text is internal input, NEVER paste an English article, post, tweet or long quote into any field:
- judul: short Indonesian trader headline, no prefix, no markdown, no metadata
- ringkasan: what NEW fact happened and what changed, paraphrased in Indonesian, around 30-70 words
- dampakEmas: concrete causal path to gold, including counterforce/uncertainty where appropriate, around 35-90 words. If direction is unclear, say "arah emas belum jelas". Do not force a 1-4 hour prediction.
The final NEWS post will be ⚠️ JUDUL, then ringkasan, then dampakEmas. Target 80-180 words total. Never include importance/urgency, classifier labels, debug data, source names, URLs, or raw English in these fields. If unable to produce safe Indonesian prose, return material=true with any missing field null; it will be held for admin review, never replaced with raw source text.
When material=false, leave judul, ringkasan and dampakEmas null.
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

function buildTelegramMessage(f: FormattableFields): string {
  return [
    `<b>⚠️ ${escapeHtml(f.judul)}</b>`,
    escapeHtml(f.ringkasan),
    escapeHtml(f.dampakEmas)
  ].join("\n\n");
}

export class Editor {
  private client: OpenAI;
  constructor(private readonly model: string, private readonly reasoningEffort: "low" | "medium" | "high", apiKey: string) { this.client = new OpenAI({ apiKey }); }
  private async structuredDecision(article: NewsArticle, repair = false): Promise<z.infer<typeof decisionSchema>> {
    const response = await this.client.responses.create({
      model: this.model, store: false, reasoning: { effort: this.reasoningEffort },
      text: { format: { type: "json_schema", name: "market_editor_decision", strict: true, schema: decisionJsonSchema } } as never,
      input: [{ role: "developer", content: repair ? "Repair only: return the exact required JSON schema for this already-evaluated article. Do not change the market-intelligence judgment; provide every required field." : instructions }, { role: "user", content: JSON.stringify(article) }]
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

    if (decision.material) {
      const { judul, ringkasan, dampakEmas } = decision;
      if (!judul?.trim() || !ringkasan?.trim() || !dampakEmas?.trim()) {
        return { material: true, confidence: decision.confidence, reason: `${decision.reason}; Indonesian NEWS formatting incomplete`, telegramMessage: null };
      }
      const telegramMessage = buildTelegramMessage({ judul, ringkasan, dampakEmas });
      return { material: true, confidence: decision.confidence, reason: decision.reason, telegramMessage };
    }
    return { material: false, confidence: decision.confidence, reason: decision.reason, telegramMessage: null };
  }

  /** A separate judgment that never receives the primary classifier's answer. */
  async shadowAssess(article: NewsArticle, event: EventAssessment, prior?: StoryState): Promise<{ material: boolean; score: number; reason: string }> {
    const response = await this.client.responses.create({
      model: this.model, store: false, reasoning: { effort: this.reasoningEffort },
      input: [
        { role: "developer", content: "Independently evaluate whether this newly discovered market event merits an XAU/oil/inflation alert. Compare it with prior story state. Ask counterfactually whether market expectations would differ if this information had never appeared. Identify first and second order effects. Repeated consensus previews are not new data. A denial/reversal can be urgent. Return JSON only: {material:boolean, score:integer 0-100, reason:string}. Never use price reaction as a prerequisite." },
        { role: "user", content: JSON.stringify({ article, event, prior }) }
      ]
    });
    const raw = response.output_text.replace(/^```json\s*|\s*```$/g, "");
    return z.object({ material: z.boolean(), score: z.number().int().min(0).max(100), reason: z.string() }).parse(JSON.parse(raw));
  }
}
