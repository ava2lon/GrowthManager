import {createHmac, timingSafeEqual} from "node:crypto";

export function createWebhookSignature(secret: string, timestamp: string, rawBody: string): string {
  if (!/^\d{10}$/.test(timestamp)) throw new Error("Invalid webhook signature timestamp.");
  return "v1=" + createHmac("sha256", secret).update(timestamp + "." + rawBody, "utf8").digest("hex");
}

export function verifyWebhookSignature(input: {
  secret: string;
  timestamp: string;
  signature: string;
  rawBody: string;
  now?: Date;
  toleranceSeconds?: number;
}): boolean {
  const now = input.now ?? new Date();
  const tolerance = input.toleranceSeconds ?? 300;
  if (!Number.isInteger(tolerance) || tolerance < 1 || tolerance > 900 || !Number.isFinite(now.getTime())) return false;
  if (!/^\d{10}$/.test(input.timestamp) || !/^v1=[a-f0-9]{64}$/.test(input.signature)) return false;
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(Math.floor(now.getTime() / 1000) - timestampSeconds) > tolerance) return false;
  const expected = Buffer.from(createWebhookSignature(input.secret, input.timestamp, input.rawBody));
  const supplied = Buffer.from(input.signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
