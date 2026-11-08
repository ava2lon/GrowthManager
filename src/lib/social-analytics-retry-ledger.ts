import {db} from "@/lib/db";
import {
  ANALYTICS_RETRY_MAX_ATTEMPTS,
  classifyAnalyticsFailure,
  getAnalyticsRetryAt,
} from "@/lib/social-analytics-retry-policy";

const LEASE_MS = 2 * 60_000;

export type SocialAnalyticsRetryIdentity = {
  workspaceId: string;
  provider: string;
  subjectType: string;
  subjectId: string;
  reportDate: Date;
};

function uniqueWhere(input: SocialAnalyticsRetryIdentity) {
  return {
    workspaceId_provider_subjectType_subjectId_reportDate: {
      workspaceId: input.workspaceId,
      provider: input.provider,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      reportDate: input.reportDate,
    },
  };
}

/**
 * Records a failed collection without exposing provider response bodies or credentials.
 * Unknown provider errors fail closed and become terminal until explicitly classified.
 */
export async function recordSocialAnalyticsRetryFailure(
  input: SocialAnalyticsRetryIdentity & { errorCode: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const errorCode = /^[A-Z0-9_]{1,100}$/.test(input.errorCode)
    ? input.errorCode
    : "ANALYTICS_COLLECTION_FAILED";

  return db.$transaction(async (tx) => {
    const existing = await tx.socialAnalyticsRetry.findUnique({
      where: uniqueWhere(input),
      select: { id: true, attemptCount: true },
    });
    const attemptCount = (existing?.attemptCount ?? 0) + 1;
    const retryAt =
      classifyAnalyticsFailure(errorCode) === "RETRY"
        ? getAnalyticsRetryAt({
            attempt: attemptCount,
            now,
            dedupeKey: [
              input.workspaceId,
              input.provider,
              input.subjectType,
              input.subjectId,
              input.reportDate.toISOString().slice(0, 10),
            ].join(":"),
          })
        : null;
    const exhausted = retryAt === null;
    const data = {
      status: exhausted ? "FAILED" : "RETRY",
      attemptCount,
      nextAttemptAt: retryAt ?? now,
      lockedAt: null,
      lastErrorCode: errorCode,
      completedAt: exhausted ? now : null,
    };

    return tx.socialAnalyticsRetry.upsert({
      where: uniqueWhere(input),
      create: {
        ...input,
        ...data,
      },
      update: data,
    });
  });
}

/**
 * Compare-and-set claim. Concurrent workers may select the same candidate, but
 * only one updateMany can transition its eligible row into PROCESSING.
 */
export async function claimDueSocialAnalyticsRetry(now = new Date()) {
  const staleBefore = new Date(now.getTime() - LEASE_MS);
  const candidate = await db.socialAnalyticsRetry.findFirst({
    where: {
      status: "RETRY",
      nextAttemptAt: { lte: now },
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    select: { id: true, lockedAt: true },
  });
  if (!candidate) return null;

  const claimed = await db.socialAnalyticsRetry.updateMany({
    where: {
      id: candidate.id,
      status: "RETRY",
      nextAttemptAt: { lte: now },
      lockedAt: candidate.lockedAt,
    },
    data: { status: "PROCESSING", lockedAt: now },
  });
  if (claimed.count !== 1) return null;

  return db.socialAnalyticsRetry.findFirst({
    where: { id: candidate.id, status: "PROCESSING", lockedAt: now },
  });
}

export async function completeSocialAnalyticsRetry(id: string, lockedAt: Date) {
  const result = await db.socialAnalyticsRetry.updateMany({
    where: { id, status: "PROCESSING", lockedAt },
    data: { status: "COMPLETED", completedAt: new Date(), lockedAt: null, lastErrorCode: null },
  });
  return result.count === 1;
}

export async function failClaimedSocialAnalyticsRetry(input: {
  id: string;
  lockedAt: Date;
  workspaceId: string;
  provider: string;
  subjectType: string;
  subjectId: string;
  reportDate: Date;
  errorCode: string;
  now?: Date;
}) {
  const released = await db.socialAnalyticsRetry.updateMany({
    where: { id: input.id, status: "PROCESSING", lockedAt: input.lockedAt },
    data: { status: "RETRY", lockedAt: null },
  });
  if (released.count !== 1) return false;

  await recordSocialAnalyticsRetryFailure(input);
  return true;
}

export const SOCIAL_ANALYTICS_RETRY_LEASE_MS = LEASE_MS;
export const SOCIAL_ANALYTICS_RETRY_ATTEMPT_LIMIT = ANALYTICS_RETRY_MAX_ATTEMPTS;
