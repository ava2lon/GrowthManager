function digestClock(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return {date: value("year") + "-" + value("month") + "-" + value("day"), weekday: value("weekday"), minute: Number(value("hour")) * 60 + Number(value("minute"))};
}

function digestPeriodKey(date: string, frequency: string): string {
  if (frequency !== "WEEKLY") return "DAILY:" + date;
  const day = new Date(date + "T00:00:00.000Z").getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const monday = new Date(Date.parse(date + "T00:00:00.000Z") - daysSinceMonday * 86_400_000);
  return "WEEKLY:" + monday.toISOString().slice(0, 10);
}

export function digestDue(now: Date, timezone: string, frequency: string, sendTime: string): {periodKey: string} | null {
  try {
    const clock = digestClock(now, timezone);
    const match = /^(\\d{2}):(\\d{2})$/.exec(sendTime);
    if (!match) return null;
    const targetMinute = Number(match[1]) * 60 + Number(match[2]);
    if (clock.minute < targetMinute) return null;
    if (frequency === "WEEKLY" && clock.weekday !== "Mon") return null;
    if (frequency !== "DAILY" && frequency !== "WEEKLY") return null;
    return {periodKey: digestPeriodKey(clock.date, frequency)};
  } catch {
    return null;
  }
}
