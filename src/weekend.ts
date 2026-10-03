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

/**
 * Weekend red-only (owner, 2026-10-03): inside the weekend close, high-impact (red) news still goes to the website and the
 * members' channel, never to the groups, under its own small AI budget (WEEKEND_AI_USD_CAP per WIB day, default $1.5).
 * WEEKEND_RED_ONLY=false restores the full close.
 */
export const weekendRedOnly = (): boolean => process.env.WEEKEND_RED_ONLY !== "false";
export const weekendAiCap = (): number => { const v = Number(process.env.WEEKEND_AI_USD_CAP ?? 1.5); return Number.isFinite(v) ? v : 1.5; };
const wibDate = (now: Date) => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
const weekendSpend = { date: "", usd: 0 };
export function addWeekendSpend(usd: number, now = new Date()): void {
  const d = wibDate(now);
  if (weekendSpend.date !== d) { weekendSpend.date = d; weekendSpend.usd = 0; }
  weekendSpend.usd += Math.max(0, usd || 0);
}
export const weekendSpent = (now = new Date()): number => (weekendSpend.date === wibDate(now) ? weekendSpend.usd : 0);
/** True when no OpenAI call may leave the process. */
export function aiBlocked(now = new Date()): boolean {
  if (!weekendClosed(now)) return false;
  return !weekendRedOnly() || weekendSpent(now) >= weekendAiCap();
}
