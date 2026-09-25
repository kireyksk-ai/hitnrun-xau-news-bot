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
import { InvestingLiveProvider } from "./providers/investinglive.js";
import { officialRemark, remarksBlock, remarksDigest } from "./official-remarks.js";
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
import { RawArchive } from "./brain-store.js";
import { NewsHunter } from "./brain-hunter.js";
import { mustReview, priorityOf } from "./brain-events.js";
import { regimeBrief } from "./brain-regime.js";
import { BriefingLedger, briefingPrompt, dueBriefing, jakarta, releasedEvents, upcomingEvents, validateBriefing, type BriefingKind, recapSince, SESSION } from "./briefing.js";
import { PredictionLedger, applyMark, dueMarks, formatScorecard, scorecard, type Prediction } from "./predictions.js";
import { CalendarLedger, calendarNarrative, currencyOf, dueStage, fetchCalendarEvents, formatCalendarDeep, formatCalendarMessage, formatSpeechQuiet, formatSpeechResult, formatWib, goldLinkNote, isSpeech, printFacts, speakerOf, type CalendarEvent } from "./economic-calendar.js";
import { calendarMatch, fetchFacts, needsFacts } from "./article-facts.js";
import { AUDIT_QUERIES, formatFunnel, formatTrace, funnel, readArchive, referenceAudit, saveReport, traceHeadline } from "./coverage.js";
import { parseRss } from "./brain-hunter.js";
import { Backtest } from "./brain-backtest.js";
import { CandleLab } from "./candle-lab.js";
import { ActualCapture, type Captured } from "./calendar-actuals.js";
import { sourceTier } from "./event-intelligence.js";
import { calendarEcho, type PostedRelease } from "./pipeline.js";
import { gated } from "./yahoo.js";

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
  ...(config.INVESTINGLIVE_ENABLED ? [new InvestingLiveProvider(config.INVESTINGLIVE_POLL_SECONDS)] : []),
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
const postedReleases: PostedRelease[] = [];
// Actuals read from the wires (calendar feeds are often late or empty); applied on every calendar refresh.
const actualCapture = new ActualCapture();
const capturedActuals = new Map<string, Captured>();
const withCaptured = (events: CalendarEvent[]) => events.map((e) => !e.actual && capturedActuals.has(e.id) ? { ...e, actual: capturedActuals.get(e.id)!.actual } : e);
let calendarEvents: CalendarEvent[] = [], lastCalendarFetchAt = 0, calendarTicking = false;
const predictions = new PredictionLedger(`${config.SQLITE_PATH}.predictions.json`);
let lastScoringAt = 0, lastPublicScorecardWeek = "";
const shadowOutcomes = new ShadowOutcomeLedger(`${config.SQLITE_PATH}.shadow-outcomes.json`);
const briefingEditor = new Editor(config.BRIEFING_MODEL ?? config.OPENAI_MODEL, config.BRIEFING_REASONING_EFFORT, config.OPENAI_API_KEY);
const hunter = config.BRAIN_ENABLED ? new NewsHunter(30, 3) : undefined;
if (hunter) providers.push(hunter);
const adminSend = async (text: string) => { if (config.TELEGRAM_ADMIN_CHAT_ID) await sendTelegramMessage(config.TELEGRAM_BOT_TOKEN, { chatId: config.TELEGRAM_ADMIN_CHAT_ID }, text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")); };
const brain = config.BRAIN_ENABLED ? new MarketBrain(store, editor, { basePath: config.SQLITE_PATH, autonomy: config.AUTONOMY_LEVEL, killSwitch: config.BRAIN_KILL_SWITCH,
  aiCallsPerDay: config.BRAIN_AI_CALLS_PER_DAY, dailyLossPct: config.BRAIN_DAILY_LOSS_PCT, maxDrawdownPct: config.BRAIN_MAX_DRAWDOWN_PCT,
  approve: config.POLICY_APPROVE, rollbackTo: config.POLICY_ROLLBACK_TO, report: adminSend, advisory: config.TELEGRAM_ADMIN_CHAT_ID ? adminSend : undefined,
  calendar: () => calendarEvents, hunter }) : undefined;
const rawArchive = new RawArchive(`${config.SQLITE_PATH}.raw`);
const backtest = config.BACKTEST_ENABLED ? new Backtest(`${config.SQLITE_PATH}.backtest`, config.FRED_API_KEY, config.BACKTEST_YEARS) : undefined;
let backtestBusy = false;
if (backtest) setInterval(() => { if (backtestBusy) return; backtestBusy = true; void backtest.step().catch((error) => log.warn({ err: error }, "Backtest step crashed")).finally(() => { backtestBusy = false; }); }, 20_000);
const candleLab = config.CANDLE_LAB_ENABLED ? new CandleLab(`${config.SQLITE_PATH}.candles`, () => store.records().filter((r) => r.stage === "SENT" && r.sentAt).map((r) => Date.parse(r.sentAt!)), config.CANDLE_LAB_LEARN_DAYS) : undefined;
let candleBusy = false;
if (candleLab) setInterval(() => { if (candleBusy) return; candleBusy = true; void candleLab.tick().catch((error) => log.warn({ err: error }, "Candle lab tick failed")).finally(() => { candleBusy = false; }); }, 60_000);
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
    const response = await gated(fetch)("https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?range=1d&interval=1m",
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
    // Around a high-impact release refresh every minute so the result is posted fast; otherwise every 5 minutes.
    const hot = calendarEvents.some((e) => e.impact === "high" && config.CALENDAR_CURRENCIES.includes(currencyOf(e)) && !e.actual && now >= Date.parse(e.releaseAt) - 60_000 && now <= Date.parse(e.releaseAt) + 45 * 60_000);
    if (now - lastCalendarFetchAt >= (hot ? 60_000 : 300000)) {
      lastCalendarFetchAt = now;
      try {
        // Owner-critical US releases (CPI, PCE, PPI, NFP, claims, FOMC...) are treated as high impact everywhere.
        calendarEvents = withCaptured((await fetchCalendarEvents()).map((e) => e.impact !== "high" && currencyOf(e) === "USD" && priorityOf(e.name) === "CRITICAL" ? { ...e, impact: "high" as const } : e));
        for (const event of calendarEvents) calendarLedger.observe(event, Date.now());
        calendarLedger.prune(Date.now());
        const missingActual = calendarEvents.filter((event) => {
          const age = Date.now() - Date.parse(event.releaseAt);
          return age >= 90 * 60000 && age <= 72 * 3600000 && !event.actual && Boolean(event.consensus || event.prior); // speeches have no figure
        });
        log.info({ events: calendarEvents.length, missingActual: missingActual.length }, "Economic calendar refreshed");
        if (missingActual.length) log.warn({ events: missingActual.map((event) => event.name) }, "Calendar release still has no actual; no result will be invented");
      } catch (error) { log.warn({ err: error }, "Economic calendar refresh failed; keeping prior schedule"); }
    }
    const doneThisTick = new Set<string>();
    for (const event of calendarEvents) {
      if (doneThisTick.has(event.id)) continue;
      const currency = currencyOf(event);
      if (!config.CALENDAR_CURRENCIES.includes(currency) || (currency !== "USD" && event.impact !== "high")) continue;
      const existing = calendarLedger.get(event.id);
      const stage = dueStage(event, Date.now(), existing, destinations.map((item) => item.chatId));
      if (!stage || store.safeMode) continue;
      const withinHour = recentSendTimes.filter((time) => Date.now() - time < 3600000);
      recentSendTimes.length = 0; recentSendTimes.push(...withinHour);
      if (recentSendTimes.length >= 30) { store.setSafeMode(true); log.error("Safe mode enabled after abnormal combined news/calendar alert volume"); break; }
      const pending = destinations.filter((destination) => !existing[stage === "WARNING" ? "warnedTo" : "actualTo"]?.[destination.chatId]);
      if (!pending.length) continue;
      const snapshot = await marketSnapshot().catch(() => "");
      // US results: one institutional note per release time covering every US print released together.
      if (stage === "ACTUAL" && currency === "USD" && event.actual) {
        // Prints released together (CPI m/m, y/y, core...) arrive seconds apart: wait up to 3 minutes for the set.
        const set = calendarEvents.filter((e) => e.releaseAt === event.releaseAt && currencyOf(e) === "USD" && e.impact !== "low");
        if (set.some((e) => !e.actual) && Date.now() - Date.parse(event.releaseAt) < 180_000) continue;
        const group = calendarEvents.filter((e) => e.releaseAt === event.releaseAt && currencyOf(e) === "USD" && e.actual && !doneThisTick.has(e.id)
          && dueStage(e, Date.now(), calendarLedger!.get(e.id), destinations.map((item) => item.chatId)) === "ACTUAL")
          .sort((a, b) => (a.impact === "high" ? 0 : 1) - (b.impact === "high" ? 0 : 1));
        const items = group.map((e) => ({ event: e, saved: calendarLedger!.get(e.id) }));
        try {
          const upcoming = calendarEvents.filter((e) => currencyOf(e) === "USD" && (e.impact === "high" || e.impact === "medium") && Date.parse(e.releaseAt) > Date.now() && Date.parse(e.releaseAt) - Date.now() < 3 * 86400_000)
            .slice(0, 8).map((e) => `${formatWib(e.releaseAt)} ${e.name} (perkiraan ${e.consensus ?? "n/a"}, sebelumnya ${e.prior ?? "n/a"})`).join("; ");
          const context = [goldLinkNote("USD"), brain ? await brain.calendarContext(event, "ACTUAL") : snapshot, ...items.map((i) => backtest?.insight(i.event.name, brain?.linkage() ?? "MIXED") ?? "")].filter(Boolean).join("\n");
          const dive = await Promise.race([
            briefingEditor.calendarDeepDive({ releaseWib: formatWib(event.releaseAt), prints: items.map((i) => printFacts(i.event, i.saved)), context, nextEvents: upcoming ? `AGENDA BERIKUTNYA: ${upcoming}` : "AGENDA BERIKUTNYA: (kosong)" }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 90_000))
          ]);
          const text = dive ? Object.values(dive).join(" ") : "";
          if (dive && Object.values(dive).every((v) => v.length > 40) && !/https?:\/\/|\b(entry|stop ?loss|take profit|dijamin|pasti naik|pasti turun)\b/i.test(text)) {
            const message = formatCalendarDeep(items, dive);
            const targets = destinations.filter((d) => !items.every((i) => i.saved.actualTo?.[d.chatId]));
            const { accepted, failures } = await deliverTelegramMessage(config.TELEGRAM_BOT_TOKEN, targets, message, store);
            for (const failure of failures) log.error({ chatId: failure.chatId, event: event.name, error: failure.error }, "Calendar Telegram destination failed");
            if (Object.keys(accepted).length) {
              for (const i of items) { calendarLedger.mark(i.event.id, "ACTUAL", accepted); doneThisTick.add(i.event.id); postedReleases.push({ at: Date.now(), name: i.event.name, actual: i.event.actual! }); }
              postedReleases.splice(0, Math.max(0, postedReleases.length - 50)); recentSendTimes.push(Date.now());
            }
            log.info({ events: items.map((i) => i.event.name), accepted: Object.keys(accepted).length, chars: message.length }, "Calendar US deep analysis processed");
            continue;
          }
          log.warn({ event: event.name }, "US deep analysis incomplete; falling back to the short result");
        } catch (error) { log.warn({ err: error, event: event.name }, "US deep analysis failed; falling back to the short result"); }
      }
      // Sol writes the warning/result in the owner's voice with the playbook chain; the fixed template is the fallback.
      let explanation = calendarNarrative(event, stage, snapshot, existing), analysed = false;
      try {
        const context = [`MATA UANG: ${currency}. ${goldLinkNote(currency)}`, brain ? await brain.calendarContext(event, stage) : snapshot, currency === "USD" ? backtest?.insight(event.name, brain?.linkage() ?? "MIXED") ?? "" : ""].filter(Boolean).join("\n");
        const consensus = (existing.firstSeenForecast !== undefined ? existing.firstSeenForecast : event.consensus) ?? null;
        const written = await Promise.race([
          briefingEditor.calendarText({ stage, name: event.name, country: currency, releaseWib: formatWib(event.releaseAt), actual: event.actual, consensus, prior: (existing.firstSeenPrior !== undefined ? existing.firstSeenPrior : event.prior) ?? null, context }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000))
        ]);
        if (written && written.meaning && written.narrative && !/https?:\/\/|\b(entry|stop ?loss|take profit|dijamin|pasti naik|pasti turun)\b/i.test(`${written.meaning} ${written.narrative}`)) { explanation = written; analysed = true; }
      } catch (error) { log.warn({ err: error, event: event.name }, "Calendar AI text failed; using template"); }
      const message = formatCalendarMessage(event, stage, explanation, existing, analysed);
      const { accepted, failures } = await deliverTelegramMessage(config.TELEGRAM_BOT_TOKEN, pending, message, store);
      for (const failure of failures) log.error({ chatId: failure.chatId, event: event.name, error: failure.error }, "Calendar Telegram destination failed");
      if (Object.keys(accepted).length) { calendarLedger.mark(event.id, stage, accepted); recentSendTimes.push(Date.now()); if (stage === "ACTUAL" && event.actual) { postedReleases.push({ at: Date.now(), name: event.name, actual: event.actual }); postedReleases.splice(0, Math.max(0, postedReleases.length - 50)); } }
      log.info({ event: event.name, stage, accepted: Object.keys(accepted).length }, "Calendar alert processed");
    }
    await speechResults();
  } finally { calendarTicking = false; }
}
/**
 * A warned speech has no figure, so its result is what was said: 20 minutes to 4 hours after the start,
 * headlines naming the speaker (fetched by any provider, sent or not) are summarised into a HASIL post.
 * Nothing is posted when no headline exists; nothing is invented.
 */
async function speechResults(): Promise<void> {
  if (!calendarLedger || store.safeMode) return;
  const now = Date.now();
  const due = calendarEvents.filter((e) => {
    const age = now - Date.parse(e.releaseAt), d = calendarLedger!.get(e.id);
    return isSpeech(e) && age >= 20 * 60_000 && age <= 4 * 3_600_000 && Boolean(d.warnedTo && Object.keys(d.warnedTo).length) && !(d.actualTo && Object.keys(d.actualTo).length);
  });
  if (!due.length || now - lastSpeechScan < 5 * 60_000) return;
  lastSpeechScan = now;
  const archive = readArchive(`${config.SQLITE_PATH}.raw`, new Date(now), 2);
  for (const event of due) {
    const speaker = speakerOf(event.name);
    if (!speaker) continue;
    const from = Date.parse(event.releaseAt) - 15 * 60_000, re = new RegExp(`\\b${speaker}\\b`, "i");
    const titles = [...new Set(archive.filter((a) => re.test(a.item.title ?? "") && Date.parse(a.item.publishedAt ?? a.fetchedAt) >= from).map((a) => (a.item.title ?? "").trim()))].slice(0, 12);
    const age = now - Date.parse(event.releaseAt);
    if (!titles.length) {
      // Never leave a warning hanging: after 3h with no reported line (hunted on Google News, wires and investingLive), close it honestly.
      if (age < 3 * 3_600_000) continue;
      const waiting = destinations.filter((d) => !calendarLedger!.get(event.id).actualTo?.[d.chatId]);
      if (!waiting.length) continue;
      const { accepted } = await deliverTelegramMessage(config.TELEGRAM_BOT_TOKEN, waiting, formatSpeechQuiet(event), store);
      if (Object.keys(accepted).length) { calendarLedger.mark(event.id, "ACTUAL", accepted); recentSendTimes.push(Date.now()); }
      log.info({ event: event.name, speaker, accepted: Object.keys(accepted).length }, "Speech closed: no new remarks reported");
      continue;
    }
    // Give the wires time to publish more than one line unless the talk is already well past.
    if (titles.length < 2 && age < 60 * 60_000) continue;
    const currency = currencyOf(event);
    const pending = destinations.filter((d) => !calendarLedger!.get(event.id).actualTo?.[d.chatId]);
    if (!pending.length) continue;
    try {
      const context = [`MATA UANG: ${currency}. ${goldLinkNote(currency)}`, `HEADLINE PIDATO ${speaker.toUpperCase()} (satu-satunya bahan fakta):\n${titles.map((t) => `- ${t}`).join("\n")}`,
        brain ? await brain.calendarContext(event, "ACTUAL") : await marketSnapshot().catch(() => "")].filter(Boolean).join("\n");
      const written = await briefingEditor.calendarText({ stage: "ACTUAL", speech: true, name: event.name, country: currency, releaseWib: formatWib(event.releaseAt), actual: null, consensus: null, prior: null, context });
      if (!written.meaning || !written.narrative || /https?:\/\/|\b(entry|stop ?loss|take profit|dijamin|pasti naik|pasti turun)\b/i.test(`${written.meaning} ${written.narrative}`)) continue;
      const { accepted, failures } = await deliverTelegramMessage(config.TELEGRAM_BOT_TOKEN, pending, formatSpeechResult(event, written, titles.length), store);
      for (const failure of failures) log.error({ chatId: failure.chatId, event: event.name, error: failure.error }, "Speech result destination failed");
      if (Object.keys(accepted).length) { calendarLedger.mark(event.id, "ACTUAL", accepted); recentSendTimes.push(Date.now()); }
      log.info({ event: event.name, speaker, headlines: titles.length, accepted: Object.keys(accepted).length }, "Speech result processed");
    } catch (error) { log.warn({ err: error, event: event.name }, "Speech result failed"); }
  }
}
let lastSpeechScan = 0;
/** Owner rule: official remarks on policy, prices, trade or war must be published. Capped per hour so a burst can never trip safe mode. */
const forcedAt: number[] = [];
function mustSendRemark(item: import("./types.js").NewsArticle): boolean {
  if (!officialRemark(item)) return false;
  const now = Date.now();
  while (forcedAt.length && now - forcedAt[0] > 3_600_000) forcedAt.shift();
  if (forcedAt.length >= config.OFFICIAL_REMARKS_MAX_PER_HOUR) { log.warn({ title: item.title.slice(0, 120) }, "Official remark over hourly cap; normal judgment applies"); return false; }
  forcedAt.push(now);
  return true;
}
/** Every official remark seen by any provider in the last `hours`, sent or not, for Sol and the briefings. Cached 60s. */
let remarksCache = { at: 0, key: "", text: "" };
function officialContext(hours: number, max: number): string {
  const now = Date.now(), key = `${hours}|${max}`;
  if (remarksCache.key === key && now - remarksCache.at < 60_000) return remarksCache.text;
  let text = "";
  try {
    const archive = readArchive(`${config.SQLITE_PATH}.raw`, new Date(now), hours > 20 ? 3 : 2).map((a) => ({ ...a.item, fetchedAt: a.fetchedAt }));
    text = remarksBlock(remarksDigest(archive, now - hours * 3_600_000, max), `UCAPAN PEJABAT ${hours} JAM TERAKHIR`);
  } catch (error) { log.warn({ err: error }, "Official remarks digest failed"); }
  remarksCache = { at: now, key, text };
  return text;
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
/**
 * Daily coverage audit (after the admin report hour): funnel of yesterday plus an independent
 * reference sample from narrow searches. Always logged and saved to disk; sent to admin if configured.
 */
let lastCoverageDay = "";
async function coverageTick(): Promise<void> {
  const j = jakarta(new Date());
  const hour = Math.floor(j.minutes / 60);
  if (hour < config.ADMIN_REPORT_HOUR_WIB || lastCoverageDay === j.day) return;
  lastCoverageDay = j.day;
  const day = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  try {
    const archive = readArchive(`${config.SQLITE_PATH}.raw`, new Date(), 3);
    const reference: Array<{ title: string }> = [];
    for (const q of AUDIT_QUERIES) {
      try {
        const url = new URL("https://news.google.com/rss/search");
        url.searchParams.set("q", `${q} when:1d`); url.searchParams.set("hl", "en-US"); url.searchParams.set("gl", "US"); url.searchParams.set("ceid", "US:en");
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; HitnRunMarketMonitor/1.0)" }, signal: AbortSignal.timeout(12_000) });
        if (r.ok) reference.push(...parseRss(await r.text(), new Date(Date.now() - 36 * 3600_000)).slice(0, 12));
      } catch { /* one failed query does not stop the audit */ }
    }
    const f = funnel(day, archive, store.records());
    const audit = referenceAudit(reference, archive, store.records());
    const text = formatFunnel(f, audit);
    saveReport(`${config.SQLITE_PATH}.coverage`, day, text);
    log.info({ day, stages: f.stages, providers: f.providers, withFacts: f.withFacts, headlineOnly: f.headlineOnly, audit: { total: audit.total, byStatus: audit.byStatus, missing: audit.missing.slice(0, 5) } }, "Coverage audit");
    if (config.TELEGRAM_ADMIN_CHAT_ID) await sendTelegramMessage(config.TELEGRAM_BOT_TOKEN, { chatId: config.TELEGRAM_ADMIN_CHAT_ID }, text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 3900));
  } catch (error) { log.warn({ err: error }, "Coverage audit failed"); }
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
      else if (input.startsWith("/cek ")) {
        const query = input.slice(5).trim();
        await reply(formatTrace(query, traceHeadline(query, readArchive(`${config.SQLITE_PATH}.raw`), store.records())).slice(0, 3900));
      }
      else if (input === "/candle") await reply((candleLab?.status() ?? "Candle lab nonaktif").slice(0, 3900));
      else if (input === "/backtest") await reply((backtest?.status() ?? "Backtest nonaktif").slice(0, 3900));
      else if (input === "/corong") await reply(formatFunnel(funnel(new Date().toISOString().slice(0, 10), readArchive(`${config.SQLITE_PATH}.raw`), store.records())).slice(0, 3900));
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
    await pollAdmin(); await adminReport(); await coverageTick();
    try { await scorePredictions(); await publicScorecard(); } catch (error) { log.warn({ err: error }, "Prediction scoring failed"); }
    // Phase 4: independent, deterministic and shadow-only.  It has no route to deliver().
    if (Date.now() - lastMarketObservationAt >= config.MARKET_OBSERVER_INTERVAL_SECONDS * 1000) {
      lastMarketObservationAt = Date.now();
      try { const observed = await observeMarket(store); log.info({ kind: observed.decision.kind, attribution: observed.decision.attribution, assets: Object.keys(observed.point.values).length }, "Shadow market observer completed"); }
      catch (error) { log.warn({ err: error }, "Shadow market observer failed"); }
    }
    try { await replayAiFailures(); } catch (error) { log.warn({ err: error }, "AI outage replay failed"); }
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
          rawArchive.append(provider.name, article);
          try {
            for (const c of actualCapture.offer(article, sourceTier(article), calendarEvents)) {
              capturedActuals.set(c.id, c);
              calendarEvents = withCaptured(calendarEvents);
              // The calendar result will carry this number; the news copy of it is then a duplicate.
              postedReleases.push({ at: Date.now(), name: c.name, actual: c.actual });
              log.info({ event: c.name, actual: c.actual, source: c.source }, "Calendar actual captured from wire");
              void calendarTick().catch((error) => log.warn({ err: error }, "Calendar tick after capture failed"));
            }
          } catch (error) { log.warn({ err: error }, "Actual capture failed"); }
          const result = await processArticle(article, articleDeps());
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
function articleDeps(): Parameters<typeof processArticle>[1] {
  return {
    store, snapshot: marketSnapshot,
    analyze: (item, event) => aiAllowed(event.sourceTier) ? editor.assess(item) : Promise.reject(new Error("AI budget exhausted")),
    shadow: (item, event) => aiAllowed(event.sourceTier) ? editor.shadowAssess(item, event, store.getStory(event.storyKey)) : Promise.reject(new Error("AI budget exhausted")),
    deliver,
    compose: (item, reason) => aiAllowed() ? editor.compose(item, reason) : Promise.resolve(null),
    onSent: recordPrediction,
    mustSend: (item) => mustSendRemark(item),
    important: brain ? (item, event) => mustReview(`${item.title} ${item.summary.slice(0, 400)}`, event.sourceTier) : undefined,
    facts: async (item) => ({
      page: needsFacts(item.title, item.summary) ? await fetchFacts(item.url).catch(() => "") : "",
      calendar: calendarMatch(`${item.title} ${item.summary.slice(0, 300)}`, calendarEvents)
    }),
    releaseEcho: (item) => calendarEcho(`${item.title} ${item.summary}`, postedReleases, Date.now()),
    critic: brain && config.BRAIN_CRITIC_ENABLED ? (item, event, primary, reason) => brain.critic(item, event, primary, reason, aiAllowed(event.sourceTier)) : undefined,
    sequence: (event, item) => [sequenceContext(store.records().filter((r) => r.stage === "SENT" && r.sentAt)
      .map((r) => ({ sentAt: r.sentAt!, storyKey: r.event.storyKey, title: r.article.title, eventKey: r.event.key })), predictions.all(), event.storyKey, new Date(),
      { shadow: shadowOutcomes.all(), fact: event.fact }), brain?.contextFor(event, item) ?? "", officialContext(6, 15), candleLab?.experience() ?? ""].filter(Boolean).join("\n\n")
  };
}
/** After an AI outage (e.g. no credits) the failed candidates of the last hour (older news is stale) are judged again, a few per tick. */
const replayTries = new Map<string, { n: number; at: number }>();
async function replayAiFailures(): Promise<void> {
  const now = Date.now();
  const due = store.records().filter((r) => r.stage === "AI_CONTRACT_FAILURE" && now - Date.parse(r.event.firstSeenAt) <= 3_600_000)
    .filter((r) => { const t = replayTries.get(r.id); return !t || (t.n < 3 && now - t.at >= 120_000); })
    .sort((a, b) => b.event.firstSeenAt.localeCompare(a.event.firstSeenAt)).slice(0, 3);
  for (const r of due) {
    const t = replayTries.get(r.id); replayTries.set(r.id, { n: (t?.n ?? 0) + 1, at: now });
    try {
      const result = await processArticle({ ...r.article, publishedAt: new Date(r.article.publishedAt) }, articleDeps());
      try { await rememberOutcome(result); } catch { /* measurement only */ }
      log.info({ title: r.article.title.slice(0, 120), stage: result.stage, reason: result.reason.slice(0, 120) }, "Replayed after AI outage");
    } catch (error) { log.warn({ err: error, id: r.id }, "Replay after AI outage failed"); }
  }
  if (replayTries.size > 500) for (const [k, v] of replayTries) if (now - v.at > 3 * 3_600_000) replayTries.delete(k);
}
/** Morning / 21:00 WIB desk briefing: recap + what to watch. One AI call each, outside the per-article budget. */
async function briefingTick(): Promise<void> {
  if (!config.BRIEFING_ENABLED || briefingBusy) return;
  const now = new Date();
  const schedule = { asiaWib: config.BRIEFING_MORNING_WIB, europeLondon: config.BRIEFING_EUROPE_LONDON, usNewYork: config.BRIEFING_US_NEWYORK };
  const kind: BriefingKind | null = dueBriefing(now, schedule, briefings.sent());
  if (!kind) return;
  briefingBusy = true;
  const j = jakarta(now);
  try {
    // Recap = everything shared since the previous session's briefing (Asia on Monday: since Friday's US session).
    const since = Math.min(recapSince(kind, now, schedule), now.getTime() - 3 * 3600_000);
    const hours = Math.max(1, Math.round((now.getTime() - since) / 3600_000));
    const sentAlerts = store.records().filter((r) => r.stage === "SENT" && r.sentAt && Date.parse(r.sentAt) >= since)
      .sort((a, b) => a.sentAt!.localeCompare(b.sentAt!)).slice(-60)
      .map((r) => ({ at: r.sentAt!, theme: r.event.storyKey, title: r.article.title.replace(/\s+/g, " ").slice(0, 160) }));
    const market = [await marketSnapshot().catch(() => ""), brain ? regimeBrief(brain.regime.current()) : "", brain ? brain.macroBrief() : "", backtest?.regime() ?? ""].filter(Boolean).join(" | ");
    const visuals = config.BRIEFING_CHARTS_ENABLED ? await briefingVisuals(kind, since) : { stats: "", images: [] };
    const input = { kind, nowWib: j.label, recapHours: hours, sentAlerts, rejectedButMoved: rejectedButMoved(shadowOutcomes.all(), now, hours, 6), market, stats: visuals.stats,
      upcoming: upcomingEvents(calendarEvents, now, SESSION[kind].upcomingHours).map((e) => ({ ...e, history: [brain?.calendarInsight(e.name), currencyOf({ ...e, url: "" }) === "USD" ? backtest?.insight(e.name, brain?.linkage() ?? "MIXED") : ""].filter(Boolean).join(" | ") || undefined })), released: releasedEvents(calendarEvents, now, hours) };
    let checked: ReturnType<typeof validateBriefing> = { ok: false, reason: "not generated" };
    for (let attempt = 0; attempt < 2 && !checked.ok; attempt++) {
      // The retry is told exactly why the first draft was rejected, instead of repeating the same prompt.
      const retryNote = attempt && !checked.ok ? `\n\nDRAF SEBELUMNYA DITOLAK (${checked.reason}). Tulis ulang lebih ringkas: maksimal ${SESSION[kind].words} kata, patuhi semua aturan di atas.` : "";
      const remarks = officialContext(hours, 25);
      checked = validateBriefing(await briefingEditor.briefing(briefingPrompt(input) + (remarks ? `\n\n${remarks}` : "") + retryNote));
      if (!checked.ok) log.warn({ kind, attempt, reason: checked.reason }, "Briefing draft rejected; retrying");
    }
    // Mark first: a failed briefing is skipped for the day instead of retried every few seconds.
    briefings.mark(kind, j.day);
    if (!checked.ok) { log.warn({ kind, reason: checked.reason }, "Briefing rejected by validator"); return; }
    // Images first (stats), then the analysis. An album failure never blocks the text.
    // Owner rule (2026-09-25): every group gets the briefing; only HnR Regular gets the Academy sign-up link under it.
    if (visuals.images.length) for (const destination of destinations) {
      try { await sendTelegramAlbum(config.TELEGRAM_BOT_TOKEN, destination, visuals.images); }
      catch (error) { log.warn({ err: error, chatId: destination.chatId }, "Briefing charts not delivered"); }
    }
    const regular = destinations.filter((d) => d.chatId === config.TELEGRAM_CHAT_ID_REGULAR), others = destinations.filter((d) => d.chatId !== config.TELEGRAM_CHAT_ID_REGULAR);
    const withLink = config.BRIEFING_FOOTER ? `${checked.text}\n\n${config.BRIEFING_FOOTER}` : checked.text;
    const plain = others.length ? await deliverTelegramMessage(config.TELEGRAM_BOT_TOKEN, others, checked.text, store) : { accepted: {}, failures: [] };
    const linked = regular.length ? await deliverTelegramMessage(config.TELEGRAM_BOT_TOKEN, regular, withLink, store) : { accepted: {}, failures: [] };
    const accepted = { ...plain.accepted, ...linked.accepted }, failures = [...plain.failures, ...linked.failures];
    log.info({ kind, images: visuals.images.length, accepted: Object.keys(accepted).length, withLink: Object.keys(linked.accepted).length, failures: failures.length, alerts: sentAlerts.length, upcoming: input.upcoming.length }, "Briefing sent");
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
  await brain.macroTick(true).catch((error) => log.warn({ err: error }, "Brain macro tick failed"));
  setInterval(() => void (async () => { await brain.regimeTick(); await brain.macroTick(); await brain.markTick(); await brain.calendarTick(); await brain.dailyTick(); })().catch((error) => log.error({ err: error }, "Brain tick failed")), 60000);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { try { brain.flush(); } finally { process.exit(0); } });
}
setInterval(() => void briefingTick().catch((error) => log.error({ err: error }, "Briefing tick failed")), 30000);
setInterval(() => void tick().catch((error) => log.error({ err: error }, "Pipeline tick failed")), 5000);
if (config.ECONOMIC_CALENDAR_ENABLED) {
  await calendarTick();
  setInterval(() => void calendarTick().catch((error) => log.error({ err: error }, "Calendar tick failed")), 5000);
}
log.info({ providers: providers.map((p) => p.name), adminEnabled: Boolean(config.TELEGRAM_ADMIN_CHAT_ID) }, "Market intelligence worker started");
