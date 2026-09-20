type Quote = { label: string; symbol: string };
type SnapshotItem = { label: string; price: number; changePercent: number };

const quotes: Quote[] = [
  { label: "Emas", symbol: "XAUUSD=X" },
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
      headers: { Accept: "application/json", "User-Agent": "HitnRunFX/1.0" }
    });
    if (!response.ok) return null;
    const body = await response.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number } }> } };
    const meta = body.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    const previous = meta?.chartPreviousClose;
    if (!price || !previous) return null;
    return { label: item.label, price, changePercent: ((price - previous) / previous) * 100 };
  } catch {
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
  if (results.length < 3) return "";
  cached = results.map((item) => `${item.label} ${direction(item.changePercent)} (${item.changePercent.toFixed(2)}%)`).join(" | ");
  return cached;
}
