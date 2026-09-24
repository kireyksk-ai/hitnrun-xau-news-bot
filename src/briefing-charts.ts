import pino from "pino";
import { gated } from "./yahoo.js";

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
// Line colours are neutral identity colours (no red/green there: red/green is reserved for "effect on gold").
const COLORS: Record<string, string> = { Emas: "#F2C14E", DXY: "#4FA3FF", "Yield US10Y": "#C084FC", Minyak: "#2DD4BF" };
const BG = "#0E1116", GRID = "rgba(255,255,255,0.07)", TEXT = "#E6E8EB", MUTED = "#9AA3AD";
const EFFECT = { pressure: "#E5484D", support: "#30A46C", neutral: "#8B95A1", result: "#F2C14E" } as const;
/** Typical 24h move, used to show how big today's move is (bar length = multiple of normal). */
const NORMAL: Record<string, number> = { Emas: 1.0, DXY: 0.4, "Yield US10Y": 6, Minyak: 2.0 };
const NAME: Record<string, string> = { Emas: "Emas (XAUUSD)", DXY: "Dolar (DXY)", "Yield US10Y": "Yield US 10 tahun", Minyak: "Minyak WTI" };

const wibClock = (ms: number) => new Date(ms + 7 * 3600_000).toISOString().slice(11, 16);
const wibDay = (ms: number) => { const d = new Date(ms + 7 * 3600_000); return `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${d.toISOString().slice(11, 16)}`; };

/** Alternative Yahoo symbols per asset, tried in order when the first one fails or is empty. */
const FALLBACK: Record<string, string[]> = { "GC=F": ["GC=F", "MGC=F"], "DX-Y.NYB": ["DX-Y.NYB", "DX=F"], "^TNX": ["^TNX"], "CL=F": ["CL=F", "BZ=F"] };
export async function fetchSeries(asset: { label: string; symbol: string }, sinceMs: number, fetcher: typeof fetch = fetch): Promise<Series | null> {
  const problems: string[] = [];
  for (const symbol of FALLBACK[asset.symbol] ?? [asset.symbol]) for (const host of ["query1", "query2"]) {
    try {
      const response = await gated(fetcher)(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=15m`, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; HitnRunFX/1.0)" }, signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) { problems.push(`${symbol}@${host} HTTP ${response.status}`); continue; }
      const body = await response.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } };
      const result = body.chart?.result?.[0];
      const closes = result?.indicators?.quote?.[0]?.close ?? [];
      const points = (result?.timestamp ?? []).map((t, i) => [t * 1000, closes[i]] as [number, number | null | undefined])
        .filter((p): p is [number, number] => typeof p[1] === "number" && p[1] > 0 && p[0] >= sinceMs);
      if (points.length >= 4) return { label: asset.label, symbol, points };
      problems.push(`${symbol}@${host} ${points.length} titik`);
    } catch (error) { problems.push(`${symbol}@${host} ${error instanceof Error ? error.message : "error"}`); }
  }
  log.warn({ asset: asset.label, problems }, "Briefing series unavailable");
  return null;
}

export function changePct(series: Series): number {
  const first = series.points[0][1], last = series.points[series.points.length - 1][1];
  return (last - first) / first * 100;
}
const isYield = (label: string) => label === "Yield US10Y";
/** Move in the unit traders use: basis points for a yield, % for everything else. */
export function changeOf(series: Series): number {
  const first = series.points[0][1], last = series.points[series.points.length - 1][1];
  return isYield(series.label) ? (last - first) * 100 : (last - first) / first * 100;
}
export function fmtChange(label: string, v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(isYield(label) ? 1 : 2)}${isYield(label) ? " bp" : "%"}`;
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
    series.map((s) => `${s.label} ${fmtChange(s.label, changeOf(s))}`).join(" | ");
}

const FONT = "Helvetica, Arial, sans-serif";
const disp = (label: string, v: number) => fmtChange(label, v).replace("-", "\u2212");
/** Shared header: bold headline, muted explanation, small brand line; left aligned like a financial chart. */
function header(headline: string, detail: string, brand: string) {
  return {
    title: { display: true, text: headline, align: "start", color: TEXT, font: { family: FONT, size: 26, weight: 700 }, padding: { top: 4, bottom: 6 } },
    subtitle: { display: true, text: [detail, brand], align: "start", color: MUTED, font: { family: FONT, size: 15, lineHeight: 1.5 }, padding: { bottom: 18 } }
  };
}

/** Line chart: % change for gold, dollar and oil (left axis), 10Y yield in basis points (right axis). */
export function moveChart(series: Series[], brand: string, sinceMs = series[0]?.points[0][0] ?? 0): object {
  const start = Math.min(...series.map((s) => s.points[0][0])), end = Math.max(...series.map((s) => s.points[s.points.length - 1][0]));
  const step = Math.max(30 * 60_000, Math.ceil((end - start) / 48 / 60_000) * 60_000);
  const grid: number[] = []; for (let t = start; t <= end; t += step) grid.push(t);
  const at = (s: Series, t: number) => { let v: number | null = null; for (const p of s.points) { if (p[0] <= t) v = p[1]; else break; } return v; };
  const hasYield = series.some((s) => isYield(s.label));
  // Both axes symmetric around zero so the 0% and 0 bp lines coincide (no misleading offset).
  const nice = (x: number) => { const steps = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 40, 50, 75, 100]; return steps.find((v) => v >= x) ?? Math.ceil(x); };
  const pctMax = nice(Math.max(0.25, ...series.filter((s) => !isYield(s.label)).flatMap((s) => s.points.map((p) => Math.abs((p[1] - s.points[0][1]) / s.points[0][1] * 100)))) * 1.1);
  const bpMax = nice(Math.max(2, ...series.filter((s) => isYield(s.label)).flatMap((s) => s.points.map((p) => Math.abs((p[1] - s.points[0][1]) * 100)))) * 1.1);
  const gold = series.find((s) => s.label === "Emas");
  const hours = Math.max(1, Math.round((end - start) / 3600_000));
  const headline = gold ? `Emas ${changeOf(gold) >= 0 ? "naik" : "turun"} ${Math.abs(changeOf(gold)).toFixed(2)}% dalam ${hours} jam terakhir` : "Pergerakan pasar";
  const tick = { color: MUTED, font: { family: FONT, size: 13 } };
  return {
    type: "line",
    data: {
      labels: grid.map(wibClock),
      datasets: series.map((s) => {
        const base = s.points[0][1];
        return { label: `${NAME[s.label] ?? s.label}  ${disp(s.label, changeOf(s))}`,
          borderColor: COLORS[s.label], backgroundColor: COLORS[s.label], fill: false, pointRadius: 0, tension: 0.2, spanGaps: true,
          borderWidth: s.label === "Emas" ? 4 : 2.5, borderDash: isYield(s.label) ? [8, 5] : [], yAxisID: isYield(s.label) ? "bp" : "pct",
          data: grid.map((t) => { const v = at(s, t); return v === null ? null : isYield(s.label) ? +((v - base) * 100).toFixed(2) : +((v - base) / base * 100).toFixed(3); }) };
      })
    },
    options: {
      layout: { padding: { top: 12, left: 16, right: 16, bottom: 8 } },
      plugins: {
        ...header(headline, `Perubahan sejak ${wibDay(sinceMs)} WIB${hasYield ? ". Yield US 10 tahun dalam basis point (garis putus-putus, sumbu kanan)." : "."}`, brand),
        legend: { position: "top", align: "start", labels: { color: TEXT, font: { family: FONT, size: 14 }, boxWidth: 14, boxHeight: 14, padding: 18 } },
        datalabels: { display: false }
      },
      scales: {
        x: { ticks: { ...tick, maxTicksLimit: 9, maxRotation: 0 }, grid: { color: GRID } },
        pct: { position: "left", min: -pctMax, max: pctMax, title: { display: true, text: "Perubahan (%)", ...tick }, ticks: { ...tick, callback: "__PCT__" }, grid: { color: GRID } },
        ...(hasYield ? { bp: { position: "right", min: -bpMax, max: bpMax, title: { display: true, text: "Yield (bp)", color: COLORS["Yield US10Y"], font: tick.font }, ticks: { color: COLORS["Yield US10Y"], font: tick.font, callback: "__BP__" }, grid: { drawOnChartArea: false } } } : {})
      }
    }
  };
}

/**
 * The old "timbangan" as one picture: each driver's move coloured by its effect on gold
 * (red = menekan, green = menopang, grey = dua arah), gold itself shown as the result.
 * Units differ (%, bp), so bar length = how many times a normal 24h move it is; the label shows the real move.
 */
export function tiltChart(series: Series[], brand: string): object {
  const rows = series.map((s) => {
    const v = changeOf(s), pct = changePct(s);
    const tilt = s.label === "Emas" ? "result" as const : goldTilt(s.label, pct);
    const size = +(Math.abs(v) / (NORMAL[s.label] ?? 1)).toFixed(2);
    const effect = tilt === "result" ? "hasil akhir" : tilt === "pressure" ? "menekan emas" : tilt === "support" ? "menopang emas" : "dua arah";
    return { label: s.label, v, tilt, bar: v >= 0 ? size : -size, text: `${disp(s.label, v)}  ${effect}` };
  });
  const drivers = rows.filter((r) => r.label !== "Emas");
  const pressure = drivers.filter((r) => r.tilt === "pressure").length, support = drivers.filter((r) => r.tilt === "support").length;
  const headline = pressure > support ? "Tekanan ke emas lebih dominan" : support > pressure ? "Faktor pendukung emas lebih dominan" : "Faktor penggerak emas seimbang";
  const gold = rows.find((r) => r.label === "Emas");
  const detail = `${pressure} dari ${drivers.length} faktor menekan emas, ${support} menopang.${gold ? ` Emas ${disp("Emas", gold.v)} pada periode yang sama.` : ""}`;
  const order = [...drivers, ...(gold ? [gold] : [])];
  const span = Math.max(1.5, Math.ceil(Math.max(...order.map((r) => Math.abs(r.bar))) * 1.6 * 2) / 2);
  const groups: Array<[keyof typeof EFFECT, string]> = [["pressure", "Menekan emas"], ["support", "Menopang emas"], ["neutral", "Dua arah (inflasi vs risiko)"], ["result", "Emas (hasil akhir)"]];
  const tick = { color: MUTED, font: { family: FONT, size: 13 } };
  return {
    type: "bar",
    data: {
      labels: order.map((r) => NAME[r.label] ?? r.label),
      datasets: groups.map(([key, name]) => ({ label: name, backgroundColor: EFFECT[key], borderRadius: 4, barPercentage: 0.72, categoryPercentage: 0.9,
        data: order.map((r) => r.tilt === key ? r.bar : null), txt: order.map((r) => r.tilt === key ? r.text : "") }))
    },
    options: {
      indexAxis: "y",
      layout: { padding: { top: 12, left: 16, right: 28, bottom: 8 } },
      plugins: {
        ...header(headline, detail, brand),
        legend: { position: "bottom", align: "start", labels: { color: TEXT, font: { family: FONT, size: 14 }, boxWidth: 14, boxHeight: 14, padding: 18 } },
        datalabels: { color: TEXT, anchor: "end", align: "end", clamp: true, font: { family: FONT, size: 14, weight: 700 }, formatter: "__LABEL__" }
      },
      scales: {
        x: { stacked: true, min: -span, max: span, ticks: { ...tick, callback: "__X__" }, title: { display: true, text: "Besar gerakan dibanding gerakan harian normal (1x = normal)", ...tick }, grid: { color: GRID } },
        y: { stacked: true, ticks: { color: TEXT, font: { family: FONT, size: 15 } }, grid: { display: false } }
      }
    }
  };
}

/** Chart.js configs need JS callbacks; QuickChart accepts the config as a JS string. */
export function chartSource(config: object): string {
  return JSON.stringify(config)
    .replace(/"__PCT__"/g, "function(v){return (v>0?'+':v<0?'\\u2212':'')+Math.abs(v)+'%'}")
    .replace(/"__BP__"/g, "function(v){return (v>0?'+':v<0?'\\u2212':'')+Math.abs(v)+' bp'}")
    .replace(/"__X__"/g, "function(v){return v===0?'0':Math.abs(v)+'x'}")
    .replace(/"__LABEL__"/g, "function(v,c){return v===null?'':c.dataset.txt[c.dataIndex]}");
}

export async function renderChart(config: object, width = 1000, height = 620): Promise<Buffer> {
  const response = await fetch("https://quickchart.io/chart", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ chart: chartSource(config), width, height, backgroundColor: BG, format: "png", version: "4", devicePixelRatio: 2 })
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
export async function briefingVisuals(kind: "ASIA" | "EROPA" | "US", sinceMs: number): Promise<{ stats: string; images: Buffer[] }> {
  const series = (await Promise.all(CHART_ASSETS.map((a) => fetchSeries(a, sinceMs)))).filter((s): s is Series => s !== null);
  // Gold plus at least one driver is enough for a meaningful picture; say clearly what is missing.
  if (series.length < 2 || !series.some((s) => s.label === "Emas")) {
    log.warn({ got: series.map((s) => s.label) }, "Briefing charts skipped: not enough market series");
    return { stats: "", images: [] };
  }
  const head = `HitNRun FX  |  ${kind === "ASIA" ? "Sesi Asia" : kind === "EROPA" ? "Sesi Eropa" : "Sesi US"}  |  ${wibDay(Date.now()).split(" ")[0]}`;
  const images: Buffer[] = [];
  for (const config of [tiltChart(series, head), moveChart(series, head, sinceMs)]) {
    try { images.push(await renderChart(config)); } catch (error) { log.warn({ err: error }, "Briefing chart render failed"); }
  }
  return { stats: statsLine(series, sinceMs), images };
}
