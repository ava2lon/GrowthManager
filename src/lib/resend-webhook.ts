import {createHmac, timingSafeEqual} from "node:crypto";

export type ResendWebhookHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

export function verifyResendWebhookSignature(
  rawBody: string,
  headers: ResendWebhookHeaders,
  signingSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!/^whsec_[A-Za-z0-9_-]+$/.test(signingSecret)) return false;
  const id = headers.id ?? "";
  const timestamp = headers.timestamp ?? "";
  const signature = headers.signature ?? "";
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(id) || !/^\d{1,12}$/.test(timestamp)) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > 300) return false;
  const encodedSecret = signingSecret.slice("whsec_".length);
  let key: Buffer;
  try { key = Buffer.from(encodedSecret, "base64"); } catch { return false; }
  if (key.length < 16 || key.toString("base64").replace(/=+$/, "") !== encodedSecret.replace(/=+$/, "")) return false;

  const signedContent = id + "." + timestamp + "." + rawBody;
  const expected = createHmac("sha256", key).update(signedContent).digest();
  const candidates = signature.split(" ").filter((part) => part.startsWith("v1,"));
  return candidates.some((candidate) => {
    let supplied: Buffer;
    try { supplied = Buffer.from(candidate.slice(3), "base64"); } catch { return false; }
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}
