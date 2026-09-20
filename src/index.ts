import pino from "pino";
import { config } from "./config.js";
import { Editor } from "./editor.js";
import { NewsApiProvider } from "./providers/newsapi.js";
import { TruthSocialTrumpProvider } from "./providers/truth-social.js";
import { Store } from "./store.js";
import { discoverTelegramDestination, sendTelegramMessage } from "./telegram.js";
import type { NewsProvider } from "./types.js";

const log = pino({ level: config.LOG_LEVEL });
const providers: NewsProvider[] = [
  ...(config.NEWSAPI_KEY ? [new NewsApiProvider(config.NEWSAPI_KEY, config.POLL_INTERVAL_SECONDS)] : []),
  ...(config.TRUTH_SOCIAL_ENABLED ? [new TruthSocialTrumpProvider(config.TRUTH_SOCIAL_POLL_SECONDS)] : [])
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

async function tick(): Promise<void> {
  const since = new Date(Date.now() - config.MAX_ARTICLE_AGE_MINUTES * 60_000);
  for (const provider of providers) {
    const now = Date.now();
    const dueAt = (lastPolledAt.get(provider.name) ?? 0) + (provider.pollIntervalSeconds ?? config.POLL_INTERVAL_SECONDS) * 1000;
    if (now < dueAt) continue;
    lastPolledAt.set(provider.name, now);
    try {
      const articles = await provider.fetchLatest(since);
      for (const article of articles.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())) {
        if (store.has(article)) continue;
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
    } catch (error) { log.error({ err: error, provider: provider.name }, "Provider polling failed"); }
  }
  store.purge();
}

await tick();
setInterval(() => void tick(), 5_000);
log.info({ providers: providers.map((p) => p.name) }, "HitnRun XAU news bot started");
