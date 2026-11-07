import {db} from "@/lib/db";
import {nextAllowedSendAt} from "@/lib/notification-quiet-hours";

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
      select: {quietHoursEnabled: true, timezone: true, quietHoursStart: true, quietHoursEnd: true, digestEnabled: true},
    });
    if (preferences?.digestEnabled) continue;
    if (preferences?.quietHoursEnabled) {
      const nextAllowed = nextAllowedSendAt(
        now,
        preferences.timezone,
        preferences.quietHoursStart,
        preferences.quietHoursEnd,
      );
      if (nextAllowed) {
        const deferred = await db.contentReviewEmailDelivery.updateMany({
          where: {id: item.id, workspaceId: item.workspaceId, status: {in: ["PENDING", "RETRY", "PROCESSING"]}, OR: [{lockedAt: null}, {lockedAt: {lte: staleLock}}]},
          data: {nextAttemptAt: nextAllowed, lockedAt: null},
        });
        if (deferred.count === 1) result.deferred += 1;
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


function digestClock(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return {date: value("year") + "-" + value("month") + "-" + value("day"), weekday: value("weekday"), minute: Number(value("hour")) * 60 + Number(value("minute"))};
}

function digestPeriodKey(date: string, frequency: string): string {
  if (frequency !== "WEEKLY") return "DAILY:" + date;
  const day = new Date(date + "T00:00:00.000Z").getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const monday = new Date(Date.parse(date + "T00:00:00.000Z") - daysSinceMonday * 86_400_000);
  return "WEEKLY:" + monday.toISOString().slice(0, 10);
}

function digestDue(now: Date, timezone: string, frequency: string, sendTime: string): {periodKey: string} | null {
  const clock = digestClock(now, timezone);
  const match = /^(\\d{2}):(\\d{2})$/.exec(sendTime);
  if (!match) return null;
  const targetMinute = Number(match[1]) * 60 + Number(match[2]);
  if (clock.minute < targetMinute) return null;
  if (frequency === "WEEKLY" && clock.weekday !== "Mon") return null;
  return {periodKey: digestPeriodKey(clock.date, frequency)};
}

type DigestEvent = {
  id: string;
  eventType: string;
  assignment: {feedback: string | null; contentPost: {title: string | null}; reviewer: {name: string | null}};
};

export async function dispatchContentReviewEmailDigests(batchSize = 10) {
  const now = new Date();
  const candidates = await db.contentReviewEmailDelivery.findMany({
    where: {status: {in: ["PENDING", "RETRY"]}, nextAttemptAt: {lte: now}, recipientUserId: {not: null}},
    orderBy: {createdAt: "asc"},
    take: Math.max(1, Math.min(batchSize * 20, 200)),
    select: {
      id: true, workspaceId: true, recipientUserId: true, recipientEmail: true, recipientName: true,
      eventType: true,
      assignment: {select: {feedback: true, contentPost: {select: {title: true}}, reviewer: {select: {name: true}}}},
    },
  });
  const groups = new Map<string, typeof candidates>();
  for (const item of candidates) {
    const key = item.workspaceId + ":" + item.recipientUserId;
    groups.set(key, [...(groups.get(key) || []), item]);
  }

  let queued = 0;
  let sent = 0;
  let retried = 0;
  let failed = 0;
  let deferred = 0;

  for (const group of groups.values()) {
    const first = group[0];
    if (!first.recipientUserId) continue;
    const preferences = await db.workspaceNotificationPreference.findUnique({
      where: {workspaceId_userId: {workspaceId: first.workspaceId, userId: first.recipientUserId}},
      select: {digestEnabled: true, digestFrequency: true, digestSendTime: true, timezone: true, quietHoursEnabled: true, quietHoursStart: true, quietHoursEnd: true},
    });
    if (!preferences?.digestEnabled) continue;
    let due: {periodKey: string} | null = null;
    try {
      due = digestDue(now, preferences.timezone, preferences.digestFrequency, preferences.digestSendTime);
    } catch {
      continue;
    }
    if (!due) continue;
    if (preferences.quietHoursEnabled && nextAllowedSendAt(now, preferences.timezone, preferences.quietHoursStart, preferences.quietHoursEnd)) {
      deferred += group.length;
      continue;
    }

    const ids = group.map((item) => item.id).sort();
    const digestKey = first.workspaceId + ":" + first.recipientUserId + ":" + due.periodKey + ":" + ids.join(",");
    const items = group.map((item) => ({
      eventType: item.eventType,
      title: item.assignment.contentPost.title || "Untitled content draft",
      reviewer: item.assignment.reviewer.name || "A workspace reviewer",
      feedback: item.eventType === "CONTENT_CHANGES_REQUESTED" ? item.assignment.feedback || "" : "",
    }));
    const workspace = await db.workspace.findFirst({where: {id: first.workspaceId}, select: {name: true}});
    if (!workspace) continue;
    try {
      await db.$transaction(async (tx) => {
        await tx.contentReviewEmailDigest.create({data: {
          workspaceId: first.workspaceId,
          recipientUserId: first.recipientUserId!,
          recipientEmail: first.recipientEmail,
          recipientName: first.recipientName,
          digestKey,
          periodKey: due!.periodKey,
          deliveryIds: ids,
          items,
        }});
        const moved = await tx.contentReviewEmailDelivery.updateMany({
          where: {workspaceId: first.workspaceId, id: {in: ids}, status: {in: ["PENDING", "RETRY"]}},
          data: {status: "DIGEST_QUEUED"},
        });
        if (moved.count !== ids.length) throw new Error("DIGEST_OUTBOX_CLAIM_CONFLICT");
      });
      queued += ids.length;
    } catch {
      // A duplicate digest key or concurrent claim is safe: the existing ledger owns these events.
      continue;
    }
  }

  const staleLock = new Date(now.getTime() - LOCK_TTL_MS);
  const digests = await db.contentReviewEmailDigest.findMany({
    where: {status: {in: ["PENDING", "RETRY", "PROCESSING"]}, nextAttemptAt: {lte: now}, OR: [{lockedAt: null}, {lockedAt: {lte: staleLock}}]},
    orderBy: {createdAt: "asc"},
    take: Math.max(1, Math.min(batchSize, 25)),
  });

  for (const digest of digests) {
    const claimedAt = new Date();
    const claim = await db.contentReviewEmailDigest.updateMany({
      where: {id: digest.id, status: {in: ["PENDING", "RETRY", "PROCESSING"]}, nextAttemptAt: {lte: claimedAt}, OR: [{lockedAt: null}, {lockedAt: {lte: staleLock}}]},
      data: {status: "PROCESSING", lockedAt: claimedAt, attempts: {increment: 1}},
    });
    if (claim.count !== 1) continue;
    const attempt = digest.attempts + 1;
    try {
      const workspace = await db.workspace.findFirst({where: {id: digest.workspaceId}, select: {name: true}});
      if (!workspace) throw new Error("DIGEST_WORKSPACE_UNAVAILABLE");
      const items = Array.isArray(digest.items) ? digest.items as Array<{eventType: string; title: string; reviewer: string; feedback: string}> : [];
      const lines = items.map((item) => {
        const label = item.eventType === "CONTENT_REVIEW_ASSIGNED" ? "Review assigned" :
          item.eventType === "CONTENT_REVIEW_COMPLETED" ? "Approval recommended" : "Changes requested";
        return label + ": " + item.title + (item.reviewer ? " — " + item.reviewer : "") + (item.feedback ? " — " + item.feedback : "");
      });
      const subject = "[GrowthManager] " + items.length + " review update" + (items.length === 1 ? "" : "s");
      const destination = appUrl() + "/dashboard/ai";
      const htmlItems = items.map((item) => {
        const label = item.eventType === "CONTENT_REVIEW_ASSIGNED" ? "Review assigned" :
          item.eventType === "CONTENT_REVIEW_COMPLETED" ? "Approval recommended" : "Changes requested";
        return "<li><strong>" + escapeHtml(label) + ":</strong> " + escapeHtml(item.title) +
          " — " + escapeHtml(item.reviewer) + (item.feedback ? "<p>" + escapeHtml(item.feedback) + "</p>" : "") + "</li>";
      }).join("");
      const html = "<!doctype html><html lang=\"en\"><body style=\"font-family:Arial,sans-serif;color:#172033\"><main style=\"max-width:600px;margin:auto;padding:24px\"><p>GROWTHMANAGER · " +
        escapeHtml(workspace.name) + "</p><h1>Your review digest</h1><p>" + items.length +
        " review updates are ready.</p><ul>" + htmlItems + "</ul><p><a href=\"" + escapeHtml(destination) +
        "\">Open review workspace</a></p></main></body></html>";
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": "growthmanager-review-digest-" + digest.id},
        body: JSON.stringify({from: process.env.RESEND_FROM_EMAIL, to: [digest.recipientEmail], subject, html, text: [subject, ...lines, "Open review workspace: " + destination].join("\\n\\n")}),
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        const retry = retryable(response.status) && attempt < MAX_ATTEMPTS;
        await db.contentReviewEmailDigest.updateMany({
          where: {id: digest.id, status: "PROCESSING", lockedAt: claimedAt},
          data: {status: retry ? "RETRY" : "FAILED", nextAttemptAt: retry ? new Date(Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** (attempt - 1))) : now, lockedAt: null, lastErrorCode: response.status === 429 ? "RESEND_RATE_LIMITED" : response.status >= 500 ? "RESEND_PROVIDER_ERROR" : "RESEND_REQUEST_REJECTED"},
        });
        if (retry) retried += 1; else failed += 1;
        continue;
      }
      const payload: unknown = await response.json().catch(() => null);
      const providerId = payload && typeof payload === "object" ? (payload as {id?: unknown}).id : null;
      if (typeof providerId !== "string" || !providerId) throw new Error("RESEND_RESPONSE_INVALID");
      await db.$transaction(async (tx) => {
        await tx.contentReviewEmailDigest.updateMany({
          where: {id: digest.id, status: "PROCESSING", lockedAt: claimedAt},
          data: {status: "SENT", providerMessageId: providerId, sentAt: new Date(), lockedAt: null, lastErrorCode: null},
        });
        await tx.contentReviewEmailDelivery.updateMany({
          where: {workspaceId: digest.workspaceId, id: {in: digest.deliveryIds}, status: "DIGEST_QUEUED"},
          data: {status: "SENT", sentAt: new Date(), providerMessageId: providerId},
        });
      });
      sent += 1;
    } catch {
      const retry = attempt < MAX_ATTEMPTS;
      await db.contentReviewEmailDigest.updateMany({
        where: {id: digest.id, status: "PROCESSING", lockedAt: claimedAt},
        data: {status: retry ? "RETRY" : "FAILED", nextAttemptAt: retry ? new Date(Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** (attempt - 1))) : now, lockedAt: null, lastErrorCode: "DIGEST_DELIVERY_ERROR"},
      });
      if (retry) retried += 1; else failed += 1;
    }
  }

  return {queued, sent, retried, failed, deferred};
}
