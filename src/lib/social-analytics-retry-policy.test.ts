import {describe, expect, it} from "vitest";
import {
  ANALYTICS_RETRY_MAX_ATTEMPTS,
  classifyAnalyticsFailure,
  getAnalyticsRetryAt,
} from "@/lib/social-analytics-retry-policy";

describe("classifyAnalyticsFailure", () => {
  it.each([
    "META_RATE_LIMITED",
    "META_NETWORK_ERROR",
    "META_PROVIDER_UNAVAILABLE",
    "LINKEDIN_PROVIDER_UNAVAILABLE",
    "LINKEDIN_REFRESH_UNAVAILABLE",
    "TIKTOK_ANALYTICS_NETWORK_ERROR",
    "TIKTOK_ANALYTICS_PROVIDER_UNAVAILABLE",
    "TIKTOK_REFRESH_UNAVAILABLE",
    "YOUTUBE_ANALYTICS_RATE_LIMITED",
    "YOUTUBE_ANALYTICS_PROVIDER_UNAVAILABLE",
    "YOUTUBE_REFRESH_UNAVAILABLE",
    "X_PROVIDER_UNAVAILABLE",
    "PINTEREST_NETWORK_ERROR",
    "PINTEREST_REFRESH_UNAVAILABLE",
  ])("retries transient failure %s", (code) => {
    expect(classifyAnalyticsFailure(code)).toBe("RETRY");
  });

  it.each([
    "META_AUTH_FAILED",
    "LINKEDIN_PERMISSION_DENIED",
    "TIKTOK_ANALYTICS_SCOPE_MISSING",
    "YOUTUBE_REAUTHORIZATION_REQUIRED",
    "X_REAUTHORIZATION_REQUIRED",
    "PINTEREST_PIN_READ_SCOPE_MISSING",
    "CREDENTIAL_DECRYPTION_FAILED",
    "META_API_NOT_CONFIGURED",
  ])("does not retry terminal failure %s", (code) => {
    expect(classifyAnalyticsFailure(code)).toBe("TERMINAL");
  });

  it("fails closed for unknown provider errors", () => {
    expect(classifyAnalyticsFailure("UNCLASSIFIED_PROVIDER_ERROR")).toBe("TERMINAL");
  });
});

describe("getAnalyticsRetryAt", () => {
  const now = new Date("2026-11-08T12:00:00.000Z");

  it("returns a deterministic bounded retry time", () => {
    const input = {attempt: 1, now, dedupeKey: "workspace:account:2026-11-08"};
    expect(getAnalyticsRetryAt(input)).toEqual(getAnalyticsRetryAt(input));
    expect(getAnalyticsRetryAt(input)!.getTime()).toBeGreaterThan(now.getTime() + 5 * 60_000);
    expect(getAnalyticsRetryAt(input)!.getTime()).toBeLessThanOrEqual(now.getTime() + 6 * 60_000);
  });

  it("uses exponential backoff", () => {
    const first = getAnalyticsRetryAt({attempt: 1, now, dedupeKey: "account-a"})!;
    const second = getAnalyticsRetryAt({attempt: 2, now, dedupeKey: "account-a"})!;
    expect(second.getTime() - now.getTime()).toBeGreaterThan(first.getTime() - now.getTime());
  });

  it("returns null after the maximum number of attempts", () => {
    expect(getAnalyticsRetryAt({
      attempt: ANALYTICS_RETRY_MAX_ATTEMPTS,
      now,
      dedupeKey: "account-a",
    })).toBeNull();
  });

  it("rejects invalid retry input", () => {
    expect(() => getAnalyticsRetryAt({attempt: 0, now, dedupeKey: "account-a"})).toThrow(RangeError);
    expect(() => getAnalyticsRetryAt({attempt: 1, now: new Date("invalid"), dedupeKey: "account-a"})).toThrow(RangeError);
    expect(() => getAnalyticsRetryAt({attempt: 1, now, dedupeKey: " "})).toThrow(RangeError);
  });
});
