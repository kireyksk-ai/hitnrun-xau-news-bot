import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

type Quote = { label: string; symbol: string };
type SnapshotItem = { label: string; price: number; changePercent: number };

const quotes: Quote[] = [
  { label: "Emas", symbol: "GC=F" },
  { label: "DXY", symbol: "DX-Y.NYB" },
  { label: "US10Y", symbol: "^TNX" },
  { label: "Nasdaq", symbol: "^NDX" },
  { label: "S&P 500", symbol: "^GSPC" },
  { label: "Oil WTI", symbol: "CL=F" }
  ];

let cached = "";
let cachedAt = 0;

async function quote(item: Quote): Promise<SnapshotItem | null> {
    try {
          const response = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(item.symbol) + "?range=1d&interval=5m", {
                  headers: { Accept: "application/json", "User-Agent": "HitnRunFX/1.0" },
                  signal: AbortSignal.timeout(8_000)
          });
          if (!response.ok) {
                  log.warn({ symbol: item.symbol, status: response.status }, "Market snapshot quote failed (non-OK response)");
                  return null;
          }
          const body = await response.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number } }> } };
          const meta = body.chart?.result?.[0]?.meta;
          const price = meta?.regularMarketPrice;
          const previous = meta?.chartPreviousClose;
          if (!price || !previous) {
                  log.warn({ symbol: item.symbol }, "Market snapshot quote missing price data");
                  return null;
          }
          return { label: item.label, price, changePercent: ((price - previous) / previous) * 100 };
    } catch (error) {
          log.warn({ symbol: item.symbol, err: error }, "Market snapshot quote request failed");
          return null;
    }
}

function direction(change: number): string {
    if (change > 0.08) return "naik";
    if (change < -0.08) return "turun";
    return "datar";
}

export async function marketSnapshot(): Promise<string> {
    if (cached && Date.now() - cachedAt < 60_000) return cached;
    const results = (await Promise.all(quotes.map(quote))).filter((item): item is SnapshotItem => item !== null);
    cachedAt = Date.now();
    if (results.length < 3) {
          log.warn({ succeeded: results.length, total: quotes.length }, "Market snapshot insufficient data; skipping cross-market context this cycle");
          return "";
    }
    cached = results.map((item) => `${item.label} ${direction(item.changePercent)} (${item.changePercent.toFixed(2)}%)`).join(" | ");
    log.info({ succeeded: results.length, total: quotes.length, snapshot: cached }, "Market snapshot fetched");
    return cached;
}
