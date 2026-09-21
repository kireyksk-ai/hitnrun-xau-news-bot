import pino from "pino";
import { config } from "./config.js";
import { Editor } from "./editor.js";
import { IntelligenceStore } from "./intelligence-store.js";
import { processArticle } from "./pipeline.js";
import { marketSnapshot } from "./market-snapshot.js";
import { GoogleNewsRssProvider } from "./providers/google-news-rss.js";
import { GNewsDailyLimitError, GNewsProvider } from "./providers/gnews.js";
import { MarketauxDailyLimitError, MarketauxProvider } from "./providers/marketaux.js";
import { OfficialMacroRssProvider } from "./providers/official-macro-rss.js";
import { TruthSocialTrumpProvider } from "./providers/truth-social.js";
import { TreasuryPressProvider } from "./providers/treasury-press.js";
import { TwitterWireProvider } from "./providers/twitter-wire.js";
import { BenzingaWireProvider } from "./providers/benzinga-wire.js";
import { FxMacroDataProvider } from "./providers/fxmacrodata.js";
import { discoverTelegramDestination, fetchAdminUpdates, sendTelegramMessage } from "./telegram.js";
import type { TelegramDestination } from "./telegram.js";
import type { NewsProvider } from "./types.js";

const log = pino({ level: config.LOG_LEVEL });
const providers: NewsProvider[] = [
  ...(config.GNEWS_API_KEY ? [new GNewsProvider(config.GNEWS_API_KEY, config.GNEWS_POLL_INTERVAL_SECONDS)] : []),
  ...(config.GOOGLE_NEWS_RSS_ENABLED ? [new GoogleNewsRssProvider()] : []),
  ...(config.MARKETAUX_API_KEY ? [new MarketauxProvider(config.MARKETAUX_API_KEY, config.MARKETAUX_POLL_SECONDS)] : []),
  ...(config.OFFICIAL_MACRO_RSS_ENABLED ? [new OfficialMacroRssProvider(config.OFFICIAL_MACRO_RSS_POLL_SECONDS)] : []),
  ...(config.TRUTH_SOCIAL_ENABLED ? [new TruthSocialTrumpProvider(Math.max(120, config.TRUTH_SOCIAL_POLL_SECONDS))] : []),
  ...(config.TREASURY_PRESS_ENABLED ? [new TreasuryPressProvider(config.TREASURY_PRESS_POLL_SECONDS)] : []),
  ...(config.TWITTER_WIRE_ENABLED && config.X_API_BEARER_TOKEN ? [new TwitterWireProvider(config.TWITTER_WIRE_POLL_SECONDS, config.TWITTER_WIRE_MAX_MONTHLY_USD)] : []),
  ...(config.BENZINGA_API_KEY ? [new BenzingaWireProvider(config.BENZINGA_API_KEY, config.BENZINGA_POLL_SECONDS)] : []),
  ...(config.FXMACRODATA_API_KEY ? [new FxMacroDataProvider(config.FXMACRODATA_API_KEY, config.FXMACRODATA_POLL_SECONDS)] : [])
];
if (!providers.length) throw new Error("No news provider configured");
const store = new IntelligenceStore(`${config.SQLITE_PATH}.intelligence.json`);
const editor = new Editor(config.OPENAI_MODEL, config.OPENAI_REASONING_EFFORT, config.OPENAI_API_KEY);
const discoveredDestination = config.TELEGRAM_CHAT_ID ? undefined : await discoverTelegramDestination(config.TELEGRAM_BOT_TOKEN);
const destinations: TelegramDestination[] = [
  { chatId: config.TELEGRAM_CHAT_ID ?? discoveredDestination!.chatId, messageThreadId: config.TELEGRAM_MESSAGE_THREAD_ID ?? discoveredDestination?.messageThreadId },
  ...(config.TELEGRAM_CHAT_ID_REGULAR ? [{ chatId: config.TELEGRAM_CHAT_ID_REGULAR }] : [])
];
const lastPolledAt = new Map<string, number>();
const pausedUntil = new Map<string, number>();
let aiDay = "", aiCount = 0, ticking = false, adminPolling = false;
const recentSendTimes: number[] = [];

function aiAllowed(): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== aiDay) { aiDay = day; aiCount = 0; }
  // Budget is measured in model calls, not articles; each candidate uses two calls.
  if (aiCount >= config.MAX_AI_ARTICLES_PER_DAY * 2) return false;
  aiCount++; return true;
}
async function deliver(message: string, id: string): Promise<Record<string, number>> {
  if (store.safeMode) return {};
  const withinHour = recentSendTimes.filter((time) => Date.now() - time < 3600000);
  recentSendTimes.length = 0; recentSendTimes.push(...withinHour);
  if (recentSendTimes.length >= 30) {
    store.setSafeMode(true);
    log.error({ id }, "Safe mode enabled after abnormal alert volume");
    return {};
  }
  const accepted: Record<string, number> = {};
  for (const destination of destinations) {
    try { accepted[destination.chatId] = await sendTelegramMessage(config.TELEGRAM_BOT_TOKEN, destination, message); }
    catch (error) { log.error({ err: error, chatId: destination.chatId, id }, "Telegram destination failed"); }
  }
  if (Object.keys(accepted).length) recentSendTimes.push(Date.now());
  return accepted;
}
async function replayQueued(): Promise<number> {
  if (store.safeMode) return 0;
  let count = 0;
  for (const record of store.records().filter((r) => r.stage === "ROUTING" && r.primaryDecision === "REVIEW")) {
    const message = record.renderedMessage;
    if (!message) continue;
    const ids = await deliver(message, record.id);
    if (!Object.keys(ids).length) continue;
    store.record({ ...record, stage: "SENT", primaryDecision: "SEND", sentAt: new Date().toISOString(), telegramMessageIds: ids });
    store.rememberStory(record.event, true); store.increment("alertsSent"); count++;
  }
  return count;
}
function jakartaDayAndHour(date = new Date()): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(date);
  const part = (key: string) => parts.find((item) => item.type === key)?.value ?? "";
  return { day: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
}
async function adminReport(): Promise<void> {
  if (!config.TELEGRAM_ADMIN_CHAT_ID) return;
  const { day, hour } = jakartaDayAndHour();
  if (hour !== config.ADMIN_REPORT_HOUR_WIB || store.lastReportDay() === day) return;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const misses = store.records().filter((r) => r.adminDecision === "FALSE_NEGATIVE" || r.stage === "SHADOW" && r.primaryDecision !== "SEND").slice(-10);
  const appendix = misses.length ? `\nHigh-risk miss refs: ${misses.map((r) => r.id.slice(0, 10)).join(", ")}` : "";
  await sendTelegramMessage(config.TELEGRAM_BOT_TOKEN, { chatId: config.TELEGRAM_ADMIN_CHAT_ID }, store.report(yesterday) + appendix);
  store.setLastReportDay(day);
}
async function pollAdmin(): Promise<void> {
  if (!config.TELEGRAM_ADMIN_CHAT_ID || !config.TELEGRAM_ADMIN_USER_ID || adminPolling) return;
  adminPolling = true;
  try {
    for (const update of await fetchAdminUpdates(config.TELEGRAM_BOT_TOKEN, store.updateOffset)) {
      store.setUpdateOffset(update.update_id + 1);
      const m = update.message;
      if (String(m?.chat?.id) !== config.TELEGRAM_ADMIN_CHAT_ID || m?.from?.id !== config.TELEGRAM_ADMIN_USER_ID) continue;
      const input = m.text?.trim() ?? "";
      const reply = async (text: string) => sendTelegramMessage(config.TELEGRAM_BOT_TOKEN, { chatId: config.TELEGRAM_ADMIN_CHAT_ID! }, text);
      if (input === "/safe on") { store.setSafeMode(true); await reply("Safe mode ON: ingestion berjalan, publishing berhenti."); }
      else if (input === "/safe off") { store.setSafeMode(false); await reply("Safe mode OFF. Gunakan /replay untuk antrean."); }
      else if (input === "/replay") await reply(`Replay terkirim: ${await replayQueued()}`);
      else if (input.startsWith("/fn ") || input.startsWith("/fp ")) {
        const decision = input.startsWith("/fn ") ? "FALSE_NEGATIVE" : "FALSE_POSITIVE";
        const payload = input.slice(4).trim();
        const [reference, ...reasonParts] = payload.split(/\s+/);
        const record = store.records().find((r) => r.id.startsWith(reference));
        if (record && reasonParts.length) {
          store.markFeedback(record.id, decision, reasonParts.join(" "));
          await reply(`${decision} tersimpan untuk ${record.id.slice(0, 10)}; aturan production tidak berubah otomatis.`);
        } else if (decision === "FALSE_NEGATIVE" && payload.includes("|")) {
          const [headline, source, reason] = payload.split("|").map((part) => part.trim());
          if (headline && source && reason) await reply(`FALSE_NEGATIVE tersimpan: ${store.addMissedHeadline(headline, source, reason)}`);
          else await reply("Format: /fn headline | source | alasan");
        } else await reply("Ref tidak ditemukan. Gunakan /fn atau /fp <ref> <alasan>; berita yang tidak ditemukan: /fn headline | source | alasan");
      }
    }
  } catch (error) { log.error({ err: error }, "Admin command polling failed"); }
  finally { adminPolling = false; }
}
async function tick(): Promise<void> {
  if (ticking) return; ticking = true;
  try {
    await pollAdmin(); await adminReport();
    const since = new Date(Date.now() - config.MAX_ARTICLE_AGE_MINUTES * 60000);
    for (const provider of providers) {
      const now = Date.now();
      if (now < (pausedUntil.get(provider.name) ?? 0)) continue;
      if (now < (lastPolledAt.get(provider.name) ?? 0) + (provider.pollIntervalSeconds ?? config.POLL_INTERVAL_SECONDS) * 1000) continue;
      lastPolledAt.set(provider.name, now);
      try {
        const articles = await provider.fetchLatest(since);
        store.providerLatency(provider.name, Date.now() - now);
        for (const article of articles.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())) {
          const result = await processArticle(article, {
            store, snapshot: marketSnapshot,
            analyze: (item) => aiAllowed() ? editor.assess(item) : Promise.reject(new Error("AI budget exhausted")),
            shadow: (item, event) => aiAllowed() ? editor.shadowAssess(item, event, store.getStory(event.storyKey)) : Promise.reject(new Error("AI budget exhausted")),
            deliver
          });
          log.info({ provider: provider.name, title: article.title, stage: result.stage, decision: result.primaryDecision,
            importance: result.event.importance, urgency: result.event.urgency, reason: result.reason }, "Event processed");
        }
      } catch (error) {
        store.increment("providerFailures");
        if (error instanceof GNewsDailyLimitError || error instanceof MarketauxDailyLimitError) {
          const midnight = new Date(); midnight.setUTCHours(24, 0, 0, 0); pausedUntil.set(provider.name, midnight.getTime());
        }
        log.error({ err: error, provider: provider.name }, "Provider polling failed; other providers remain active");
      }
    }
  } finally { ticking = false; }
}
await tick();
setInterval(() => void tick().catch((error) => log.error({ err: error }, "Pipeline tick failed")), 5000);
log.info({ providers: providers.map((p) => p.name), adminEnabled: Boolean(config.TELEGRAM_ADMIN_CHAT_ID) }, "Market intelligence worker started");

