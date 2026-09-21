import pino from "pino";
import { config } from "./config.js";
import { Editor } from "./editor.js";
import { assessEvent, highPriorityFallback } from "./event-intelligence.js";
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
                            const event = assessEvent(article);
                            const priorStory = store.getStory(event.storyKey);
                            if (store.has(article) || store.hasEvent(event.key)) continue;
                            const publish = async (message: string) => {
                              for (const destination of telegramDestinations) {
                                try { await sendTelegramMessage(config.TELEGRAM_BOT_TOKEN, destination, message); }
                                catch (sendError) { log.error({ err: sendError, chatId: destination.chatId, title: article.title }, "Telegram send failed for one destination; other destinations unaffected"); }
                              }
                              store.remember(article, true);
                              store.rememberEvent(event.key, true);
                              store.rememberStory(event.storyKey, event.action, event.changeType);
                              log.info({ provider: article.provider, title: article.title, score: event.score, highPriority: event.highPriority }, "Event sent to Telegram");
                            };
                            if (!canUseAi()) {
                              if (event.highPriority) await publish(highPriorityFallback(article, event));
                              else store.remember(article, false);
                              continue;
                            }
                            try {
                              const snapshot = await marketSnapshot();
                              const eventContext = `\n\nEvent intelligence: importance=${event.importance}/100; urgency=${event.urgency}/100; source-tier=${event.sourceTier}; classification=${event.changeType}; high-priority=${event.highPriority}; reasons=${event.reasons.join("; ")}; prior-story-action=${priorStory?.action ?? "none"}; prior-story-classification=${priorStory?.changeType ?? "none"}. First explain what changed from story state, then trace EVENT → OIL/RISK → INFLATION EXPECTATIONS → TREASURY YIELDS → DXY → XAU. Do not wait for price confirmation.`;
                              const enrichedArticle = { ...article, summary: `${article.summary}${snapshot ? `\n\nSnapshot pasar saat headline diterima: ${snapshot}` : ""}${eventContext}` };
                              const decision = await editor.assess(enrichedArticle);
                              if (decision.material && decision.telegramMessage) await publish(decision.telegramMessage);
                              else if (event.highPriority) await publish(highPriorityFallback(article, event));
                              else {
                                store.remember(article, false);
                                log.info({ provider: article.provider, title: article.title, score: event.score, material: decision.material, confidence: decision.confidence, reason: decision.reason }, "Event assessed below publish threshold");
                              }
                            } catch (error) {
                              if (event.highPriority) await publish(highPriorityFallback(article, event));
                              else store.remember(article, false);
                              log.error({ err: error, title: article.title, score: event.score, highPriority: event.highPriority }, "Event analysis failed");
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
