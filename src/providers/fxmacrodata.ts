import type { NewsArticle, NewsProvider } from "../types.js";

// FXMacroData -- direct-from-source US macro releases (CPI, NFP, PCE, GDP, Fed funds
// rate, jobless claims, retail sales, and more), the "economic calendar with actual
// numbers" layer this bot never had before. Every other provider in this repo reports
// on news ABOUT macro data; this one reports the data itself, straight from the
// publisher (Fed, BLS, Census, Treasury) -- closing the single biggest structural gap
// flagged this session: the bot had zero awareness of scheduled US data releases,
// only reactive news about them after the fact.
//
// Individual plan: $100/mo, 1,000,000 requests/month, all 22 currencies + full
// history (fxmacrodata.com/subscribe, verified live against their own pricing page --
// NOT the $25/mo figure pitched in a third-party roundup article, which does not
// match what FXMacroData itself charges). Also exposes a weekly CFTC Commitment of
// Traders (COT) futures-positioning endpoint (/cot/{currency}) -- not wired in yet,
// worth adding as a fast follow once this base layer is confirmed working.
//
// Requires FXMACRODATA_API_KEY. Disabled (skipped, not thrown) when absent, same
// pattern as every other optional provider in this repo.
//
// Field names below came from a real anonymous/delayed sample pull of this exact
// endpoint, not just the docs -- but that sample did not show an explicit
// forecast/consensus field, so this provider treats "forecast" as unconfirmed/optional
// rather than assuming a field name that might not exist. Watch Render's Logs tab
// after the key is set; if a `forecast` (or similarly named) field shows up in real
// paid-tier responses, flag it and it can get wired into the message so the AI editor
// can judge beat-vs-miss, not just level-vs-previous.
const CURRENCY = "usd";

type FxMacroIndicator = {
    indicator?: string;
    name?: string;
    source?: string;
    source_url?: string;
    unit?: string;
    date?: string;
    val?: number | string;
    announcement_datetime?: string;
    pct_diff_prev?: number;
    pct_change_yoy?: number;
    pct_change_mom?: number;
    pct_change_qoq?: number;
    forecast?: number | string;
};

type FxMacroResponse = {
    currency?: string;
    source?: string;
    as_of?: string;
    count?: number;
    data?: FxMacroIndicator[];
};

export class FxMacroDataProvider implements NewsProvider {
    readonly name = "fxmacrodata";

  constructor(private readonly apiKey: string, readonly pollIntervalSeconds = 300) {}

  async fetchLatest(since: Date): Promise<NewsArticle[]> {
        const url = new URL(`https://api.fxmacrodata.com/v1/announcements/${CURRENCY}/latest`);
        url.searchParams.set("api_key", this.apiKey);

      const response = await fetch(url);
        if (!response.ok) throw new Error(`FXMacroData failed: ${response.status} ${await response.text()}`);
        const body = (await response.json()) as FxMacroResponse;

      return (body.data ?? []).flatMap((item) => {
              if (!item.name || !item.announcement_datetime || item.val === undefined || item.val === null) return [];
              const publishedAt = new Date(item.announcement_datetime);
              if (Number.isNaN(publishedAt.getTime()) || publishedAt < since) return [];

                                             const parts = [`Actual: ${item.val}${item.unit ?? ""}`];
              if (item.forecast !== undefined && item.forecast !== null) parts.push(`Forecast: ${item.forecast}${item.unit ?? ""}`);
              if (typeof item.pct_diff_prev === "number") parts.push(`vs previous: ${item.pct_diff_prev > 0 ? "+" : ""}${item.pct_diff_prev}%`);
              if (typeof item.pct_change_yoy === "number") parts.push(`YoY: ${item.pct_change_yoy > 0 ? "+" : ""}${item.pct_change_yoy}%`);

                                             return [
                                               {
                                                           provider: this.name,
                                                           providerId: `${CURRENCY}-${item.indicator ?? item.name}-${item.date ?? item.announcement_datetime}`,
                                                           title: `US ${item.name} released`,
                                                           summary: parts.join(" | "),
                                                           url: item.source_url ?? "https://fxmacrodata.com/",
                                                           publishedAt,
                                                           sourceName: item.source ?? "FXMacroData"
                                               } satisfies NewsArticle
                                                     ];
      });
  }
}
