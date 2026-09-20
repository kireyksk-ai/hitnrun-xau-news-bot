import "dotenv/config";
import { z } from "zod";

const schema = z.object({
    OPENAI_API_KEY: z.string().min(1),
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_CHAT_ID: z.string().optional().transform((value) => value?.trim() || undefined),
    TELEGRAM_MESSAGE_THREAD_ID: z.coerce.number().int().positive().optional(),
    TELEGRAM_CHAT_ID_REGULAR: z.string().optional().transform((value) => value?.trim() || undefined),
    NEWSAPI_KEY: z.string().optional(),
    GNEWS_API_KEY: z.string().optional(),
    MARKETAUX_API_KEY: z.string().optional(),
    MARKETAUX_POLL_SECONDS: z.coerce.number().int().min(300).default(1200),
    GNEWS_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(120).default(120),
    OFFICIAL_MACRO_RSS_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    OFFICIAL_MACRO_RSS_POLL_SECONDS: z.coerce.number().int().min(120).default(300),
    TREASURY_PRESS_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    TREASURY_PRESS_POLL_SECONDS: z.coerce.number().int().min(60).default(180),
    TWITTER_WIRE_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    TWITTER_WIRE_POLL_SECONDS: z.coerce.number().int().min(15).default(30),
    X_API_BEARER_TOKEN: z.string().optional(),
    TWITTER_WIRE_MAX_MONTHLY_USD: z.coerce.number().min(0).default(30),
    MAX_AI_ARTICLES_PER_DAY: z.coerce.number().int().min(1).max(200).default(40),
    OPENAI_MODEL: z.string().default("gpt-5-mini"),
    OPENAI_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("high"),
    POLL_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(45),
    GOOGLE_NEWS_RSS_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    TRUTH_SOCIAL_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    TRUTH_SOCIAL_POLL_SECONDS: z.coerce.number().int().min(15).default(15),
    MAX_ARTICLE_AGE_MINUTES: z.coerce.number().int().min(1).default(20),
    SQLITE_PATH: z.string().default("./data/bot.sqlite"),
    LOG_LEVEL: z.string().default("info")
});

export const config = schema.parse(process.env);
