/**
 * Weekend close (owner, 2026-10-03): gold is shut, so from Saturday 00:00 WIB to Monday 04:00 WIB the bot posts
 * nothing to any group and makes no OpenAI call at all (no charge). Admin commands keep working.
 */
export const WEEKEND_REOPEN_HOUR_WIB = 4;

export function weekendClosed(now = new Date(), enabled = process.env.WEEKEND_CLOSE_ENABLED !== "false"): boolean {
  if (!enabled) return false;
  const w = new Date(now.getTime() + 7 * 3_600_000);
  const day = w.getUTCDay();
  return day === 6 || day === 0 || (day === 1 && w.getUTCHours() < WEEKEND_REOPEN_HOUR_WIB);
}
