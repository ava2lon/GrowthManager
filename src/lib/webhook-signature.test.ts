import {describe, expect, it} from "vitest";
import {createWebhookSignature, verifyWebhookSignature} from "@/lib/webhook-signature";

describe("webhook HMAC signatures", () => {
  const secret = "whsec_" + "a".repeat(43);
  const now = new Date("2026-11-18T14:00:00.000Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const rawBody = JSON.stringify({id: "evt_12345678", type: "social.incident.created"});

  it("signs and verifies the exact raw body within the replay window", () => {
    const signature = createWebhookSignature(secret, timestamp, rawBody);
    expect(verifyWebhookSignature({secret, timestamp, signature, rawBody, now})).toBe(true);
  });

  it("rejects modified payloads and signatures", () => {
    const signature = createWebhookSignature(secret, timestamp, rawBody);
    expect(verifyWebhookSignature({secret, timestamp, signature, rawBody: rawBody + " ", now})).toBe(false);
    expect(verifyWebhookSignature({secret, timestamp, signature: "v1=" + "0".repeat(64), rawBody, now})).toBe(false);
  });

  it("rejects stale and future timestamps outside the tolerance", () => {
    const stale = String(Number(timestamp) - 301);
    const future = String(Number(timestamp) + 301);
    expect(verifyWebhookSignature({secret, timestamp: stale, signature: createWebhookSignature(secret, stale, rawBody), rawBody, now})).toBe(false);
    expect(verifyWebhookSignature({secret, timestamp: future, signature: createWebhookSignature(secret, future, rawBody), rawBody, now})).toBe(false);
  });

  it("rejects malformed timestamps and invalid tolerance", () => {
    expect(verifyWebhookSignature({secret, timestamp: "bad", signature: "bad", rawBody, now})).toBe(false);
    expect(verifyWebhookSignature({secret, timestamp, signature: createWebhookSignature(secret, timestamp, rawBody), rawBody, now, toleranceSeconds: 0})).toBe(false);
  });
});
