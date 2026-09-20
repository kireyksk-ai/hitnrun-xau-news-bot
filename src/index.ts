import pino from "pino";
import { config } from "./config.js";
import { Editor } from "./editor.js";
import { NewsApiProvider, NewsApiRateLimitError } from "./providers/newsapi.js";
import { GoogleNewsRssProvider } from "./providers/google-news-rss.js";
import { GNewsDailyLimitError, GNewsProvider } from "./providers/gnews.js";
import { OfficialMacroRssProvider } from "./providers/official-macro-rss.js";
import { TruthSocialTrumpProvider } from "./providers/truth-social.js";
import { Store } from "./store.js";
import { discoverTelegramDestination, sendTelegramMessage } from "./telegram.js";
import type { NewsProvider } from "./types.js";

const log = pino({ level: config.LOG_LEVEL });
const providers: NewsProvider[] = [
  ...(config.GNEWS_API_KEY ? [new GNewsProvider(config.GNEWS_API_KEY, config.GNEWS_POLL_INTERVAL_SECONDS)] : [
    ...(config.GOOGLE_NEWS_RSS_ENABLED ? [new GoogleNewsRssProvider()] : []),
    ...(config.NEWSAPI_KEY ? [new NewsApiProvider(config.NEWSAPI_KEY, Math.max(config.POLL_INTERVAL_SECONDS, 20 * 60))] : [])
  ]),
  ...(config.OFFICIAL_MACRO_RSS_ENABLED ? [new OfficialMacroRssProvider(config.OFFICIAL_MACRO_RSS_POLL_SECONDS)] : []),
  ...(config.TRUTH_SOCIAL_ENABLED ? [new TruthSocialTrumpProvider(Math.max(120, config.TRUTH_SOCIAL_POLL_SECONDS))] : [])
];
if (!providers.length) throw new Error("No news provider configured. Set NEWSAPI_KEY or add an adapter in src/providers.");
const store = new Store(config.SQLITE_PATH);
const editor = new Editor(config.OPENAI_MODEL, config.OPENAI_REASONING_EFFORT, config.OPENAI_API_KEY);
const discoveredDestination = await discoverTelegramDestination(config.TELEGRAM_BOT_TOKEN);
const telegramDestination = {
  chatId: config.TELEGRAM_CHAT_ID ?? discoveredDestination.chatId,
  messageThreadId: config.TELEGRAM_MESSAGE_THREAD_ID ?? discoveredDestination.messageThreadId
};
const lastPolledAt = new Map<string, number>();
const pausedUntil = new Map<string, number>();
let aiArticleDay = "";
let aiArticlesToday = 0;

function canUseAi(): boolean {
  const utcDay = new Date().toISOString().slice(0, 10);
  if (utcDay !== aiArticleDay) {
    aiArticleDay = utcDay;
    aiArticlesToday = 0;
  }
  if (aiArticlesToday >= config.MAX_AI_ARTICLES_PER_DAY) return false;
  aiArticlesToday += 1;
  return true;
}

function nextUtcMidnight(): number {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime();
}

async function tick(): Promise<void> {
  const since = new Date(Date.now() - config.MAX_ARTICLE_AGE_MINUTES * 60_000);
  for (const provider of providers) {
    const now = Date.now();
    if (now < (pausedUntil.get(provider.name) ?? 0)) continue;
    const dueAt = (lastPolledAt.get(provider.name) ?? 0) + (provider.pollIntervalSeconds ?? config.POLL_INTERVAL_SECONDS) * 1000;
    if (now < dueAt) continue;
    lastPolledAt.set(provider.name, now);
    try {
      const articles = await provider.fetchLatest(since);
      for (const article of articles.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())) {
        if (store.has(article)) continue;
        if (!canUseAi()) {
          store.remember(article, false);
          log.warn({ title: article.title, limit: config.MAX_AI_ARTICLES_PER_DAY }, "Daily AI analysis safeguard reached; article skipped");
          continue;
        }
        try {
          const decision = await editor.assess(article);
          if (decision.material && decision.telegramMessage) {
            await sendTelegramMessage(config.TELEGRAM_BOT_TOKEN, telegramDestination, decision.telegramMessage);
            store.remember(article, true);
            log.info({ title: article.title, confidence: decision.confidence }, "Posted material XAU catalyst");
          } else {
            store.remember(article, false);
            log.debug({ title: article.title, reason: decision.reason }, "Rejected article");
          }
        } catch (error) { log.error({ err: error, title: article.title }, "Article processing failed; will retry"); }
      }
    } catch (error) {
      if (error instanceof NewsApiRateLimitError) {
        pausedUntil.set(provider.name, Date.now() + error.retryAfterSeconds * 1000);
        log.warn({ provider: provider.name, retryAfterHours: error.retryAfterSeconds / 3600 }, "NewsAPI quota reached; polling paused until quota resets");
      } else if (error instanceof GNewsDailyLimitError) {
        pausedUntil.set(provider.name, nextUtcMidnight());
        log.warn({ provider: provider.name }, "GNews daily safety limit reached; polling paused until UTC midnight");
      } else {
        log.error({ err: error, provider: provider.name }, "Provider polling failed");
      }
    }
  }
  store.purge();
}

await tick();
setInterval(() => void tick(), 5_000);
log.info({ providers: providers.map((p) => p.name) }, "HitnRun XAU news bot started");
