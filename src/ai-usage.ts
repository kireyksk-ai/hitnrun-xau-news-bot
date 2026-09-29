/**
 * AI cost telemetry (owner, 2026-09-30: "sehari 20 usd"). Every model call is counted per purpose with its
 * input / cached / output / reasoning tokens, and an hourly summary is logged ("AI usage summary") so the
 * expensive purpose is visible in Render logs instead of guessed from the OpenAI billing page.
 * Prices are optional env values (USD per 1M tokens); without them only tokens are reported.
 */
export type Usage = { input: number; cached: number; output: number; reasoning: number };
type Row = Usage & { calls: number };

export const PRICES = {
  input: Number(process.env.AI_PRICE_INPUT_PER_M ?? NaN),
  cached: Number(process.env.AI_PRICE_CACHED_PER_M ?? NaN),
  output: Number(process.env.AI_PRICE_OUTPUT_PER_M ?? NaN)
};

export class AiUsage {
  private rows = new Map<string, Row>();
  private since = Date.now();
  record(purpose: string, usage: unknown): void {
    const u = (usage ?? {}) as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } };
    const row = this.rows.get(purpose) ?? { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
    row.calls++; row.input += u.input_tokens ?? 0; row.cached += u.input_tokens_details?.cached_tokens ?? 0;
    row.output += u.output_tokens ?? 0; row.reasoning += u.output_tokens_details?.reasoning_tokens ?? 0;
    this.rows.set(purpose, row);
  }
  /** Estimated USD for a row, or null when prices are not configured. */
  static cost(r: Usage, prices = PRICES): number | null {
    if (![prices.input, prices.cached, prices.output].every(Number.isFinite)) return null;
    return ((r.input - r.cached) * prices.input + r.cached * prices.cached + r.output * prices.output) / 1e6;
  }
  /** Summary since the last call, most expensive purpose first, then resets. */
  flush(now = Date.now()): { minutes: number; total: Row & { usd: number | null }; byPurpose: Array<Row & { purpose: string; usd: number | null }> } {
    const byPurpose = [...this.rows].map(([purpose, r]) => ({ purpose, ...r, usd: AiUsage.cost(r) }))
      .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || (b.output + b.input) - (a.output + a.input));
    const total = byPurpose.reduce((t, r) => ({ calls: t.calls + r.calls, input: t.input + r.input, cached: t.cached + r.cached, output: t.output + r.output, reasoning: t.reasoning + r.reasoning }),
      { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 });
    const out = { minutes: Math.round((now - this.since) / 60_000), total: { ...total, usd: AiUsage.cost(total) }, byPurpose };
    this.rows.clear(); this.since = now;
    return out;
  }
}
export const aiUsage = new AiUsage();

/** Wraps an OpenAI client so every responses.create call is recorded under its schema name (or "briefing"). */
export function meter<T extends { responses: { create: (...args: any[]) => any } }>(client: T): T {
  const original = client.responses.create.bind(client.responses);
  (client.responses as { create: unknown }).create = async (body: { text?: { format?: { name?: string } } }, ...rest: unknown[]) => {
    const response = await original(body, ...rest);
    aiUsage.record(body?.text?.format?.name ?? "briefing", (response as { usage?: unknown })?.usage);
    return response;
  };
  return client;
}
