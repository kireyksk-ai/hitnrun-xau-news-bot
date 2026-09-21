import pino from "pino";
import { config } from "./config.js";
import { Editor } from "./editor.js";
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
import { Store } from "./store.js";
import { discoverTelegramDestination, sendTelegramMessage } from "./telegram.js";
import type { TelegramDestination } from "./telegram.js";
import type { NewsProvider } from "./types.js";

const log = pino({ level: config.LOG_LEVEL });
const providers: NewsProvider[] = [
    ...(config.GNEWS_API_KEY ? [new GNewsProvider(config.GNEWS_API_KEY, config.GNEWS_POLL_INTERVAL_SECONDS)] : []),
    // Keep Reuters/major-wire discovery active even when GNews is configured:
    // it catches breaking oil, sanctions, Fed and war headlines that GNews can miss.
    ...(config.GOOGLE_NEWS_RSS_ENABLED ? [new GoogleNewsRssProvider()] : []),
    ...(config.MARKETAUX_API_KEY ? [new MarketauxProvider(config.MARKETAUX_API_KEY, config.MARKETAUX_POLL_SECONDS)] : []),
    ...(config.OFFICIAL_MACRO_RSS_ENABLED ? [new OfficialMacroRssProvider(config.OFFICIAL_MACRO_RSS_POLL_SECONDS)] : []),
    ...(config.TRUTH_SOCIAL_ENABLED ? [new TruthSocialTrumpProvider(Math.max(120, config.TRUTH_SOCIAL_POLL_SECONDS))] : []),
    ...(config.TREASURY_PRESS_ENABLED ? [new TreasuryPressProvider(config.TREASURY_PRESS_POLL_SECONDS)] : []),
    ...(config.TWITTER_WIRE_ENABLED && config.X_API_BEARER_TOKEN ? [new TwitterWireProvider(config.TWITTER_WIRE_POLL_SECONDS, config.TWITTER_WIRE_MAX_MONTHLY_USD)] : []),
      ...(config.BENZINGA_API_KEY ? [new BenzingaWireProvider(config.BENZINGA_API_KEY, config.BENZINGA_POLL_SECONDS)] : []),
      ...(config.FXMACRODATA_API_KEY ? [new FxMacroDataProvider(config.FXMACRODATA_API_KEY, config.FXMACRODATA_POLL_SECONDS)] : [])
  ];
if (!providers.length) throw new Error("No news provider configured.");
const store = new Store(config.SQLITE_PATH);
const editor = new Editor(config.OPENAI_MODEL, config.OPENAI_REASONING_EFFORT, config.OPENAI_API_KEY);
const discoveredDestination = await discoverTelegramDestination(config.TELEGRAM_BOT_TOKEN);
const telegramDestination = { chatId: config.TELEGRAM_CHAT_ID ?? discoveredDestination.chatId, messageThreadId: config.TELEGRAM_MESSAGE_THREAD_ID ?? discoveredDestination.messageThreadId };
// Optional second destination (e.g. the public "HITnRUN-FX (REGULAR)" group) that gets
// every message the primary destination gets, in addition to it -- not instead of it.
const telegramDestinations: TelegramDestination[] = [
          telegramDestination,
    ...(config.TELEGRAM_CHAT_ID_REGULAR ? [{ chatId: config.TELEGRAM_CHAT_ID_REGULAR }] : [])
  ];
const lastPolledAt = new Map<string, number>();
const pausedUntil = new Map<string, number>();
let aiArticleDay = "";
let aiArticlesToday = 0;

function canUseAi(): boolean {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== aiArticleDay) { aiArticleDay = day; aiArticlesToday = 0; }
    if (aiArticlesToday >= config.MAX_AI_ARTICLES_PER_DAY) return false;
    aiArticlesToday += 1;
    return true;
}
function nextUtcMidnight(): number { const next = new Date(); next.setUTCHours(24, 0, 0, 0); return next.getTime(); }

async function tick(): Promise<void> {
    const since = new Date(Date.now() - config.MAX_ARTICLE_AGE_MINUTES * 60_000);
    for (const provider of providers) {
          const now = Date.now();
          if (now < (pausedUntil.get(provider.name) ?? 0)) continue;
          if (now < (lastPolledAt.get(provider.name) ?? 0) + (provider.pollIntervalSeconds ?? config.POLL_INTERVAL_SECONDS) * 1000) continue;
          lastPolledAt.set(provider.name, now);
          try {
                  const articles = await provider.fetchLatest(since);
                  for (const article of articles.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())) {
                            if (store.has(article)) continue;
                            if (!canUseAi()) { store.remember(article, false); continue; }
                            try {
                                        const snapshot = await marketSnapshot();
                                        const enrichedArticle = snapshot ? { ...article, summary: `${article.summary}\n\nSnapshot pasar saat headline diterima: ${snapshot}` } : article;
                                        const decision = await editor.assess(enrichedArticle);
                                        if (decision.material && decision.telegramMessage) {
                                                      for (const destination of telegramDestinations) {
                                                                      try {
                                                                                        await sendTelegramMessage(config.TELEGRAM_BOT_TOKEN, destination, decision.telegramMessage);
                                                                      } catch (sendError) {
                                                                                        log.error({ err: sendError, chatId: destination.chatId, title: article.title }, "Telegram send failed for one destination; other destinations unaffected");
                                                                      }
                                                      }
                                                      store.remember(article, true);
                                                      log.info({ provider: article.provider, title: article.title, url: article.url }, "Article sent to Telegram");
                                        }
                                        else {
                                                      store.remember(article, false);
                                                      log.info({ provider: article.provider, title: article.title, material: decision.material, confidence: decision.confidence, reason: decision.reason }, "Article assessed not material; skipped");
                                        }
                            } catch (error) {
                                        store.remember(article, false);
                                        log.error({ err: error, title: article.title }, "Article processing failed; article skipped safely");
                            }
                  }
          } catch (error) {
                  if (error instanceof GNewsDailyLimitError || error instanceof MarketauxDailyLimitError) { pausedUntil.set(provider.name, nextUtcMidnight()); log.warn({ provider: provider.name }, "Provider daily safety limit reached; polling paused until UTC midnight"); }      else
                            log.error({ err: error, provider: provider.name }, "Provider polling failed");
          }
    }
    store.purge();
}

await tick();
setInterval(() => void tick(), 5_000);
log.info({ providers: providers.map((p) => p.name), telegramDestinations: telegramDestinations.map((d) => d.chatId) }, "HitnRun XAU news bot started");
