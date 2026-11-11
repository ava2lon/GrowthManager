export type AnalyticsRetryDisposition = "RETRY" | "TERMINAL";

const TRANSIENT_CODES = new Set([
  "META_RATE_LIMITED",
  "META_NETWORK_ERROR",
  "META_PROVIDER_UNAVAILABLE",
  "LINKEDIN_RATE_LIMITED",
  "LINKEDIN_PROVIDER_UNAVAILABLE",
  "LINKEDIN_REFRESH_UNAVAILABLE",
  "TIKTOK_ANALYTICS_RATE_LIMITED",
  "TIKTOK_ANALYTICS_NETWORK_ERROR",
  "TIKTOK_ANALYTICS_PROVIDER_UNAVAILABLE",
  "TIKTOK_REFRESH_UNAVAILABLE",
  "YOUTUBE_ANALYTICS_RATE_LIMITED",
  "YOUTUBE_ANALYTICS_NETWORK_ERROR",
  "YOUTUBE_ANALYTICS_PROVIDER_UNAVAILABLE",
  "YOUTUBE_REFRESH_UNAVAILABLE",
  "X_RATE_LIMITED",
  "X_PROVIDER_UNAVAILABLE",
  "X_REFRESH_UNAVAILABLE",
  "PINTEREST_RATE_LIMITED",
  "PINTEREST_PROVIDER_UNAVAILABLE",
  "PINTEREST_REFRESH_UNAVAILABLE",
  "PINTEREST_NETWORK_ERROR",
]);

const TERMINAL_FRAGMENTS = [
  "AUTH_FAILED",
  "REAUTHORIZATION_REQUIRED",
  "PERMISSION_DENIED",
  "PERMISSION_MISSING",
  "SCOPE_MISSING",
  "ACCESS_DENIED",
  "NOT_CONNECTED",
  "NOT_READY",
  "NOT_FOUND",
  "ACCOUNT_ID_MISSING",
  "ORGANIZATION_ACCOUNT_REQUIRED",
  "CREDENTIAL_DECRYPTION_FAILED",
  "TOKEN_MISSING",
  "NOT_CONFIGURED",
];

export const ANALYTICS_RETRY_MAX_ATTEMPTS = 5;
export const ANALYTICS_RETRY_BASE_DELAY_MS = 5 * 60_000;
export const ANALYTICS_RETRY_MAX_DELAY_MS = 6 * 60 * 60_000;

export function classifyAnalyticsFailure(errorCode: string): AnalyticsRetryDisposition {
  if (TRANSIENT_CODES.has(errorCode)) return "RETRY";
  if (TERMINAL_FRAGMENTS.some((fragment) => errorCode.includes(fragment))) return "TERMINAL";
  return "TERMINAL";
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function getAnalyticsRetryAt(input: {
  attempt: number;
  now: Date;
  dedupeKey: string;
}): Date | null {
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new RangeError("Analytics retry attempt must be a positive integer.");
  }
  if (input.attempt >= ANALYTICS_RETRY_MAX_ATTEMPTS) return null;
  if (!Number.isFinite(input.now.getTime())) {
    throw new RangeError("Analytics retry timestamp must be valid.");
  }
  if (!input.dedupeKey.trim()) {
    throw new RangeError("Analytics retry dedupe key is required.");
  }

  const exponential = Math.min(
    ANALYTICS_RETRY_BASE_DELAY_MS * 2 ** (input.attempt - 1),
    ANALYTICS_RETRY_MAX_DELAY_MS,
  );
  // Stable 0–20% jitter spreads retries without making schedules nondeterministic.
  const jitterRatio = (stableHash(input.dedupeKey + ":" + input.attempt) % 2001) / 10_000;
  return new Date(input.now.getTime() + Math.round(exponential * (1 + jitterRatio)));
}
