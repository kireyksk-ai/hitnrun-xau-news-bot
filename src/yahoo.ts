import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

/**
 * One gate for every Yahoo chart request. Several modules (Market Brain every minute, the
 * per-article market snapshot, charts, observer, backtest) used to hit Yahoo independently,
 * which got the server's IP rate-limited (HTTP 429) and left briefings without data. This
 * gate caches by URL for a time that matches the bar interval, spaces live requests, rotates
 * query1/query2, and after a 429/403 backs off for everyone while serving the last good copy.
 */
type Entry = { at: number; status: number; body: string };
const cache = new Map<string, Entry>();
let cooldownUntil = 0, penalty = 0, lastCall = 0, hostFlip = 0, queue: Promise<unknown> = Promise.resolve();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export function ttlFor(url: string): number {
  const interval = new URL(url).searchParams.get("interval") ?? "1d";
  return ({ "1m": 45_000, "2m": 60_000, "5m": 120_000, "15m": 300_000, "30m": 600_000, "60m": 900_000, "1h": 900_000 } as Record<string, number>)[interval] ?? 3_600_000;
}
const keyOf = (url: string) => url.replace(/^https:\/\/query[12]\./, "https://queryN.");
const respond = (e: Entry) => new Response(e.body, { status: e.status, headers: { "content-type": "application/json", "x-yahoo-cache": "1" } });

export async function yahooFetch(input: string | URL, init: RequestInit = {}, net: typeof fetch = fetch, now: () => number = Date.now): Promise<Response> {
  const url = String(input), key = keyOf(url);
  const hit = cache.get(key);
  if (hit && now() - hit.at < ttlFor(url)) return respond(hit);
  if (now() < cooldownUntil) return hit ? respond(hit) : new Response("rate limited (local cooldown)", { status: 429 });
  const run = async (): Promise<Response> => {
    const again = cache.get(key);
    if (again && now() - again.at < ttlFor(url)) return respond(again);
    const wait = Math.max(0, lastCall + 350 - now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = now();
    const host = hostFlip++ % 2 ? "query2" : "query1";
    const target = key.replace("https://queryN.", `https://${host}.`);
    const r = await net(target, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Accept: "application/json", "User-Agent": UA } });
    if (r.status === 429 || r.status === 403) {
      penalty = Math.min(penalty + 1, 5);
      cooldownUntil = now() + 3 * 60_000 * 2 ** (penalty - 1);
      log.warn({ status: r.status, cooldownMin: Math.round((cooldownUntil - now()) / 60_000), url: target.split("?")[0] }, "Yahoo rate limit; backing off, serving cached data");
      const stale = cache.get(key);
      return stale ? respond(stale) : r;
    }
    const body = await r.text();
    if (r.ok) { penalty = Math.max(0, penalty - 1); cache.set(key, { at: now(), status: r.status, body }); if (cache.size > 400) cache.delete(cache.keys().next().value!); }
    return new Response(body, { status: r.status, headers: { "content-type": "application/json" } });
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}
const nativeFetch = globalThis.fetch;
/** The gate for real network calls; an injected/mocked fetch (tests) is used as-is. */
export function gated(f: typeof fetch = globalThis.fetch): typeof fetch {
  return (f === nativeFetch ? ((input: string | URL | Request, init?: RequestInit) => yahooFetch(String(input), init ?? {})) : f) as typeof fetch;
}
export function yahooStatus(): { cached: number; cooldownMs: number } { return { cached: cache.size, cooldownMs: Math.max(0, cooldownUntil - Date.now()) }; }
export function resetYahooForTests(): void { cache.clear(); cooldownUntil = 0; penalty = 0; lastCall = 0; queue = Promise.resolve(); }
