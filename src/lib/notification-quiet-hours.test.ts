import {describe, expect, it} from "vitest";
import {nextAllowedSendAt} from "./notification-quiet-hours";

describe("nextAllowedSendAt", () => {
  it("defers an overnight quiet window until the local end time", () => {
    const now = new Date("2026-01-15T23:30:00.000Z");
    expect(nextAllowedSendAt(now, "UTC", "22:00", "08:00")?.toISOString())
      .toBe("2026-01-16T08:00:00.000Z");
  });

  it("supports quiet windows contained within one local day", () => {
    const now = new Date("2026-01-15T12:00:00.000Z");
    expect(nextAllowedSendAt(now, "UTC", "09:00", "17:00")?.toISOString())
      .toBe("2026-01-15T17:00:00.000Z");
  });

  it("does not defer when the current local time is outside quiet hours", () => {
    expect(nextAllowedSendAt(new Date("2026-01-15T12:00:00.000Z"), "UTC", "22:00", "08:00"))
      .toBeNull();
  });

  it("uses IANA timezone rules across a daylight-saving transition", () => {
    const now = new Date("2026-03-08T06:30:00.000Z");
    expect(nextAllowedSendAt(now, "America/New_York", "22:00", "03:30")?.toISOString())
      .toBe("2026-03-08T07:30:00.000Z");
  });

  it("fails open for invalid timezone or time configuration", () => {
    const now = new Date("2026-01-15T23:30:00.000Z");
    expect(nextAllowedSendAt(now, "Not/A_Timezone", "22:00", "08:00")).toBeNull();
    expect(nextAllowedSendAt(now, "UTC", "08:00", "08:00")).toBeNull();
  });
});
