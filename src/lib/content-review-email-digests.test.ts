import {describe, expect, it} from "vitest";
import {digestDue} from "./notification-digest-schedule";

describe("digestDue", () => {
  it("does not schedule a daily digest before the configured local time", () => {
    expect(digestDue(new Date("2026-11-07T08:59:00.000Z"), "UTC", "DAILY", "09:00"))
      .toBeNull();
  });

  it("schedules a daily digest after the configured local time", () => {
    expect(digestDue(new Date("2026-11-07T09:05:00.000Z"), "UTC", "DAILY", "09:00"))
      .toEqual({periodKey: "DAILY:2026-11-07"});
  });

  it("uses the recipient timezone for local send time and period key", () => {
    expect(digestDue(new Date("2026-11-07T08:05:00.000Z"), "Africa/Lagos", "DAILY", "09:00"))
      .toEqual({periodKey: "DAILY:2026-11-07"});
  });

  it("sends weekly digests on Monday only", () => {
    expect(digestDue(new Date("2026-11-09T09:00:00.000Z"), "UTC", "WEEKLY", "09:00"))
      .toEqual({periodKey: "WEEKLY:2026-11-09"});
    expect(digestDue(new Date("2026-11-10T09:00:00.000Z"), "UTC", "WEEKLY", "09:00"))
      .toBeNull();
  });

  it("fails closed for invalid timezone or send-time configuration", () => {
    expect(digestDue(new Date("2026-11-07T09:00:00.000Z"), "Not/A_Timezone", "DAILY", "09:00"))
      .toBeNull();
    expect(digestDue(new Date("2026-11-07T09:00:00.000Z"), "UTC", "DAILY", "invalid"))
      .toBeNull();
  });
});
