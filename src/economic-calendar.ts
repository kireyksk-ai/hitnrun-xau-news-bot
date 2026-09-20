export type CalendarEvent = {
  title: string;
  date: Date;
  actual: string;
  forecast: string;
  previous: string;
};

type CalendarApiEvent = {
  title?: string;
  country?: string;
  date?: string;
  impact?: string;
  actual?: string;
  forecast?: string;
  previous?: string;
};

const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

function jakartaDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value ?? "";
  return value("year") + "-" + value("month") + "-" + value("day");
}

export async function fetchUsdHighImpactEvents(today = new Date()): Promise<CalendarEvent[]> {
  const response = await fetch(CALENDAR_URL, { headers: { Accept: "application/json", "User-Agent": "HitnRunFX/1.0" } });
  if (!response.ok) throw new Error("Economic calendar failed: " + response.status);
  const body = await response.json() as CalendarApiEvent[];
  const todayKey = jakartaDateKey(today);
  return body.flatMap((event) => {
    const date = new Date(event.date ?? "");
    if (event.country !== "USD" || event.impact !== "High" || Number.isNaN(date.getTime()) || jakartaDateKey(date) !== todayKey || !event.title) return [];
    return [{ title: event.title, date, actual: event.actual ?? "", forecast: event.forecast ?? "", previous: event.previous ?? "" }];
  }).sort((a, b) => a.date.getTime() - b.date.getTime());
}

function jakartaTime(date: Date): string {
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false }).format(date).replace(".", ":");
}

export function formatUsdHighImpactCalendar(events: CalendarEvent[], now = new Date()): string {
  const date = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", weekday: "long", day: "numeric", month: "long" }).format(now);
  const lines = events.map((event) => {
    const data = [event.forecast && "forecast " + event.forecast, event.previous && "sebelumnya " + event.previous].filter(Boolean).join(" | ");
    return "• " + jakartaTime(event.date) + " WIB — " + event.title + (data ? " (" + data + ")" : "");
  });
  return "📅 KALENDER USD BINTANG 3\n" + date + "\n\n" + lines.join("\n") + "\n\nIni jadwal data berdampak tinggi. Menjelang jam rilis, siapin volatilitas di XAUUSD dan DXY.";
}
