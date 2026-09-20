import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().optional().transform((value) => value?.trim() || undefined),
  TELEGRAM_MESSAGE_THREAD_ID: z.coerce.number().int().positive().optional(),
  NEWSAPI_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),
  OPENAI_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("high"),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(45),
  TRUTH_SOCIAL_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  TRUTH_SOCIAL_POLL_SECONDS: z.coerce.number().int().min(15).default(15),
  MAX_ARTICLE_AGE_MINUTES: z.coerce.number().int().min(1).default(20),
  SQLITE_PATH: z.string().default("./data/bot.sqlite"),
  LOG_LEVEL: z.string().default("info")
});

export const config = schema.parse(process.env);
