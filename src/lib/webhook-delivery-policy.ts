export const WEBHOOK_DELIVERY_MAX_ATTEMPTS = 8;
export const WEBHOOK_DELIVERY_BASE_DELAY_MS = 60_000;
export const WEBHOOK_DELIVERY_MAX_DELAY_MS = 6 * 60 * 60_000;
export const WEBHOOK_DELIVERY_LOCK_TTL_MS = 2 * 60_000;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function getWebhookRetryAt(input: {attempt: number; now: Date; deliveryId: string}): Date | null {
  if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new RangeError("Webhook attempt must be a positive integer.");
  if (!Number.isFinite(input.now.getTime())) throw new RangeError("Webhook retry timestamp must be valid.");
  if (!input.deliveryId.trim()) throw new RangeError("Webhook delivery identifier is required.");
  if (input.attempt >= WEBHOOK_DELIVERY_MAX_ATTEMPTS) return null;
  const delay = Math.min(WEBHOOK_DELIVERY_BASE_DELAY_MS * 2 ** (input.attempt - 1), WEBHOOK_DELIVERY_MAX_DELAY_MS);
  const jitter = (stableHash(input.deliveryId + ":" + input.attempt) % 2001) / 10_000;
  return new Date(input.now.getTime() + Math.round(delay * (1 + jitter)));
}

export function classifyWebhookResponse(status: number): "RETRY" | "TERMINAL" | "DELIVERED" {
  if (!Number.isInteger(status) || status < 100 || status > 599) return "TERMINAL";
  if (status >= 200 && status < 300) return "DELIVERED";
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "RETRY";
  return "TERMINAL";
}
