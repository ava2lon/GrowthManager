function localMinute(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

function isQuiet(minute: number, start: number, end: number): boolean {
  return start > end ? minute >= start || minute < end : minute >= start && minute < end;
}

/** Returns the first real UTC minute outside the user's local quiet window, or null if sending is allowed now. */
export function nextAllowedSendAt(now: Date, timezone: string, startTime: string, endTime: string): Date | null {
  const parse = (value: string) => {
    const match = /^(\\d{2}):(\\d{2})$/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  };
  const start = parse(startTime);
  const end = parse(endTime);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0 || start >= 1440 || end >= 1440 || start === end) return null;
  try {
    if (!isQuiet(localMinute(now, timezone), start, end)) return null;
    const candidate = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000);
    for (let i = 0; i < 26 * 60; i += 1) {
      if (!isQuiet(localMinute(candidate, timezone), start, end)) return candidate;
      candidate.setTime(candidate.getTime() + 60_000);
    }
  } catch {
    return null;
  }
  return null;
}
