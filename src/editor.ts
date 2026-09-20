import OpenAI from "openai";
import { z } from "zod";
import type { EditorialDecision, NewsArticle } from "./types.js";

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
  biasUsd: z.enum(["Bullish", "Bearish", "Netral"]).nullable().default(null),
  biasXau: z.enum(["Bullish", "Bearish", "Netral"]).nullable().default(null),
  alasanAnalis: z.string().nullable().default(null),
  catatanAksi: z.string().nullable().default(null)
}).passthrough();

const instructions = `You are the institutional real-time macro and news-intelligence desk for HitnRun FX. Your single focus is USD Index (DXY) and XAUUSD.
Approve only genuinely new, market-moving catalysts. Coverage is mandatory: (1) geopolitics, war, sanctions, ceasefires, nuclear threats, Hormuz/Red Sea and energy shipping disruptions; (2) US CPI, core CPI, PCE, core PCE, PPI, NFP, unemployment, retail sales, ISM and GDP; (3) Fed/FOMC, Powell, minutes, ECB, BOE, BOJ and PBOC policy shifts; (4) US10Y, DXY, gold ETF flows, central-bank gold buying and COT positioning; (5) risk-on/risk-off, VIX and US equity flight-to-safety.
Prioritize Reuters, Bloomberg, AP and official Fed/ECB/BLS/BEA releases. Treat any single-source headline as [BREAKING/UNVERIFIED]; use [CONFIRMED] only when the supplied article itself includes clear corroboration from at least two independent Tier 1 or official Tier 2 sources. Never upgrade a rumour to fact. Mark URGENT when the trigger is a surprise rate move, emergency Fed meeting, war declaration, missile strike, new sanctions, CPI/NFP shock, central-bank gold buying, de-dollarization, Powell pivot, PBOC reserves or flight to safety.
Reject stale, duplicate-like, clickbait, routine commentary and articles with no supported near-term DXY/XAU transmission channel. Never use simplistic rules such as war=gold bullish or hawkish Fed=gold bearish. Explain the supported causal chain through oil/inflation, US yields, DXY, liquidity, risk appetite or policy expectations. If direction is unclear, say so explicitly.
When material=true, write in informal but sharp Bahasa Indonesia and populate these separate fields instead of one preformatted block (a formatter will assemble and bold the final message, so keep each field plain text with no markdown/HTML and no manual section labels):
- waktuWIB: the article's published time converted to WIB, formatted "HH:MM WIB"
- levelDampak: integer 1-5 impact level
- statusTag: one of "BREAKING/UNVERIFIED", "CONFIRMED", "URGENT BREAKING/UNVERIFIED" or "URGENT CONFIRMED" (only prefix URGENT per the trigger rule above)
- judul: short punchy headline, no brackets, no trailing punctuation
- ringkasan: 2-3 sentences, the core summary only
- biasUsd: "Bullish" | "Bearish" | "Netral"
- biasXau: "Bullish" | "Bearish" | "Netral"
- alasanAnalis: the full causal chain, step by step: immediate impulse, what happens to inflation expectations/yields/DXY/liquidity/risk demand, the counterforce that could invalidate the first move, and why the stated USD/XAU bias follows; separate confirmed facts from desk inference; short paragraphs separated by a single newline if it helps readability, never bullet characters
- catatanAksi: the one or two data points or market reactions to monitor in the next 1-4 hours; no price zones and no investment advice
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
    `<b>Catatan Aksi Trader:</b>\n${escapeHtml(f.catatanAksi)}`
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
      const { waktuWIB, levelDampak, statusTag, judul, ringkasan, biasUsd, biasXau, alasanAnalis, catatanAksi } = decision;
      if (waktuWIB === null || levelDampak === null || statusTag === null || judul === null || ringkasan === null || biasUsd === null || biasXau === null || alasanAnalis === null || catatanAksi === null) {
        return { material: false, confidence: decision.confidence, reason: "Output analisis tidak lengkap; artikel dilewati secara aman.", telegramMessage: null };
      }
      const telegramMessage = buildTelegramMessage({ waktuWIB, levelDampak, statusTag, judul, ringkasan, biasUsd, biasXau, alasanAnalis, catatanAksi });
      return { material: true, confidence: decision.confidence, reason: decision.reason, telegramMessage };
    }
    return { material: false, confidence: decision.confidence, reason: decision.reason, telegramMessage: null };
  }
}
