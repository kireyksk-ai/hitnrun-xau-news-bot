import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

/**
 * Statistic images for the scheduled briefings. Numbers come only from market data
 * (never from the model). Charts show % change, never price levels, so they can
 * never read as a zone or entry. Rendered by QuickChart (Chart.js 2) and sent as a
 * Telegram album before the text; any failure falls back to text only.
 */
export type Series = { label: string; symbol: string; points: Array<[number, number]> };
export const CHART_ASSETS = [
  { label: "Emas", symbol: "GC=F" },
  { label: "DXY", symbol: "DX-Y.NYB" },
  { label: "Yield US10Y", symbol: "^TNX" },
  { label: "Minyak", symbol: "CL=F" }
] as const;
const COLORS: Record<string, string> = { Emas: "#F5B700", DXY: "#4FA3FF", "Yield US10Y": "#FF6B6B", Minyak: "#9AA5B1" };
const BG = "#0E1116", GRID = "rgba(255,255,255,0.08)", TEXT = "#E6E8EB";

const wibClock = (ms: number) => new Date(ms + 7 * 3600_000).toISOString().slice(11, 16);
const wibDay = (ms: number) => { const d = new Date(ms + 7 * 3600_000); return `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${d.toISOString().slice(11, 16)}`; };

export async function fetchSeries(asset: { label: string; symbol: string }, sinceMs: number): Promise<Series | null> {
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?range=5d&interval=15m`, {
      headers: { Accept: "application/json", "User-Agent": "HitnRunFX/1.0" }, signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return null;
    const body = await response.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } };
    const result = body.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const points = (result?.timestamp ?? []).map((t, i) => [t * 1000, closes[i]] as [number, number | null | undefined])
      .filter((p): p is [number, number] => typeof p[1] === "number" && p[1] > 0 && p[0] >= sinceMs);
    return points.length >= 4 ? { label: asset.label, symbol: asset.symbol, points } : null;
  } catch (error) { log.warn({ err: error, symbol: asset.symbol }, "Briefing series fetch failed"); return null; }
}

export function changePct(series: Series): number {
  const first = series.points[0][1], last = series.points[series.points.length - 1][1];
  return (last - first) / first * 100;
}

/** Pressure on gold from each driver's move (old "timbangan": DXY, yield, oil, XAU). */
export function goldTilt(label: string, pct: number): "support" | "pressure" | "neutral" {
  if (Math.abs(pct) < 0.05) return "neutral";
  if (label === "Emas") return pct > 0 ? "support" : "pressure";
  if (label === "DXY" || label === "Yield US10Y") return pct > 0 ? "pressure" : "support";
  return "neutral"; // oil cuts both ways (inflation vs. risk premium); the text explains which one dominates
}

export function statsLine(series: Series[], sinceMs: number): string {
  if (!series.length) return "";
  return `PERUBAHAN SEJAK ${wibDay(sinceMs)} WIB (sama dengan gambar yang dikirim): ` +
    series.map((s) => `${s.label} ${changePct(s) >= 0 ? "+" : ""}${changePct(s).toFixed(2)}%`).join(" | ");
}

/** Line chart of % change from the window start, sampled on a shared 30-minute grid. */
export function moveChart(series: Series[], title: string): object {
  const start = Math.min(...series.map((s) => s.points[0][0])), end = Math.max(...series.map((s) => s.points[s.points.length - 1][0]));
  const step = Math.max(30 * 60_000, Math.ceil((end - start) / 48 / 60_000) * 60_000);
  const grid: number[] = []; for (let t = start; t <= end; t += step) grid.push(t);
  const at = (s: Series, t: number) => { let v: number | null = null; for (const p of s.points) { if (p[0] <= t) v = p[1]; else break; } return v; };
  return {
    type: "line",
    data: {
      labels: grid.map(wibClock),
      datasets: series.map((s) => {
        const base = s.points[0][1];
        return { label: s.label, borderColor: COLORS[s.label], backgroundColor: COLORS[s.label], fill: false, pointRadius: 0, lineTension: 0.25,
          borderWidth: s.label === "Emas" ? 4 : 2.5, data: grid.map((t) => { const v = at(s, t); return v === null ? null : +((v - base) / base * 100).toFixed(3); }) };
      })
    },
    options: {
      title: { display: true, text: [title, "Perubahan % sejak awal periode (WIB)"], fontColor: TEXT, fontSize: 18 },
      legend: { position: "bottom", labels: { fontColor: TEXT, fontSize: 14 } },
      scales: {
        xAxes: [{ ticks: { fontColor: TEXT, maxTicksLimit: 8 }, gridLines: { color: GRID } }],
        yAxes: [{ ticks: { fontColor: TEXT, callback: "__PCT__" }, gridLines: { color: GRID, zeroLineColor: "rgba(255,255,255,0.35)" } }]
      },
      plugins: { datalabels: { display: false } }
    }
  };
}

/** Horizontal bars: each driver's move, coloured by what it does to gold. */
export function tiltChart(series: Series[], title: string): object {
  const colour = { support: "#2ECC71", pressure: "#E74C3C", neutral: "#7F8C8D" } as const;
  const rows = series.map((s) => ({ label: s.label, pct: +changePct(s).toFixed(2), tilt: goldTilt(s.label, changePct(s)) }));
  const pressure = rows.filter((r) => r.label !== "Emas" && r.tilt === "pressure").length, support = rows.filter((r) => r.label !== "Emas" && r.tilt === "support").length;
  const verdict = pressure > support ? "Timbangan condong: NEKAN EMAS" : support > pressure ? "Timbangan condong: NOPANG EMAS" : "Timbangan: TABRAKAN / SEIMBANG";
  const raw = Math.max(0.2, ...rows.map((r) => Math.abs(r.pct))) * 1.3;
  const stepSize = raw <= 0.5 ? 0.1 : raw <= 1.2 ? 0.25 : raw <= 2.5 ? 0.5 : 1;
  const span = Math.ceil(raw / stepSize) * stepSize;
  return {
    type: "horizontalBar",
    data: { labels: rows.map((r) => r.label), datasets: [{ data: rows.map((r) => r.pct), backgroundColor: rows.map((r) => colour[r.tilt]) }] },
    options: {
      title: { display: true, text: [title, verdict, "merah = nekan emas · hijau = nopang emas · abu = dua arah"], fontColor: TEXT, fontSize: 18 },
      legend: { display: false },
      layout: { padding: { left: 10, right: 40 } },
      scales: {
        xAxes: [{ ticks: { fontColor: TEXT, callback: "__PCT__", min: -span, max: span, stepSize }, gridLines: { color: GRID, zeroLineColor: "rgba(255,255,255,0.5)" } }],
        yAxes: [{ ticks: { fontColor: TEXT, fontSize: 15 }, gridLines: { display: false } }]
      },
      plugins: { datalabels: { color: TEXT, anchor: "end", align: "end", font: { size: 14, weight: "bold" }, formatter: "__LABEL__" } }
    }
  };
}

/** Chart.js configs need JS callbacks; QuickChart accepts the config as a JS string. */
export function chartSource(config: object): string {
  return JSON.stringify(config)
    .replace(/"__PCT__"/g, "function(v){return (v>0?'+':'')+v+'%'}")
    .replace(/"__LABEL__"/g, "function(v){return (v>0?'+':'')+v.toFixed(2)+'%'}");
}

export async function renderChart(config: object, width = 900, height = 520): Promise<Buffer> {
  const response = await fetch("https://quickchart.io/chart", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ chart: chartSource(config), width, height, backgroundColor: BG, format: "png", version: "2", devicePixelRatio: 2 })
  });
  if (!response.ok) throw new Error(`QuickChart ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function sendTelegramAlbum(token: string, destination: { chatId: string; messageThreadId?: number }, photos: Buffer[]): Promise<void> {
  const form = new FormData();
  form.append("chat_id", destination.chatId);
  if (destination.messageThreadId) form.append("message_thread_id", String(destination.messageThreadId));
  const method = photos.length === 1 ? "sendPhoto" : "sendMediaGroup";
  if (photos.length === 1) form.append("photo", new Blob([new Uint8Array(photos[0])], { type: "image/png" }), "chart.png");
  else {
    form.append("media", JSON.stringify(photos.map((_, i) => ({ type: "photo", media: `attach://p${i}` }))));
    photos.forEach((photo, i) => form.append(`p${i}`, new Blob([new Uint8Array(photo)], { type: "image/png" }), `chart${i}.png`));
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Telegram ${method} ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

/** Fetch the four drivers, build both images. Returns what it could; never throws. */
export async function briefingVisuals(kind: "PAGI" | "MALAM", sinceMs: number): Promise<{ stats: string; images: Buffer[] }> {
  const series = (await Promise.all(CHART_ASSETS.map((a) => fetchSeries(a, sinceMs)))).filter((s): s is Series => s !== null);
  if (series.length < 3 || !series.some((s) => s.label === "Emas")) return { stats: "", images: [] };
  const head = kind === "PAGI" ? "HITnRUN FX · Morning recap" : "HITnRUN FX · Evening recap";
  const images: Buffer[] = [];
  for (const config of [moveChart(series, head), tiltChart(series, head)]) {
    try { images.push(await renderChart(config)); } catch (error) { log.warn({ err: error }, "Briefing chart render failed"); }
  }
  return { stats: statsLine(series, sinceMs), images };
}
