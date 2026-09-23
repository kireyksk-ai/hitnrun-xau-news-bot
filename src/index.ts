import pino from "pino";
import { config } from "./config.js";
import { Editor } from "./editor.js";
import { IntelligenceStore } from "./intelligence-store.js";
import { processArticle } from "./pipeline.js";
import { marketSnapshot } from "./market-snapshot.js";
import { observeMarket } from "./market-observer.js";
import { validateNewsOutput } from "./news-output.js";
import { GoogleNewsRssProvider } from "./providers/google-news-rss.js";
import { GNewsDailyLimitError, GNewsProvider } from "./providers/gnews.js";
import { MarketauxDailyLimitError, MarketauxProvider } from "./providers/marketaux.js";
import { OfficialMacroRssProvider } from "./providers/official-macro-rss.js";
import { TruthSocialTrumpProvider } from "./providers/truth-social.js";
import { TreasuryPressProvider } from "./providers/treasury-press.js";
import { TwitterWireProvider } from "./providers/twitter-wire.js";
import { BenzingaWireProvider } from "./providers/benzinga-wire.js";
import { FxMacroDataProvider } from "./providers/fxmacrodata.js";
import { NewsApiProvider } from "./providers/newsapi.js";
import { deliverTelegramMessage, discoverTelegramDestination, fetchAdminUpdates, sendTelegramMessage } from "./telegram.js";
import type { TelegramDestination } from "./telegram.js";
import type { NewsProvider } from "./types.js";
import { formatLearningStatus, formatSourceMemoryStatus, learningAlerts } from "./learning-observability.js";
import { formatDailyLearningReview } from "./daily-learning-review.js";
import { sequenceContext } from "./sequence-context.js";
import { ShadowOutcomeLedger, dueShadowMarks, formatMissedReport, markShadow, rejectedButMoved } from "./shadow-outcomes.js";
import { briefingVisuals, sendTelegramAlbum } from "./briefing-charts.js";
import { MarketBrain } from "./brain.js";
import { regimeBrief } from "./brain-regime.js";
import { BriefingLedger, briefingPrompt, dueBriefing, jakarta, releasedEvents, upcomingEvents, validateBriefing, type BriefingKind } from "./briefing.js";
import { PredictionLedger, applyMark, dueMarks, formatScorecard, scorecard, type Prediction } from "./predictions.js";
import { CalendarLedger, calendarNarrative, dueStage, fetchCalendarEvents, formatCalendarMessage, type CalendarEvent } from "./economic-calendar.js";

const log = pino({ level: config.LOG_LEVEL });
const providers: NewsProvider[] = [
  ...(config.NEWSAPI_KEY ? [new NewsApiProvider(config.NEWSAPI_KEY, config.NEWSAPI_POLL_SECONDS)] : []),
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
const quarantinedEvidence = store.quarantineIrrelevantEvidence();
if (quarantinedEvidence) log.warn({ quarantinedEvidence }, "Quarantined irrelevant legacy market-memory evidence");
const quarantinedCandidates = store.quarantineIrrelevantCandidateMemory();
if (quarantinedCandidates) log.warn({ quarantinedCandidates }, "Quarantined irrelevant legacy candidate-memory events");
for (const provider of providers) store.markProvider(provider.name, "CONFIGURED");
const editor = new Editor(config.OPENAI_MODEL, config.OPENAI_REASONING_EFFORT, config.OPENAI_API_KEY);
const discoveredDestination = config.TELEGRAM_CHAT_ID ? undefined : await discoverTelegramDestination(config.TELEGRAM_BOT_TOKEN);
const destinations: TelegramDestination[] = [
  { chatId: config.TELEGRAM_CHAT_ID ?? discoveredDestination!.chatId, messageThreadId: config.TELEGRAM_MESSAGE_THREAD_ID ?? discoveredDestination?.messageThreadId },
  ...(config.TELEGRAM_CHAT_ID_REGULAR ? [{ chatId: config.TELEGRAM_CHAT_ID_REGULAR }] : [])
];
const lastPolledAt = new Map<string, number>();
const pausedUntil = new Map<string, number>();
let aiDay = "", aiCount = 0, ticking = false, adminPolling = false;
let lastMarketObservationAt = 0;
const recentSendTimes: number[] = [];
const calendarLedger = config.ECONOMIC_CALENDAR_ENABLED ? new CalendarLedger(`${config.SQLITE_PATH}.calendar.json`) : null;
let calendarEvents: CalendarEvent[] = [], lastCalendarFetchAt = 0, calendarTicking = false;
const predictions = new PredictionLedger(`${config.SQLITE_PATH}.predictions.json`);
let lastScoringAt = 0, lastPublicScorecardWeek = "";
const shadowOutcomes = new ShadowOutcomeLedger(`${config.SQLITE_PATH}.shadow-outcomes.json`);
const briefingEditor = new Editor(config.BRIEFING_MODEL ?? config.OPENAI_MODEL, config.BRIEFING_REASONING_EFFORT, config.OPENAI_API_KEY);
const adminSend = async (text: string) => { if (config.TELEGRAM_ADMIN_CHAT_ID) await sendTelegramMessage(config.TELEGRAM_BOT_TOKEN, { chatId: config.TELEGRAM_ADMIN_CHAT_ID }, text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")); };
const brain = config.BRAIN_ENABLED ? new MarketBrain(store, editor, { basePath: config.SQLITE_PATH, autonomy: config.AUTONOMY_LEVEL, killSwitch: config.BRAIN_KILL_SWITCH,
  aiCallsPerDay: config.BRAIN_AI_CALLS_PER_DAY, dailyLossPct: config.BRAIN_DAILY_LOSS_PCT, maxDrawdownPct: config.BRAIN_MAX_DRAWDOWN_PCT,
  approve: config.POLICY_APPROVE, rollbackTo: config.POLICY_ROLLBACK_TO, report: adminSend, advisory: config.TELEGRAM_ADMIN_CHAT_ID ? adminSend : undefined }) : undefined;
const briefings = new BriefingLedger(`${config.SQLITE_PATH}.briefings.json`);
let briefingBusy = false; const briefingFailures = new Map<string, number>();
let priceCache: { at: number; price?: number } = { at: 0 };
async function cachedXauPrice(): Promise<number | undefined> {
  if (Date.now() - priceCache.at < 60_000) return priceCache.price;
  priceCache = { at: Date.now(), price: await xauPrice() };
  return priceCache.price;
}
/** Remember judged-but-rejected (and sent) candidates with the XAU price, to learn from later moves. */
async function rememberOutcome(result: import("./intelligence-store.js").ReviewRecord): Promise<void> {
  const judged = result.stage === "AI" || result.stage === "SHADOW" || result.stage === "SENT" || result.stage === "FORMAT" || result.stage === "SOURCE";
  const trustedNoise = result.stage === "SCORE" && result.event.sourceTier <= 2;
  if (!judged && !trustedNoise) return;
  shadowOutcomes.add({ id: result.id, at: new Date().toISOString(), title: result.article.title.slice(0, 200), storyKey: result.event.storyKey,
    source: result.article.provider, stage: result.stage, reason: result.reason.slice(0, 80), fact: result.event.fact.slice(0, 240),
    entryPrice: await cachedXauPrice(), marks: {} });
}

/** XAU reference price for scoring (COMEX gold futures via Yahoo; returns are what matter). */
async function xauPrice(): Promise<number | undefined> {
  try {
    const response = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?range=1d&interval=1m",
      { headers: { Accept: "application/json", "User-Agent": "HitnRunFX/1.0" }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return undefined;
    const body = await response.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; regularMarketTime?: number } }> } };
    const meta = body.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return undefined;
    // A closed market must not score calls with a frozen price.
    if (meta.regularMarketTime && Date.now() - meta.regularMarketTime * 1000 > 20 * 60_000) return undefined;
    return meta.regularMarketPrice;
  } catch { return undefined; }
}
async function recordPrediction(record: import("./intelligence-store.js").ReviewRecord, call: import("./editor.js").GoldCall | undefined): Promise<void> {
  if (!call) return;
  const entryPrice = await xauPrice();
  const item: Prediction = { id: record.id, eventId: record.event.key, storyKey: record.event.storyKey, title: record.article.title.slice(0, 160),
    createdAt: record.sentAt ?? new Date().toISOString(), direction: call.direction, confidence: call.confidence, horizonMinutes: call.horizonMinutes,
    entryPrice, entrySource: "Yahoo GC=F", marks: {} };
  predictions.add(item);
  log.info({ id: record.id, direction: call.direction, confidence: call.confidence, horizonMinutes: call.horizonMinutes, entryPrice: entryPrice ?? null }, "Prediction recorded");
}
async function scorePredictions(): Promise<void> {
  if (Date.now() - lastScoringAt < 60_000) return;
  lastScoringAt = Date.now();
  const now = new Date(), due = predictions.pending(now), shadowDue = shadowOutcomes.pending(now);
  if (!due.length && !shadowDue.length) return;
  const price = await cachedXauPrice();
  if (price === undefined) return;
  for (const item of shadowDue) {
    let next = item;
    for (const minutes of dueShadowMarks(item, now)) next = markShadow(next, minutes, price, now);
    shadowOutcomes.update(next);
  }
  for (const item of due) {
    let next = item;
    for (const minutes of dueMarks(item, now)) next = applyMark(next, minutes, price, now);
    predictions.update(next);
  }
  log.info({ scored: due.length, price }, "Predictions scored");
}
async function publicScorecard(): Promise<void> {
  if (!config.PUBLIC_SCORECARD_ENABLED) return;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", weekday: "short", hour: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (key: string) => parts.find((item) => item.type === key)?.value ?? "";
  const week = `${part("year")}-${part("month")}-${part("day")}`;
  if (part("weekday") !== "Sun" || Number(part("hour")) !== 19 || lastPublicScorecardWeek === week) return;
  lastPublicScorecardWeek = week;
  const card = scorecard(predictions.all(), Date.now() - 7 * 86400000);
  // Never publish a report card built on a handful of calls.
  if (card.atHorizon.hit + card.atHorizon.miss < 20) { log.info({ scored: card.atHorizon.hit + card.atHorizon.miss }, "Public scorecard skipped: sample too small"); return; }
  const { accepted } = await deliverTelegramMessage(config.TELEGRAM_BOT_TOKEN, destinations, formatScorecard(card, "7 hari terakhir"), store);
  log.info({ accepted: Object.keys(accepted).length }, "Public scorecard sent");
}

let budgetWarned = "";
function aiAllowed(sourceTier = 1): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== aiDay) { aiDay = day; aiCount = 0; }
  // Budget is measured in model calls, not articles; each candidate uses up to two calls.
  const limit = config.MAX_AI_ARTICLES_PER_DAY * 2;
  // Keep the last 20% of the day's budget for trusted (tier 1-2) sources only.
  const reserved = sourceTier >= 3 && aiCount >= limit * 0.8;
  if (aiCount >= limit || reserved) {
    if (aiCount >= limit && budgetWarned !== day) {
      budgetWarned = day;
      log.error({ used: aiCount, limit }, "AI budget exhausted; new candidates cannot be judged until 00:00 UTC");
      if (config.TELEGRAM_ADMIN_CHAT_ID) void sendTelegramMessage(config.TELEGRAM_BOT_TOKEN, { chatId: config.TELEGRAM_ADMIN_CHAT_ID },
        `Jatah AI harian habis (${aiCount}/${limit} panggilan). Berita baru tidak dinilai sampai 07:00 WIB. Naikkan MAX_AI_ARTICLES_PER_DAY bila perlu.`).catch(() => undefined);
    }
    return false;
  }
  aiCount++; return true;
}
async function deliver(message: string, id: string, article: import("./types.js").NewsArticle): Promise<Record<string, number>> {
  const outputCheck = validateNewsOutput(message, article);
  if (!outputCheck.ok) throw new Error(`NEWS output gate rejected ${id}: ${outputCheck.reason}`);
  if (store.safeMode) return {};
  const withinHour = recentSendTimes.filter((time) => Date.now() - time < 3600000);
  recentSendTimes.length = 0; recentSendTimes.push(...withinHour);
  if (recentSendTimes.length >= 30) {
    store.setSafeMode(true);
    log.error({ id }, "Safe mode enabled after abnormal alert volume");
    return {};
  }
  const { accepted, failures } = await deliverTelegramMessage(config.TELEGRAM_BOT_TOKEN,destinations,message,store);
  for (const failure of failures) log.error({ chatId: failure.chatId, id, error: failure.error }, "Telegram destination failed");
  if (Object.keys(accepted).length) recentSendTimes.push(Date.now());
  return accepted;
}
async function replayQueued(): Promise<number> {
  if (store.safeMode) return 0;
  let count = 0;
  for (const record of store.records().filter((r) => r.stage === "ROUTING" && r.primaryDecision === "REVIEW")) {
    const message = record.renderedMessage;
    if (!message) continue;
    const ids = await deliver(message, record.id, record.article);
    if (!Object.keys(ids).length) continue;
    store.record({ ...record, stage: "SENT", primaryDecision: "SEND", sentAt: new Date().toISOString(), telegramMessageIds: ids });
    store.rememberStory(record.event, true); store.increment("alertsSent"); count++;
  }
  return count;
}
async function calendarTick(): Promise<void> {
  if (!calendarLedger || calendarTicking) return;
  calendarTicking = true;
  try {
    const now = Date.now();
    if (now - lastCalendarFetchAt >= 300000) {
      lastCalendarFetchAt = now;
      try {
        calendarEvents = await fetchCalendarEvents();
        for (const event of calendarEvents) calendarLedger.observe(event, Date.now());
        calendarLedger.prune(Date.now());
        const missingActual = calendarEvents.filter((event) => {
          const age = Date.now() - Date.parse(event.releaseAt);
          return age >= 90 * 60000 && age <= 72 * 3600000 && !event.actual;
        });
        log.info({ events: calendarEvents.length, missingActual: missingActual.length }, "Economic calendar refreshed");
        if (missingActual.length) log.warn({ events: missingActual.map((event) => event.name) }, "Calendar release still has no actual; no result will be invented");
      } catch (error) { log.warn({ err: error }, "Economic calendar refresh failed; keeping prior schedule"); }
    }
    for (const event of calendarEvents) {
      const existing = calendarLedger.get(event.id);
      const stage = dueStage(event, Date.now(), existing, destinations.map((item) => item.chatId));
      if (!stage || store.safeMode) continue;
      const withinHour = recentSendTimes.filter((time) => Date.now() - time < 3600000);
      recentSendTimes.length = 0; recentSendTimes.push(...withinHour);
      if (recentSendTimes.length >= 30) { store.setSafeMode(true); log.error("Safe mode enabled after abnormal combined news/calendar alert volume"); break; }
      const pending = destinations.filter((destination) => !existing[stage === "WARNING" ? "warnedTo" : "actualTo"]?.[destination.chatId]);
      if (!pending.length) continue;
      const snapshot = await marketSnapshot().catch(() => "");
      const message = formatCalendarMessage(event, stage, calendarNarrative(event, stage, snapshot, existing), existing);
      const { accepted, failures } = await deliverTelegramMessage(config.TELEGRAM_BOT_TOKEN, pending, message, store);
      for (const failure of failures) log.error({ chatId: failure.chatId, event: event.name, error: failure.error }, "Calendar Telegram destination failed");
      if (Object.keys(accepted).length) { calendarLedger.mark(event.id, stage, accepted); recentSendTimes.push(Date.now()); }
      log.info({ event: event.name, stage, accepted: Object.keys(accepted).length }, "Calendar alert processed");
    }
  } finally { calendarTicking = false; }
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
  await sendTelegramMessage(config.TELEGRAM_BOT_TOKEN, { chatId: config.TELEGRAM_ADMIN_CHAT_ID }, store.report(yesterday) + appendix + `\n\n${formatScorecard(scorecard(predictions.all(), Date.now() - 7 * 86400000), "7 hari terakhir")}\n\n${formatMissedReport(shadowOutcomes.all(), new Date())}\n\n${formatLearningStatus(store)}\n\n${formatDailyLearningReview(store)}`);
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
      else if (input === "/learning") await reply(formatLearningStatus(store));
      else if (input === "/learned") await reply(formatDailyLearningReview(store));
      else if (input === "/missed") await reply(formatMissedReport(shadowOutcomes.all(), new Date()));
      else if (input === "/brain") await reply(brain?.status() ?? "Market Brain nonaktif")
      else if (input === "/rapor") await reply(formatScorecard(scorecard(predictions.all(), Date.now() - 7 * 86400000), "7 hari terakhir"));
      else if (input === "/sources") await reply(formatSourceMemoryStatus(store));
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
    try { await scorePredictions(); await publicScorecard(); } catch (error) { log.warn({ err: error }, "Prediction scoring failed"); }
    // Phase 4: independent, deterministic and shadow-only.  It has no route to deliver().
    if (Date.now() - lastMarketObservationAt >= config.MARKET_OBSERVER_INTERVAL_SECONDS * 1000) {
      lastMarketObservationAt = Date.now();
      try { const observed = await observeMarket(store); log.info({ kind: observed.decision.kind, attribution: observed.decision.attribution, assets: Object.keys(observed.point.values).length }, "Shadow market observer completed"); }
      catch (error) { log.warn({ err: error }, "Shadow market observer failed"); }
    }
    const since = new Date(Date.now() - config.MAX_ARTICLE_AGE_MINUTES * 60000);
    for (const provider of providers) {
      const now = Date.now();
      if (now < (pausedUntil.get(provider.name) ?? 0)) continue;
      if (now < (lastPolledAt.get(provider.name) ?? 0) + (provider.pollIntervalSeconds ?? config.POLL_INTERVAL_SECONDS) * 1000) continue;
      lastPolledAt.set(provider.name, now);
      try {
        const articles = await provider.fetchLatest(since);
        store.markProvider(provider.name, "FETCHED");
        if (articles.length) store.markProvider(provider.name, "LIVE");
        store.providerLatency(provider.name, Date.now() - now);
        for (const article of articles.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())) {
          const result = await processArticle(article, {
            store, snapshot: marketSnapshot,
            analyze: (item, event) => aiAllowed(event.sourceTier) ? editor.assess(item) : Promise.reject(new Error("AI budget exhausted")),
            shadow: (item, event) => aiAllowed(event.sourceTier) ? editor.shadowAssess(item, event, store.getStory(event.storyKey)) : Promise.reject(new Error("AI budget exhausted")),
            deliver,
            compose: (item, reason) => aiAllowed() ? editor.compose(item, reason) : Promise.resolve(null),
            onSent: recordPrediction,
            critic: brain && config.BRAIN_CRITIC_ENABLED ? (item, event, primary, reason) => brain.critic(item, event, primary, reason, aiAllowed(event.sourceTier)) : undefined,
            sequence: (event, item) => [sequenceContext(store.records().filter((r) => r.stage === "SENT" && r.sentAt)
              .map((r) => ({ sentAt: r.sentAt!, storyKey: r.event.storyKey, title: r.article.title, eventKey: r.event.key })), predictions.all(), event.storyKey, new Date(),
              { shadow: shadowOutcomes.all(), fact: event.fact }), brain?.contextFor(event, item) ?? ""].filter(Boolean).join("\n\n")
          });
          try { await rememberOutcome(result); } catch (error) { log.warn({ err: error }, "Outcome memory failed"); }
          try { await brain?.onResult(result); } catch (error) { log.warn({ err: error }, "Brain episode failed"); }
          log.info({ provider: provider.name, title: article.title, stage: result.stage, decision: result.primaryDecision,
            importance: result.event.importance, urgency: result.event.urgency, reason: result.reason }, "Event processed");
        }
      } catch (error) {
        store.increment("providerFailures");
        store.markProvider(provider.name, "ERROR", error instanceof Error ? error.message : "unknown error");
        if (error instanceof GNewsDailyLimitError || error instanceof MarketauxDailyLimitError) {
          const midnight = new Date(); midnight.setUTCHours(24, 0, 0, 0); pausedUntil.set(provider.name, midnight.getTime());
        }
        log.error({ err: error, provider: provider.name }, "Provider polling failed; other providers remain active");
      }
    }
    if (config.TELEGRAM_ADMIN_CHAT_ID) for (const alert of learningAlerts(store)) {
      try { await sendTelegramMessage(config.TELEGRAM_BOT_TOKEN, { chatId: config.TELEGRAM_ADMIN_CHAT_ID }, `Learning ${alert.state}: ${alert.message}`); }
      catch (error) { log.warn({ err:error, alert:alert.key }, "Admin learning alert failed"); }
    }
  } finally { ticking = false; }
}
/** Morning / 21:00 WIB desk briefing: recap + what to watch. One AI call each, outside the per-article budget. */
async function briefingTick(): Promise<void> {
  if (!config.BRIEFING_ENABLED || briefingBusy) return;
  const now = new Date();
  const kind: BriefingKind | null = dueBriefing(now, config.BRIEFING_MORNING_WIB, config.BRIEFING_EVENING_WIB, briefings.sent());
  if (!kind) return;
  briefingBusy = true;
  const j = jakarta(now);
  try {
    // Recap = everything shared in the last 24 hours (Monday morning: since Friday's session, the weekend is closed).
    const hours = kind === "PAGI" && j.weekday === 1 ? 62 : 24;
    const since = now.getTime() - hours * 3600_000;
    const sentAlerts = store.records().filter((r) => r.stage === "SENT" && r.sentAt && Date.parse(r.sentAt) >= since)
      .sort((a, b) => a.sentAt!.localeCompare(b.sentAt!)).slice(-60)
      .map((r) => ({ at: r.sentAt!, theme: r.event.storyKey, title: r.article.title.replace(/\s+/g, " ").slice(0, 160) }));
    const market = [await marketSnapshot().catch(() => ""), brain ? regimeBrief(brain.regime.current()) : ""].filter(Boolean).join(" | ");
    const visuals = config.BRIEFING_CHARTS_ENABLED ? await briefingVisuals(kind, since) : { stats: "", images: [] };
    const input = { kind, nowWib: j.label, sentAlerts, rejectedButMoved: rejectedButMoved(shadowOutcomes.all(), now, hours, 6), market, stats: visuals.stats,
      upcoming: upcomingEvents(calendarEvents, now, 24), released: releasedEvents(calendarEvents, now, hours) };
    let checked: ReturnType<typeof validateBriefing> = { ok: false, reason: "not generated" };
    for (let attempt = 0; attempt < 2 && !checked.ok; attempt++) checked = validateBriefing(await briefingEditor.briefing(briefingPrompt(input)));
    // Mark first: a failed briefing is skipped for the day instead of retried every few seconds.
    briefings.mark(kind, j.day);
    if (!checked.ok) { log.warn({ kind, reason: checked.reason }, "Briefing rejected by validator"); return; }
    // Images first (stats), then the analysis. An album failure never blocks the text.
    if (visuals.images.length) for (const destination of destinations) {
      try { await sendTelegramAlbum(config.TELEGRAM_BOT_TOKEN, destination, visuals.images); }
      catch (error) { log.warn({ err: error, chatId: destination.chatId }, "Briefing charts not delivered"); }
    }
    const { accepted, failures } = await deliverTelegramMessage(config.TELEGRAM_BOT_TOKEN, destinations, checked.text, store);
    log.info({ kind, images: visuals.images.length, accepted: Object.keys(accepted).length, failures: failures.length, alerts: sentAlerts.length, upcoming: input.upcoming.length }, "Briefing sent");
  } catch (error) {
    log.error({ err: error, kind }, "Briefing failed");
    // Up to 3 attempts inside the window, then give up for the day instead of hammering the API.
    const key = `${kind}:${j.day}`; briefingFailures.set(key, (briefingFailures.get(key) ?? 0) + 1);
    if ((briefingFailures.get(key) ?? 0) >= 3) briefings.mark(kind, j.day);
  }
  finally { briefingBusy = false; }
}

await tick();
if (brain) {
  await brain.regimeTick(true).catch((error) => log.warn({ err: error }, "Brain regime tick failed"));
  setInterval(() => void (async () => { await brain.regimeTick(); await brain.markTick(); await brain.dailyTick(); })().catch((error) => log.error({ err: error }, "Brain tick failed")), 60000);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { try { brain.flush(); } finally { process.exit(0); } });
}
setInterval(() => void briefingTick().catch((error) => log.error({ err: error }, "Briefing tick failed")), 30000);
setInterval(() => void tick().catch((error) => log.error({ err: error }, "Pipeline tick failed")), 5000);
if (config.ECONOMIC_CALENDAR_ENABLED) {
  await calendarTick();
  setInterval(() => void calendarTick().catch((error) => log.error({ err: error }, "Calendar tick failed")), 5000);
}
log.info({ providers: providers.map((p) => p.name), adminEnabled: Boolean(config.TELEGRAM_ADMIN_CHAT_ID) }, "Market intelligence worker started");
