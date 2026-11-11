import {db} from "@/lib/db";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";

type AlertInput = {
  workspaceId: string;
  integrationId: string;
  provider: string;
  alertType: string;
  severity: string;
  dedupeKey: string;
  message: string;
  observedCount: number;
  observedRate: number;
  sampleSize: number;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

/**
 * Creates an alert once per workspace dedupe key and atomically enqueues
 * one email only for newly-created events with explicit workspace opt-in.
 */
export async function recordAutomationAlert(input: AlertInput): Promise<{created: boolean; queued: boolean}> {
  return db.$transaction(async (tx) => {
    const inserted = await tx.automationAlertEvent.createMany({
      data: [{
        workspaceId: input.workspaceId,
        integrationId: input.integrationId,
        provider: input.provider,
        alertType: input.alertType,
        severity: input.severity,
        dedupeKey: input.dedupeKey,
        message: input.message,
        observedCount: input.observedCount,
        observedRate: input.observedRate,
        sampleSize: input.sampleSize,
      }],
      skipDuplicates: true,
    });

    const event = await tx.automationAlertEvent.findUnique({
      where: {workspaceId_dedupeKey: {workspaceId: input.workspaceId, dedupeKey: input.dedupeKey}},
      select: {id: true},
    });
    if (!event || inserted.count !== 1) return {created: false, queued: false};

    const policy = await tx.automationAlertPolicy.findUnique({
      where: {workspaceId: input.workspaceId},
      select: {emailNotificationsEnabled: true, notificationEmail: true},
    });
    if (!policy?.emailNotificationsEnabled || !policy.notificationEmail) {
      return {created: true, queued: false};
    }

    const resend = await tx.integration.findFirst({
      where: {workspaceId: input.workspaceId, provider: "resend", status: "CONNECTED", credentialsEncrypted: {not: null}},
      select: {id: true},
    });
    if (!resend) return {created: true, queued: false};

    await tx.automationAlertDelivery.create({
      data: {
        workspaceId: input.workspaceId,
        alertEventId: event.id,
        integrationId: resend.id,
        channel: "EMAIL",
        recipient: policy.notificationEmail,
      },
    });
    return {created: true, queued: true};
  });
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Claims a bounded batch from the database outbox. The deterministic Resend
 * idempotency key makes an ambiguous network retry safe within Resend's
 * idempotency retention window.
 */
/**
 * Escalates unresolved, already-notified incidents to active workspace owners
 * and admins after 30 minutes. The delivery unique key makes this one-time per
 * event/recipient even when the cron runs repeatedly.
 */
export async function enqueueAutomationAlertEscalations(): Promise<{eventsChecked: number; deliveriesQueued: number}> {
  const POLICY_BATCH_SIZE = 5;
  const EVENT_BATCH_SIZE = 10;
  const RECIPIENT_BATCH_SIZE = 50;
  const cutoff = new Date(Date.now() - 30 * 60_000);
  const policies = await db.automationAlertPolicy.findMany({
    where: {enabled: true, emailNotificationsEnabled: true},
    select: {workspaceId: true},
    orderBy: [
      {lastEscalationAt: {sort: "asc", nulls: "first"}},
      {createdAt: "asc"},
      {workspaceId: "asc"},
    ],
    take: POLICY_BATCH_SIZE,
  });

  let eventsChecked = 0;
  let deliveriesQueued = 0;

  for (const policy of policies) {
    // Advance the independent escalation scheduler cursor so busy workspaces
    // cannot permanently occupy the first page of policies.
    await db.automationAlertPolicy.updateMany({
      where: {workspaceId: policy.workspaceId, enabled: true, emailNotificationsEnabled: true},
      data: {lastEscalationAt: new Date()},
    });

    const events = await db.automationAlertEvent.findMany({
      where: {
        workspaceId: policy.workspaceId,
        status: "OPEN",
        lastNotifiedAt: {lte: cutoff},
        escalatedAt: null,
      },
      select: {id: true, escalationRecipientCursor: true},
      orderBy: [{createdAt: "asc"}, {id: "asc"}],
      take: EVENT_BATCH_SIZE,
    });
    if (!events.length) continue;
    eventsChecked += events.length;

    const resend = await db.integration.findFirst({
      where: {
        workspaceId: policy.workspaceId,
        provider: "resend",
        status: "CONNECTED",
        credentialsEncrypted: {not: null},
      },
      select: {id: true},
    });
    if (!resend) continue;

    for (const event of events) {
      const memberships = await db.workspaceMembership.findMany({
        where: {
          workspaceId: policy.workspaceId,
          role: {in: ["OWNER", "ADMIN"]},
          ...(event.escalationRecipientCursor ? {id: {gt: event.escalationRecipientCursor}} : {}),
        },
        select: {id: true, user: {select: {email: true}}},
        orderBy: {id: "asc"},
        take: RECIPIENT_BATCH_SIZE + 1,
      });
      const hasMoreRecipients = memberships.length > RECIPIENT_BATCH_SIZE;
      const recipientPage = memberships.slice(0, RECIPIENT_BATCH_SIZE);
      const nextCursor = hasMoreRecipients ? recipientPage[recipientPage.length - 1]?.id ?? event.escalationRecipientCursor : null;
      const uniqueRecipients = [...new Set(
        recipientPage
          .map((membership) => membership.user.email.trim().toLowerCase())
          .filter(Boolean),
      )];

      const result = await db.$transaction(async (tx) => {
        // Compare-and-set the page cursor before inserting. This prevents
        // overlapping cron invocations from advancing the same event twice.
        const advanced = await tx.automationAlertEvent.updateMany({
          where: {
            workspaceId: policy.workspaceId,
            id: event.id,
            status: "OPEN",
            escalatedAt: null,
            escalationRecipientCursor: event.escalationRecipientCursor,
          },
          data: {
            escalationRecipientCursor: nextCursor,
            escalatedAt: hasMoreRecipients ? null : new Date(),
          },
        });
        if (advanced.count !== 1) return 0;

        const inserted = uniqueRecipients.length
          ? await tx.automationAlertDelivery.createMany({
            data: uniqueRecipients.map((recipient) => ({
              workspaceId: policy.workspaceId,
              alertEventId: event.id,
              integrationId: resend.id,
              channel: "EMAIL",
              recipient,
            })),
            skipDuplicates: true,
          })
          : {count: 0};

        if (inserted.count) {
          await tx.activityLog.create({
            data: {
              workspaceId: policy.workspaceId,
              action: "automation.alert_escalated",
              entityType: "automation_alert",
              entityId: event.id,
              metadata: {
                recipientCount: inserted.count,
                escalationAfterMinutes: 30,
                recipientBatchSize: recipientPage.length,
                moreRecipientsPending: hasMoreRecipients,
              },
            },
          });
        }
        return inserted.count;
      });
      deliveriesQueued += result;
    }
  }

  return {eventsChecked, deliveriesQueued};
}

/**
 * Resolves stale incidents only after a successful provider evaluation.
 * Unsent notifications are cancelled to avoid sending recovered alerts.
 */
export async function resolveAutomationAlerts(input: {
  workspaceId: string;
  integrationId: string;
  activeAlertTypes: string[];
}): Promise<{resolved: number; cancelledDeliveries: number}> {
  return db.$transaction(async (tx) => {
    const candidates = await tx.automationAlertEvent.findMany({
      where: {
        workspaceId: input.workspaceId,
        integrationId: input.integrationId,
        status: {in: ["OPEN", "ACKNOWLEDGED"]},
        ...(input.activeAlertTypes.length ? {alertType: {notIn: input.activeAlertTypes}} : {}),
      },
      select: {id: true},
    });
    if (!candidates.length) return {resolved: 0, cancelledDeliveries: 0};
    const ids = candidates.map((event) => event.id);
    const now = new Date();
    const updated = await tx.automationAlertEvent.updateMany({
      where: {workspaceId: input.workspaceId, id: {in: ids}, status: {in: ["OPEN", "ACKNOWLEDGED"]}},
      data: {status: "RESOLVED", resolvedAt: now, resolutionMessage: "The latest successful n8n evaluation no longer meets this alert threshold."},
    });
    const cancelled = await tx.automationAlertDelivery.updateMany({
      where: {workspaceId: input.workspaceId, alertEventId: {in: ids}, status: {in: ["PENDING", "RETRY"]}},
      data: {status: "CANCELLED", lockedAt: null, lastErrorCode: "INCIDENT_RESOLVED"},
    });
    if (updated.count) {
      await tx.activityLog.create({
        data: {
          workspaceId: input.workspaceId,
          action: "automation.alerts_auto_resolved",
          entityType: "automation_alert",
          metadata: {resolvedCount: updated.count, cancelledDeliveries: cancelled.count},
        },
      });
    }
    return {resolved: updated.count, cancelledDeliveries: cancelled.count};
  });
}

export async function dispatchAutomationAlertEmails(limit = 20): Promise<{
  claimed: number; sent: number; retried: number; failed: number;
}> {
  const now = new Date();
  const staleLock = new Date(now.getTime() - 10 * 60_000);
  const pending = await db.automationAlertDelivery.findMany({
    where: {
      status: {in: ["PENDING", "RETRY", "PROCESSING"]},
      nextAttemptAt: {lte: now},
      OR: [{lockedAt: null}, {lockedAt: {lte: staleLock}}],
    },
    orderBy: {createdAt: "asc"},
    take: Math.max(1, Math.min(limit, 50)),
    select: {id: true, workspaceId: true, integrationId: true, alertEventId: true, recipient: true, attempts: true, createdAt: true},
  });

  let claimed = 0;
  let sent = 0;
  let retried = 0;
  let failed = 0;

  for (const delivery of pending) {
    if (delivery.attempts > 0 && delivery.createdAt.getTime() < now.getTime() - 20 * 60 * 60_000) {
      await db.automationAlertDelivery.updateMany({
        where: {id: delivery.id, status: {in: ["PENDING", "RETRY", "PROCESSING"]}},
        data: {status: "FAILED", lockedAt: null, lastErrorCode: "IDEMPOTENCY_WINDOW_EXPIRED"},
      });
      failed += 1;
      continue;
    }
    const claimedAt = new Date();
    const claim = await db.automationAlertDelivery.updateMany({
      where: {
        id: delivery.id,
        status: {in: ["PENDING", "RETRY", "PROCESSING"]},
        nextAttemptAt: {lte: claimedAt},
        OR: [{lockedAt: null}, {lockedAt: {lte: staleLock}}],
      },
      data: {status: "PROCESSING", lockedAt: claimedAt, attempts: {increment: 1}},
    });
    if (claim.count !== 1) continue;
    claimed += 1;
    const attempt = delivery.attempts + 1;
    const attemptHistory = await db.automationAlertDeliveryAttempt.aggregate({
      where: {workspaceId: delivery.workspaceId, deliveryId: delivery.id},
      _max: {attemptNumber: true},
    });
    const attemptNumber = (attemptHistory._max.attemptNumber ?? 0) + 1;

    let failureCode: string | null = null;
    let retryable = false;
    let messageId: string | null = null;
    let attemptRecordId: string | null = null;
    const attemptStartedAt = new Date();
    let attemptHttpStatus: number | null = null;
    try {
      const [integration, event] = await Promise.all([
        db.integration.findFirst({
          where: {id: delivery.integrationId, workspaceId: delivery.workspaceId, provider: "resend", status: "CONNECTED"},
          select: {credentialsEncrypted: true},
        }),
        db.automationAlertEvent.findFirst({
          where: {id: delivery.alertEventId, workspaceId: delivery.workspaceId},
          select: {
            severity: true, alertType: true, message: true, observedCount: true,
            observedRate: true, sampleSize: true, createdAt: true,
            workspace: {select: {name: true}},
          },
        }),
      ]);

      if (!integration?.credentialsEncrypted || !event) {
        failureCode = "INTEGRATION_OR_EVENT_UNAVAILABLE";
      } else {
        const credentials = decryptIntegrationCredentials(
          integration.credentialsEncrypted, delivery.workspaceId, delivery.integrationId,
        );
        if (typeof credentials.apiKey !== "string" || typeof credentials.fromEmail !== "string") {
          failureCode = "RESEND_CREDENTIALS_INCOMPLETE";
        } else {
          const html = [
            "<h1>GrowthManager automation alert</h1>",
            "<p>A configured automation threshold was reached in workspace <strong>" + escapeHtml(event.workspace.name) + "</strong>.</p>",
            "<p><strong>Severity:</strong> " + escapeHtml(event.severity) + "</p>",
            "<p><strong>Alert:</strong> " + escapeHtml(event.alertType.replaceAll("_", " ")) + "</p>",
            "<p>" + escapeHtml(event.message) + "</p>",
            "<ul><li>Failed executions: " + event.observedCount + "</li><li>Failure rate: " + event.observedRate.toFixed(1) + "%</li><li>Sample size: " + event.sampleSize + "</li></ul>",
            "<p>Review the Automation Health page in GrowthManager for details.</p>",
          ].join("");
          let response: Response;
          attemptRecordId = (await db.automationAlertDeliveryAttempt.create({
            data: {workspaceId: delivery.workspaceId, deliveryId: delivery.id, attemptNumber, status: "STARTED"},
            select: {id: true},
          })).id;
          try {
            response = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                Authorization: "Bearer " + credentials.apiKey,
                "Content-Type": "application/json",
                Accept: "application/json",
                "Idempotency-Key": "growthmanager-alert-" + delivery.id,
              },
              body: JSON.stringify({
                from: credentials.fromEmail,
                to: [delivery.recipient],
                subject: "[GrowthManager] " + event.severity + " automation alert",
                html,
              }),
              cache: "no-store",
              redirect: "error",
              signal: AbortSignal.timeout(10_000),
            });
          } catch {
            failureCode = "NETWORK_ERROR";
            retryable = true;
            response = null as unknown as Response;
          }

          if (response) {
            attemptHttpStatus = response.status;
            if (!response.ok) {
              failureCode = response.status === 401 || response.status === 403
                ? "RESEND_AUTH_FAILED"
                : response.status === 408 ? "RESEND_REQUEST_TIMEOUT"
                  : response.status === 429 ? "RESEND_RATE_LIMITED"
                    : response.status >= 500 ? "RESEND_PROVIDER_ERROR" : "RESEND_REQUEST_REJECTED";
              retryable = isRetryable(response.status);
            } else {
              let payload: unknown;
              try { payload = await response.json(); } catch { payload = null; }
              const id = payload && typeof payload === "object" ? (payload as {id?: unknown}).id : null;
              if (typeof id !== "string" || id.length > 200) {
                failureCode = "RESEND_RESPONSE_INVALID";
                retryable = true;
              } else {
                messageId = id;
              }
            }
          }
        }
      }
    } catch {
      failureCode = "DELIVERY_PROCESSING_ERROR";
      retryable = true;
    }

    const attemptOutcome = messageId ? "SENT" : retryable && attempt < 3 ? "RETRY" : "FAILED";
    if (attemptRecordId) {
      await db.automationAlertDeliveryAttempt.updateMany({
        where: {id: attemptRecordId, workspaceId: delivery.workspaceId, deliveryId: delivery.id},
        data: {status: attemptOutcome, providerMessageId: messageId, errorCode: failureCode, httpStatus: attemptHttpStatus, finishedAt: new Date(), durationMs: Math.max(0, Date.now() - attemptStartedAt.getTime())},
      });
    }

    if (messageId) {
      await db.automationAlertDelivery.updateMany({
        where: {id: delivery.id, status: "PROCESSING", lockedAt: claimedAt},
        data: {status: "SENT", providerMessageId: messageId, sentAt: new Date(), lockedAt: null, lastErrorCode: null},
      });
      await db.automationAlertEvent.updateMany({
        where: {id: delivery.alertEventId, workspaceId: delivery.workspaceId},
        data: {lastNotifiedAt: new Date()},
      });
      sent += 1;
      continue;
    }

    const canRetry = retryable && attempt < 3;
    const retryAt = new Date(Date.now() + Math.min(24 * 60 * 60_000, 60_000 * 2 ** attempt));
    await db.automationAlertDelivery.updateMany({
      where: {id: delivery.id, status: "PROCESSING", lockedAt: claimedAt},
      data: {
        status: canRetry ? "RETRY" : "FAILED",
        nextAttemptAt: canRetry ? retryAt : new Date(),
        lockedAt: null,
        lastErrorCode: failureCode ?? "DELIVERY_FAILED",
      },
    });
    if (canRetry) retried += 1;
    else failed += 1;
  }

  return {claimed, sent, retried, failed};
}
