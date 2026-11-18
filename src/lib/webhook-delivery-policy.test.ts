import {describe, expect, it} from "vitest";
import {
  WEBHOOK_DELIVERY_MAX_ATTEMPTS,
  classifyWebhookResponse,
  getWebhookRetryAt,
} from "@/lib/webhook-delivery-policy";

describe("webhook delivery retry policy", () => {
  const now = new Date("2026-11-18T12:00:00.000Z");

  it("uses deterministic exponential backoff with bounded jitter", () => {
    const input = {attempt: 1, now, deliveryId: "delivery-12345678"};
    const first = getWebhookRetryAt(input)!;
    expect(first).toEqual(getWebhookRetryAt(input));
    expect(first.getTime()).toBeGreaterThanOrEqual(now.getTime() + 60_000);
    expect(first.getTime()).toBeLessThanOrEqual(now.getTime() + 72_000);
    const second = getWebhookRetryAt({...input, attempt: 2})!;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  it("stops after the configured maximum attempts", () => {
    expect(getWebhookRetryAt({attempt: WEBHOOK_DELIVERY_MAX_ATTEMPTS, now, deliveryId: "delivery-12345678"})).toBeNull();
  });

  it("rejects invalid retry input", () => {
    expect(() => getWebhookRetryAt({attempt: 0, now, deliveryId: "x"})).toThrow(RangeError);
    expect(() => getWebhookRetryAt({attempt: 1, now: new Date("invalid"), deliveryId: "x"})).toThrow(RangeError);
    expect(() => getWebhookRetryAt({attempt: 1, now, deliveryId: " "})).toThrow(RangeError);
  });

  it.each([200, 201, 204])("accepts successful HTTP status %s", (status) => {
    expect(classifyWebhookResponse(status)).toBe("DELIVERED");
  });

  it.each([408, 425, 429, 500, 502, 503])("retries transient HTTP status %s", (status) => {
    expect(classifyWebhookResponse(status)).toBe("RETRY");
  });

  it.each([301, 400, 401, 403, 404, 422])("does not retry permanent HTTP status %s", (status) => {
    expect(classifyWebhookResponse(status)).toBe("TERMINAL");
  });
});
