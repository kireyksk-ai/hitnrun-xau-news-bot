import "dotenv/config";
import { z } from "zod";

const schema = z.object({
    OPENAI_API_KEY: z.string().min(1),
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_CHAT_ID: z.string().optional().transform((value) => value?.trim() || undefined),
    TELEGRAM_MESSAGE_THREAD_ID: z.coerce.number().int().positive().optional(),
    TELEGRAM_CHAT_ID_REGULAR: z.string().optional().transform((value) => value?.trim() || undefined),
    TELEGRAM_ADMIN_CHAT_ID: z.string().optional().transform((value) => value?.trim() || undefined),
    TELEGRAM_ADMIN_USER_ID: z.coerce.number().int().positive().optional(),
    ADMIN_REPORT_HOUR_WIB: z.coerce.number().int().min(0).max(23).default(8),
    NEWSAPI_KEY: z.string().optional(),
    NEWSAPI_POLL_SECONDS: z.coerce.number().int().min(60).default(120),
    GNEWS_API_KEY: z.string().optional(),
    MARKETAUX_API_KEY: z.string().optional(),
    MARKETAUX_POLL_SECONDS: z.coerce.number().int().min(300).default(1200),
        BENZINGA_API_KEY: z.string().optional(),
        BENZINGA_POLL_SECONDS: z.coerce.number().int().min(15).default(30),
        FXMACRODATA_API_KEY: z.string().optional(),
        FXMACRODATA_POLL_SECONDS: z.coerce.number().int().min(60).default(300),
    // Weekly accuracy report card to the news group (Sunday 19:00 WIB). Off until enough calls exist.
    PUBLIC_SCORECARD_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    // Scheduled desk briefings to the news groups (WIB). Morning Mon-Sat, evening Mon-Fri.
    BRIEFING_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    BRIEFING_MORNING_WIB: z.string().regex(/^\d{2}:\d{2}$/).default("07:30"),
    BRIEFING_EVENING_WIB: z.string().regex(/^\d{2}:\d{2}$/).default("21:00"), // legacy, unused since the 3-session schedule
    // Europe: London local time (30 min before the London open). US: New York local time (30 min before 08:30 ET data). DST-aware.
    // Five-year statistical backtest (no GPT). FRED_API_KEY (free) unlocks US release history.
    BACKTEST_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    BACKTEST_YEARS: z.coerce.number().int().min(1).max(10).default(5),
    // Candle Lab: records gold OHLC 24/7, replays walk-forward, live predictions from day LEARN_DAYS+1 (measurement only).
    CANDLE_LAB_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    CANDLE_LAB_LEARN_DAYS: z.coerce.number().int().min(1).max(60).default(7),
    FRED_API_KEY: z.string().optional().transform((value) => value?.trim() || undefined),
    BRIEFING_EUROPE_LONDON: z.string().regex(/^\d{2}:\d{2}$/).default("07:30"),
    BRIEFING_US_NEWYORK: z.string().regex(/^\d{2}:\d{2}$/).default("08:00"),
    // Dedicated Sol for briefings (defaults to OPENAI_MODEL) with deeper reasoning; statistic images on by default.
    BRIEFING_MODEL: z.string().optional(),
    BRIEFING_FOOTER: z.string().default('👉 <b><a href="https://hitnrunfx.id/gabung-hitnrun-fx-academy">Gabung HitNRun FX Academy</a></b>'),
    BRIEFING_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("high"),
    BRIEFING_CHARTS_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    // Market Brain: episodes, regime engine, outcome labels, lessons, critic, internal (never published) decisions.
    BRAIN_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    BRAIN_CRITIC_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    AUTONOMY_LEVEL: z.enum(["OBSERVER", "SHADOW", "DEMO", "ADVISORY", "LIVE"]).default("SHADOW"),
    BRAIN_KILL_SWITCH: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    BRAIN_AI_CALLS_PER_DAY: z.coerce.number().int().min(0).max(500).default(40),
    BRAIN_DAILY_LOSS_PCT: z.coerce.number().min(0.1).max(10).default(1),
    BRAIN_MAX_DRAWDOWN_PCT: z.coerce.number().min(0.5).max(30).default(5),
    POLICY_APPROVE: z.string().optional(),
    POLICY_ROLLBACK_TO: z.string().optional(),
    // Currencies whose releases are posted. USD: high and medium; others: high-impact only (their gold link is explained).
    CALENDAR_CURRENCIES: z.string().default("USD,EUR,GBP,JPY,CNY,AUD,CAD").transform((v) => v.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)),
    ECONOMIC_CALENDAR_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    GNEWS_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(120).default(120),
    OFFICIAL_MACRO_RSS_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    OFFICIAL_MACRO_RSS_POLL_SECONDS: z.coerce.number().int().min(60).default(90),
    TREASURY_PRESS_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    TREASURY_PRESS_POLL_SECONDS: z.coerce.number().int().min(60).default(180),
    INVESTINGLIVE_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    INVESTINGLIVE_POLL_SECONDS: z.coerce.number().int().min(30).default(60),
    OFFICIAL_REMARKS_MAX_PER_HOUR: z.coerce.number().int().min(0).default(12),
    TWITTER_WIRE_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    TWITTER_WIRE_POLL_SECONDS: z.coerce.number().int().min(15).default(30),
    X_API_BEARER_TOKEN: z.string().optional(),
    TWITTER_WIRE_MAX_MONTHLY_USD: z.coerce.number().min(0).default(30),
    MAX_AI_ARTICLES_PER_DAY: z.coerce.number().int().min(1).max(1000).default(90),
    OPENAI_MODEL: z.string().default("gpt-5.6-sol"),
    OPENAI_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
    POLL_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(45),
    GOOGLE_NEWS_RSS_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    TRUTH_SOCIAL_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    TRUTH_SOCIAL_POLL_SECONDS: z.coerce.number().int().min(15).default(15),
    MAX_ARTICLE_AGE_MINUTES: z.coerce.number().int().min(1).default(45),
    // Shadow-only observer. It never participates in NEWS routing before Phase 5.
    MARKET_OBSERVER_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(300),
    SQLITE_PATH: z.string().default("./data/bot.sqlite"),
    LOG_LEVEL: z.string().default("info")
});

export const config = schema.parse(process.env);
