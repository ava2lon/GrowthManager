import {db} from "@/lib/db";

const MAX_ATTEMPTS = 5;
const IDEMPOTENCY_WINDOW_MS = 20 * 60 * 60_000;
const LOCK_TTL_MS = 10 * 60_000;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function appUrl(): string {
  const configured = process.env.AUTH_URL;
  try {
    const url = new URL(configured || "https://growthmanager.vercel.app");
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      return "https://growthmanager.vercel.app";
    }
    return url.origin;
  } catch {
    return "https://growthmanager.vercel.app";
  }
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

type DeliveryResult = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  deferred: number;
};

export async function dispatchContentReviewEmails(batchSize = 10): Promise<DeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || apiKey.length < 10 || !from || from.length > 320) {
    throw new Error("RESEND_CONFIGURATION_MISSING");
  }

  const now = new Date();
  const staleLock = new Date(now.getTime() - LOCK_TTL_MS);
  const candidates = await db.contentReviewEmailDelivery.findMany({
    where: {
      status: {in: ["PENDING", "RETRY", "PROCESSING"]},
      nextAttemptAt: {lte: now},
      OR: [{lockedAt: null}, {lockedAt: {lte: staleLock}}],
    },
    orderBy: {createdAt: "asc"},
    take: Math.max(1, Math.min(batchSize, 25)),
    select: {id: true, workspaceId: true, assignmentId: true, eventType: true, recipientUserId: true, recipientEmail: true, recipientName: true, attempts: true, createdAt: true, assignment: {select: {reviewerUserId: true, assignedById: true}}},
  });

  const result: DeliveryResult = {claimed: 0, sent: 0, retried: 0, failed: 0, deferred: 0};

  for (const item of candidates) {
    const recipientUserId = item.recipientUserId || (item.eventType === "CONTENT_REVIEW_ASSIGNED"
      ? item.assignment.reviewerUserId
      : item.assignment.assignedById);
    const preferences = await db.workspaceNotificationPreference.findUnique({
      where: {workspaceId_userId: {workspaceId: item.workspaceId, userId: recipientUserId}},
      select: {quietHoursEnabled: true, timezone: true, quietHoursStart: true, quietHoursEnd: true},
    });
    if (preferences?.quietHoursEnabled) {
      const {nextAllowedSendAt} = await import("@/lib/notification-quiet-hours");
      const nextAllowed = nextAllowedSendAt(
        now,
        preferences.timezone,
        preferences.quietHoursStart,
        preferences.quietHoursEnd,
      );
      if (nextAllowed) {
        await db.contentReviewEmailDelivery.updateMany({
          where: {id: item.id, workspaceId: item.workspaceId, status: {in: ["PENDING", "RETRY", "PROCESSING"]}, OR: [{lockedAt: null}, {lockedAt: {lte: staleLock}}]},
          data: {nextAttemptAt: nextAllowed, lockedAt: null},
        });
        result.deferred += 1;
        continue;
      }
    }

    if (item.attempts > 0 && item.createdAt.getTime() < Date.now() - IDEMPOTENCY_WINDOW_MS) {
      await db.contentReviewEmailDelivery.updateMany({
        where: {id: item.id, workspaceId: item.workspaceId, status: {in: ["PENDING", "RETRY", "PROCESSING"]}},
        data: {status: "FAILED", lockedAt: null, lastErrorCode: "IDEMPOTENCY_WINDOW_EXPIRED"},
      });
      result.failed += 1;
      continue;
    }

    const claimedAt = new Date();
    const claim = await db.contentReviewEmailDelivery.updateMany({
      where: {
        id: item.id,
        workspaceId: item.workspaceId,
        status: {in: ["PENDING", "RETRY", "PROCESSING"]},
        nextAttemptAt: {lte: claimedAt},
        OR: [{lockedAt: null}, {lockedAt: {lte: staleLock}}],
      },
      data: {status: "PROCESSING", lockedAt: claimedAt, attempts: {increment: 1}},
    });
    if (claim.count !== 1) continue;
    result.claimed += 1;
    const attemptNumber = item.attempts + 1;

    let errorCode: string | null = null;
    let canRetry = false;
    let providerMessageId: string | null = null;
    const startedAt = Date.now();

    try {
      const assignment = await db.contentReviewAssignment.findFirst({
        where: {id: item.assignmentId, workspaceId: item.workspaceId},
        select: {
          status: true,
          feedback: true,
          contentPost: {select: {title: true}},
          workspace: {select: {name: true}},
          reviewer: {select: {name: true}},
        },
      });

      if (!assignment) {
        errorCode = "REVIEW_ASSIGNMENT_UNAVAILABLE";
      } else {
        const workspaceName = assignment.workspace.name;
        const postTitle = assignment.contentPost.title || "Untitled content draft";
        const reviewerName = assignment.reviewer.name || "A workspace reviewer";
        let heading = "";
        let message = "";
        let subject = "";

        if (item.eventType === "CONTENT_REVIEW_ASSIGNED") {
          heading = "Content review assigned";
          message = "You have been assigned to review “" + postTitle + "” in " + workspaceName + ".";
          subject = "[GrowthManager] Content review assigned";
        } else if (item.eventType === "CONTENT_REVIEW_COMPLETED") {
          heading = "Content review completed";
          message = reviewerName + " recommends approval for “" + postTitle + "” in " + workspaceName + ". An administrator still controls final approval.";
          subject = "[GrowthManager] Review recommends approval";
        } else {
          heading = "Changes requested";
          message = reviewerName + " requested changes to “" + postTitle + "” in " + workspaceName + ".";
          subject = "[GrowthManager] Changes requested on a content draft";
        }

        const feedback = item.eventType === "CONTENT_CHANGES_REQUESTED" ? (assignment.feedback || "") : "";
        const destination = appUrl() + "/dashboard/ai";
        const safeMessage = escapeHtml(message);
        const feedbackHtml = feedback
          ? "<h2>Reviewer feedback</h2><p>" + escapeHtml(feedback).replace(/\n/g, "<br>") + "</p>"
          : "";
        const html = [
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>',
          '<body style="margin:0;padding:24px;background:#f6f7f9;font-family:Arial,sans-serif;color:#172033">',
          '<main style="max-width:560px;margin:0 auto;padding:28px;background:#fff;border:1px solid #e5e7eb;border-radius:12px">',
          '<p style="font-size:12px;font-weight:700;letter-spacing:.08em;color:#596579">GROWTHMANAGER</p>',
          "<h1 style=\"font-size:24px\">" + escapeHtml(heading) + "</h1>",
          "<p>" + safeMessage + "</p>",
          feedbackHtml,
          '<p style="margin:28px 0"><a href="' + escapeHtml(destination) + '" style="display:inline-block;padding:12px 18px;background:#172033;color:#fff;text-decoration:none;border-radius:8px">Open review workspace</a></p>',
          '<p style="font-size:12px;color:#667085">This is a transactional workspace notification.</p>',
          "</main></body></html>",
        ].join("");
        const textBody = [heading, message, feedback ? "Reviewer feedback: " + feedback : "", "Open review workspace: " + destination].filter(Boolean).join("\n\n");

        let response: Response | null = null;
        try {
          response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + apiKey,
              "Content-Type": "application/json",
              Accept: "application/json",
              "Idempotency-Key": "growthmanager-content-review-" + item.id,
            },
            body: JSON.stringify({
              from,
              to: [item.recipientEmail],
              subject,
              html,
              text: textBody,
            }),
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(12_000),
          });
        } catch {
          errorCode = "RESEND_NETWORK_ERROR";
          canRetry = true;
        }

        if (response) {
          if (!response.ok) {
            errorCode = response.status === 401 || response.status === 403
              ? "RESEND_AUTH_FAILED"
              : response.status === 408 ? "RESEND_REQUEST_TIMEOUT"
                : response.status === 429 ? "RESEND_RATE_LIMITED"
                  : response.status >= 500 ? "RESEND_PROVIDER_ERROR" : "RESEND_REQUEST_REJECTED";
            canRetry = retryable(response.status);
          } else {
            let payload: unknown = null;
            try { payload = await response.json(); } catch { /* Treat malformed success as ambiguous. */ }
            const id = payload && typeof payload === "object" ? (payload as {id?: unknown}).id : null;
            if (typeof id === "string" && id.length > 0 && id.length <= 200) {
              providerMessageId = id;
            } else {
              errorCode = "RESEND_RESPONSE_INVALID";
              canRetry = true;
            }
          }
        }
      }
    } catch {
      errorCode = "DELIVERY_PROCESSING_ERROR";
      canRetry = true;
    }

    if (providerMessageId) {
      const saved = await db.contentReviewEmailDelivery.updateMany({
        where: {id: item.id, workspaceId: item.workspaceId, status: "PROCESSING", lockedAt: claimedAt},
        data: {status: "SENT", providerMessageId, sentAt: new Date(), lockedAt: null, lastErrorCode: null},
      });
      if (saved.count === 1) result.sent += 1;
      continue;
    }

    const shouldRetry = canRetry && attemptNumber < MAX_ATTEMPTS &&
      item.createdAt.getTime() >= Date.now() - IDEMPOTENCY_WINDOW_MS;
    const delayMs = Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attemptNumber - 1));
    await db.contentReviewEmailDelivery.updateMany({
      where: {id: item.id, workspaceId: item.workspaceId, status: "PROCESSING", lockedAt: claimedAt},
      data: {
        status: shouldRetry ? "RETRY" : "FAILED",
        nextAttemptAt: shouldRetry ? new Date(Date.now() + delayMs) : new Date(),
        lockedAt: null,
        lastErrorCode: errorCode || "DELIVERY_FAILED",
      },
    });
    if (shouldRetry) result.retried += 1;
    else result.failed += 1;
    void startedAt;
  }

  return result;
}
