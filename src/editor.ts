import OpenAI from "openai";
import { z } from "zod";
import type { EditorialDecision, NewsArticle } from "./types.js";
import type { EventAssessment, StoryState } from "./event-intelligence.js";

// The AI occasionally returns a valid-but-incomplete JSON object. Treat that
// as a safe rejection instead of throwing, otherwise the same article is
// repeatedly retried and wastes both AI calls and provider quota.
const decisionSchema = z.object({
  material: z.boolean().default(false),
  confidence: z.enum(["high", "medium", "low"]).default("low"),
  reason: z.string().default("Output analisis tidak lengkap; artikel dilewati secara aman."),
  waktuWIB: z.string().nullable().default(null),
  levelDampak: z.number().int().min(1).max(5).nullable().default(null),
  statusTag: z.string().nullable().default(null),
  judul: z.string().nullable().default(null),
  ringkasan: z.string().nullable().default(null),
  biasUsd: z.enum(["Bullish", "Bearish", "Netral", "Belum terkonfirmasi"]).nullable().default(null),
  biasXau: z.enum(["Bullish", "Bearish", "Netral", "Belum terkonfirmasi"]).nullable().default(null),
  alasanAnalis: z.string().nullable().default(null),
  catatanAksi: z.string().nullable().default(null),
  // Accept the legacy complete-message shape too; it is a safe recovery path
  // when a model supplies sound analysis but omits one of the presentation fields.
  telegramMessage: z.string().nullable().optional()
}).passthrough();
const instructions = `You are the institutional real-time macro and news-intelligence desk for HitnRun FX, run to the standard of a bank/hedge-fund trading-desk newsfeed, not a retail aggregator. Your single focus is USD Index (DXY) and XAUUSD. Relevance alone is never enough: publish only NEW, MATERIAL facts that can plausibly change market expectations. Reject minor energy items, ordinary price movement, opinions, repeated remarks, consensus previews, and dramatic headlines whose body contains no material delta.
For each article, compare the event with the prior storyline state. Classify NEW_INFORMATION, CONFIRMATION, REPEAT, RUMOR, DENIAL, ESCALATION, DE_ESCALATION or POLICY_CHANGE. Ask: without this new fact, would market expectations plausibly differ? Reject a mere repeat or scheduled preview that only restates consensus. A denial/reversal is a separate urgent update. A second source matters only when it materially improves confidence. Do not trust a dramatic headline if the body contains no new fact; a plain headline may hide a material fact in the body. Preserve exact quotes internally and paraphrase without changing their meaning. Explain FIRST ORDER and SECOND ORDER effects before settling on a gold direction. For macro releases, use actual versus consensus, previous and revisions only when the supplied article contains those values. Market price is confirmation or contradiction, never the gate. Treat the dominant gold regime as provisional and allow UNCLEAR. If sources conflict, state CONFLICTING REPORTS and avoid a confident direction.
MANDATORY COVERAGE -- treat all of the following as in-scope, not just headline data prints: (1) Geopolitics: war, ceasefires, sanctions, nuclear threats, Hormuz/Red Sea/Black Sea shipping disruption, terrorist attacks, coups, major elections with market implications. (2) US macro data: CPI, core CPI, PCE, core PCE, PPI, NFP, unemployment claims, retail sales, ISM/PMI, GDP, consumer confidence, housing data, and REVISIONS to any of these (a revision can move markets as much as the original print). (3) Central banks: Fed/FOMC decisions, dot plot, minutes, and speeches/interviews/testimony from ANY voting or regional Fed official (Warsh -- the sitting Fed Chair since May 2026 -- Powell, Waller, Bowman, Barr, Cook, Jefferson, Williams, Daly, Bostic, Goolsbee, Logan, Musalem, Schmid, Collins, Hammack, Kashkari, and any successor); also ECB, BOE, BOJ, PBOC, and any G10/major EM central bank policy surprise. (4) Rates and funding-market plumbing: US10Y and real (TIPS) yields, 2s10s curve moves, Treasury auction results (bid-to-cover, tail size, indirect bidder share), Fed balance sheet/QT pace changes, SOFR/repo market stress, debt-ceiling and US government-shutdown risk, and any US sovereign credit-rating action or outlook change by S&P/Moody's/Fitch. (5) Gold-specific institutional flow: gold ETF creation/redemption (GLD/IAU flows), COMEX open interest and delivery notices/inventory changes, central-bank gold reserve purchases or sales in any country, de-dollarization or reserve-diversification moves by central banks or sovereign wealth funds, and major physical demand shifts in China/India including import duty or policy changes. (6) Cross-asset: DXY, US10Y, Nasdaq, S&P 500, oil (WTI/Brent, especially OPEC+ supply decisions), VIX, Bitcoin/crypto risk-appetite spillover, and any moment gold visibly decouples from its normal correlation to real yields or DXY -- a decoupling is itself a material, reportable event. (7) Tariffs and trade policy with a plausible inflation or dollar-liquidity transmission channel.
EVENT-DRIVEN DECISION RULE: Every input includes an Event intelligence score and reasons. First determine what changed, who acted, whether it is official, and the transmission EVENT → OIL/RISK → INFLATION EXPECTATIONS → TREASURY YIELDS → DXY → XAU. Do not decide from keyword matching and do not wait for the XAU candle. Set material=true for score 80–100 ONLY if the underlying fact is new and material. For score 65–79, set material=true only with reliable corroboration or a significant expectation change. Set material=false below 65. HIGH-PRIORITY OVERRIDE applies ONLY to a NEW MATERIAL Trump statement, Fed decision/material statement, top-tier US macro surprise, major war/ceasefire/strike, Hormuz or major oil-supply disruption, or major sanctions/tariffs. A person's name or topic is never sufficient. If direction is uncertain, publish a truly material event with a two-way conclusion rather than rejecting it. A follow-up is a new event only when it adds an official confirmation that materially changes certainty, escalation, actual result, policy decision, or a changed diplomatic outcome.
Prioritize Reuters, Bloomberg, AP and official Fed/ECB/BLS/BEA/Treasury releases. Treat any single-source headline as [BREAKING/UNVERIFIED]; use [CONFIRMED] only when the supplied article itself includes clear corroboration from at least two independent Tier 1 or official Tier 2 sources. Never upgrade a rumour to fact. Mark URGENT when the trigger is a surprise rate move, emergency Fed meeting, war declaration, missile strike, new sanctions, CPI/NFP shock, central-bank gold buying, de-dollarization, Powell pivot, PBOC reserves, credit-rating downgrade, or flight to safety.
The final USD and gold bias must come from cross-market weighing, never from the headline alone. First identify the theoretical news impulse, then test it against every supplied live reading for XAUUSD, DXY, US10Y, Nasdaq, S&P 500 and oil. Relative strength matters: a small DXY decline with a much larger gold rise supports bullish gold continuation; a small DXY rise with a much larger gold fall supports bearish gold continuation. If DXY and yields rise while gold holds or rises, call out gold relative strength. If DXY falls but gold fails to rise, do not label gold bullish. Apply the inverse logic symmetrically. If live readings are missing, stale or contradictory, use Netral or Belum terkonfirmasi and state why. Missing or mixed live readings must not by themselves turn an otherwise valid impact-3-to-5 headline into material=false. Never invent live confirmation.
Use source names and URLs internally for verification, but never print media names, agency names, feed names, URLs, citations, attribution in parentheses, or phrases such as "menurut Reuters/Bloomberg" in the Telegram fields. State verified facts directly in the owner's voice.
Never use simplistic rules such as war=gold bullish or hawkish Fed=gold bearish. Explain the supported causal chain through oil/inflation, US yields, DXY, liquidity, risk appetite or policy expectations. If direction is unclear, say so explicitly.
When material=true, write in informal but sharp Bahasa Indonesia and populate these separate fields instead of one preformatted block (a formatter will assemble and bold the final message, so keep each field plain text with no markdown/HTML and no manual section labels):
- waktuWIB: the article's published time converted to WIB, formatted "HH:MM WIB"
- levelDampak: integer 1-5 impact level
- statusTag: one of "BREAKING/UNVERIFIED", "CONFIRMED", "URGENT BREAKING/UNVERIFIED" or "URGENT CONFIRMED" (only prefix URGENT per the trigger rule above)
- judul: short punchy headline, no brackets, no trailing punctuation
- ringkasan: 2-3 sentences, the core summary only
- biasUsd: "Bullish" | "Bearish" | "Netral" | "Belum terkonfirmasi"; final conclusion after weighing the supplied live market snapshot
- biasXau: "Bullish" | "Bearish" | "Netral" | "Belum terkonfirmasi"; final conclusion after weighing the supplied live market snapshot
- alasanAnalis: the full causal chain, step by step: immediate impulse, what happens to inflation expectations/yields/DXY/liquidity/risk demand, the counterforce that could invalidate the first move, and why the stated USD/XAU bias follows; separate confirmed facts from desk inference; short paragraphs separated by a single newline if it helps readability, never bullet characters
- catatanAksi: the already-weighed desk conclusion for the most likely XAUUSD/DXY behavior over the next 1-4 hours, its strength, and the exact condition that invalidates it. Do not tell readers to monitor, watch, check, wait for, or compare anything themselves. Never output a checklist such as "pantau DXY/US10Y/oil". If confirmation is insufficient, state directly that no directional edge is confirmed and why; no price zones and no investment advice
CRITICAL: fill all nine fields whenever possible. If a format field cannot be completed, still set material=true for a relevant headline; the system will safely publish the factual headline using its fallback format rather than suppress it.
When material=false, leave all of the fields above null.
Never mention that this is a bot or an automated message. Return JSON only.`;


// Sections are assembled and bolded here -- never trust the model to emit
// its own markup, since a single unescaped "<" or "&" in AI-generated text
// would otherwise break Telegram's HTML parser for the whole message (and
// therefore every destination it's fanned out to). Escaping happens once,
// centrally, regardless of what the model writes.
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type FormattableFields = {
  waktuWIB: string; levelDampak: number; statusTag: string; judul: string; ringkasan: string;
  biasUsd: string; biasXau: string; alasanAnalis: string; catatanAksi: string;
};

function buildTelegramMessage(f: FormattableFields): string {
  return [
    `<b>${escapeHtml(f.waktuWIB)} | Level Dampak: ${f.levelDampak} | ${escapeHtml(f.statusTag)}</b>`,
    `<b>${escapeHtml(f.judul)}</b>`,
    "",
    `<b>Ringkasan:</b> ${escapeHtml(f.ringkasan)}`,
    "",
    `<b>Bias Dampak:</b> USD ${escapeHtml(f.biasUsd)} | Emas ${escapeHtml(f.biasXau)}`,
    "",
    `<b>Alasan Analis:</b>\n${escapeHtml(f.alasanAnalis)}`,
    "",
    `<b>Kesimpulan 1-4 Jam:</b>\n${escapeHtml(f.catatanAksi)}`
  ].join("\n");
}

export class Editor {
  private client: OpenAI;
  constructor(private readonly model: string, private readonly reasoningEffort: "low" | "medium" | "high", apiKey: string) { this.client = new OpenAI({ apiKey }); }
  async assess(article: NewsArticle): Promise<EditorialDecision> {
    const response = await this.client.responses.create({
      model: this.model, store: false, reasoning: { effort: this.reasoningEffort },
      input: [{ role: "developer", content: instructions }, { role: "user", content: JSON.stringify(article) }]
    });
    const raw = response.output_text.replace(/^\`\`\`json\s*|\s*\`\`\`$/g, "");
    const parsed: unknown = JSON.parse(raw);
    const decision = decisionSchema.parse(parsed);

    // Never publish a partial response. If it says "material" but any of the
    // fields needed to assemble the message are missing, convert it to a
    // safe rejection and remember the article instead of sending a broken one.
    if (decision.material) {
      const { waktuWIB, levelDampak, statusTag, judul, ringkasan, biasUsd, biasXau, alasanAnalis, catatanAksi, telegramMessage: legacyTelegramMessage } = decision;
      if (waktuWIB === null || levelDampak === null || statusTag === null || judul === null || ringkasan === null || biasUsd === null || biasXau === null || alasanAnalis === null || catatanAksi === null) {
        const missingFields = Object.entries({ waktuWIB, levelDampak, statusTag, judul, ringkasan, biasUsd, biasXau, alasanAnalis, catatanAksi }).filter(([, v]) => v === null).map(([k]) => k);
        // Do not silently lose a valid XAU catalyst because an otherwise valid
        // response missed presentation metadata. Prefer a legacy completed post,
        // otherwise publish a clearly-labeled neutral fallback based only on
        // the supplied headline and summary.
        if (legacyTelegramMessage?.trim()) {
          console.warn({ title: article.title, provider: article.provider, missingFields }, "Using legacy complete Telegram message after structured fields were incomplete");
          return { material: true, confidence: decision.confidence, reason: decision.reason, telegramMessage: legacyTelegramMessage.trim() };
        }
        const fallbackTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false }).format(article.publishedAt);
        const fallbackMessage = [
          `<b>${fallbackTime} WIB | Level Dampak: 3 | BREAKING/UNVERIFIED</b>`,
          `<b>${escapeHtml(article.title)}</b>`,
          "",
          `<b>Ringkasan:</b> ${escapeHtml(article.summary)}`,
          "",
          "<b>Bias Dampak:</b> USD Belum terkonfirmasi | Emas Belum terkonfirmasi",
          "",
          "<b>Alasan Analis:</b> Headline ini lolos sebagai katalis material untuk USD dan emas. Detail dampak arahnya belum bisa dipastikan karena respons analisis terstruktur tidak lengkap; fakta headline tetap dikirim agar tidak terlewat.",
          "",
          "<b>Kesimpulan 1-4 Jam:</b> Ada risiko pergerakan meningkat, tetapi arah bersih belum terkonfirmasi dari data yang tersedia."
        ].join("\n");
        console.warn({ title: article.title, provider: article.provider, missingFields }, "Publishing neutral fallback after structured fields were incomplete");
        return { material: true, confidence: decision.confidence, reason: decision.reason, telegramMessage: fallbackMessage };
      }
      // Formatting follows a separate materiality decision; an impact label
      // never overrides the new-and-material publication gate.
      const telegramMessage = buildTelegramMessage({ waktuWIB, levelDampak, statusTag, judul, ringkasan, biasUsd, biasXau, alasanAnalis, catatanAksi });
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

