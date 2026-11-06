"use server";

import {revalidatePath} from "next/cache";
import {db} from "@/lib/db";
import {requireWorkspaceRole} from "@/lib/workspace";
import {consumeRateLimit} from "@/lib/rate-limit";
import {decryptIntegrationCredentials} from "@/lib/integration-crypto";
import {listN8nExecutions} from "@/lib/n8n-client";
import {dispatchAutomationAlertEmails, recordAutomationAlert} from "@/lib/automation-alert-notifications";

function boundedInteger(value: FormDataEntryValue | null, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export async function saveAutomationAlertPolicy(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const enabled = formData.get("enabled") === "on";
  const emailNotificationsEnabled = formData.get("emailNotificationsEnabled") === "on";
  const notificationEmail = String(formData.get("notificationEmail") ?? "").trim().toLowerCase();
  if (emailNotificationsEnabled && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notificationEmail) || notificationEmail.length > 254)) {
    throw new Error("Enter a valid notification email address before enabling email alerts.");
  }
  if (emailNotificationsEnabled) {
    const resend = await db.integration.findFirst({
      where: {workspaceId: context.workspace.id, provider: "resend", status: "CONNECTED", credentialsEncrypted: {not: null}},
      select: {id: true, credentialsEncrypted: true},
    });
    if (!resend?.credentialsEncrypted) throw new Error("Connect Resend before enabling email notifications.");
    const credentials = decryptIntegrationCredentials(resend.credentialsEncrypted, context.workspace.id, resend.id);
    if (typeof credentials.apiKey !== "string" || typeof credentials.fromEmail !== "string") {
      throw new Error("Reconnect Resend and configure a verified sender email before enabling notifications.");
    }
  }
  const failureCountThreshold = boundedInteger(formData.get("failureCountThreshold"), 1, 100, 3);
  const failureRateThreshold = Number(formData.get("failureRateThreshold"));
  const lookbackMinutes = boundedInteger(formData.get("lookbackMinutes"), 15, 10080, 1440);
  const cooldownMinutes = boundedInteger(formData.get("cooldownMinutes"), 15, 10080, 60);
  if (!Number.isFinite(failureRateThreshold) || failureRateThreshold < 1 || failureRateThreshold > 100) {
    throw new Error("Failure-rate threshold must be between 1 and 100.");
  }
  await db.$transaction(async (tx) => {
    await tx.automationAlertPolicy.upsert({
      where: {workspaceId: context.workspace.id},
      create: {workspaceId: context.workspace.id, enabled, failureCountThreshold, failureRateThreshold, lookbackMinutes, cooldownMinutes, emailNotificationsEnabled, notificationEmail: emailNotificationsEnabled ? notificationEmail : null},
      update: {enabled, failureCountThreshold, failureRateThreshold, lookbackMinutes, cooldownMinutes, emailNotificationsEnabled, notificationEmail: emailNotificationsEnabled ? notificationEmail : null},
    });
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "automation.alert_policy_updated",
        entityType: "automation_alert_policy",
        metadata: {enabled, failureCountThreshold, failureRateThreshold, lookbackMinutes, cooldownMinutes, emailNotificationsEnabled, notificationEmail: emailNotificationsEnabled ? notificationEmail : null},
      },
    });
  });
  revalidatePath("/dashboard/automations");
}

export async function evaluateAutomationAlerts() {
  const context = await requireWorkspaceRole("ADMIN");
  const limit = await consumeRateLimit("automation-alert-evaluate:" + context.workspace.id + ":" + context.userId, 6, 3600);
  if (!limit.allowed || (process.env.NODE_ENV === "production" && !limit.configured)) {
    throw new Error("Alert evaluation limit reached or request protection is unavailable.");
  }
  const [policy, integration] = await Promise.all([
    db.automationAlertPolicy.findUnique({where: {workspaceId: context.workspace.id}}),
    db.integration.findFirst({
      where: {workspaceId: context.workspace.id, provider: "n8n", status: "CONNECTED"},
      select: {id: true, credentialsEncrypted: true},
    }),
  ]);
  if (!policy || !policy.enabled) throw new Error("Enable and save the alert policy before evaluating alerts.");
  if (!integration?.credentialsEncrypted) throw new Error("Connect n8n before evaluating automation alerts.");

  let credentials: Record<string, unknown>;
  try {
    credentials = decryptIntegrationCredentials(integration.credentialsEncrypted, context.workspace.id, integration.id);
  } catch {
    throw new Error("Could not decrypt n8n credentials. Check the integration encryption configuration.");
  }
  if (typeof credentials.baseUrl !== "string" || typeof credentials.apiKey !== "string") {
    throw new Error("Saved n8n credentials are incomplete. Reconnect the integration.");
  }

  const executions = await listN8nExecutions(credentials.baseUrl, credentials.apiKey);
  const cutoff = Date.now() - policy.lookbackMinutes * 60_000;
  const recent = executions.executions.filter((item) => {
    if (!item.startedAt) return false;
    const startedAt = Date.parse(item.startedAt);
    return Number.isFinite(startedAt) && startedAt >= cutoff && startedAt <= Date.now();
  });
  const failed = recent.filter((item) => item.status === "error" || item.status === "crashed");
  const failureRate = recent.length ? failed.length / recent.length * 100 : 0;
  const triggers = [
    ...(failed.length >= policy.failureCountThreshold ? ["FAILURE_COUNT"] : []),
    ...(recent.length > 0 && failureRate >= policy.failureRateThreshold ? ["FAILURE_RATE"] : []),
  ];
  const now = new Date();
  const cooldownBucket = Math.floor(now.getTime() / (policy.cooldownMinutes * 60_000));
  for (const alertType of triggers) {
    const dedupeKey = [integration.id, alertType, cooldownBucket].join(":");
    const message = alertType === "FAILURE_COUNT"
      ? `${failed.length} failed executions in the last ${policy.lookbackMinutes} minutes (threshold: ${policy.failureCountThreshold}).`
      : `Execution failure rate is ${failureRate.toFixed(1)}% over ${recent.length} sampled executions (threshold: ${policy.failureRateThreshold}%).`;
    await recordAutomationAlert({
      workspaceId: context.workspace.id,
      integrationId: integration.id,
      provider: "n8n",
      alertType,
      severity: failed.length >= policy.failureCountThreshold * 2 ? "CRITICAL" : "WARNING",
      dedupeKey,
      message,
      observedCount: failed.length,
      observedRate: failureRate,
      sampleSize: recent.length,
    });
  }
  await dispatchAutomationAlertEmails(5);
  await db.activityLog.create({
    data: {
      workspaceId: context.workspace.id,
      userId: context.userId,
      action: "automation.alerts_evaluated",
      entityType: "automation_alert_policy",
      metadata: {lookbackMinutes: policy.lookbackMinutes, sampleSize: recent.length, failures: failed.length, failureRate, alertsTriggered: triggers.length},
    },
  });
  revalidatePath("/dashboard/automations");
}

export async function acknowledgeAutomationAlert(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const alertId = String(formData.get("alertId") ?? "");
  if (!alertId || alertId.length > 128) throw new Error("Invalid alert.");
  await db.$transaction(async (tx) => {
    const changed = await tx.automationAlertEvent.updateMany({
      where: {id: alertId, workspaceId: context.workspace.id, status: "OPEN"},
      data: {status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedById: context.userId},
    });
    if (changed.count !== 1) throw new Error("Alert is unavailable or has already been acknowledged.");
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "automation.alert_acknowledged",
        entityType: "automation_alert",
        entityId: alertId,
      },
    });
  });
  revalidatePath("/dashboard/automations");
}

/**
 * Explicitly requeues only transiently failed email deliveries. The original
 * delivery ID is retained so the provider idempotency key remains stable.
 */
export async function retryAutomationAlertDelivery(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const deliveryId = String(formData.get("deliveryId") ?? "");
  if (!deliveryId || deliveryId.length > 128) throw new Error("Invalid delivery.");

  const limit = await consumeRateLimit(
    "automation-alert-retry:" + context.workspace.id + ":" + context.userId,
    10,
    3600,
  );
  if (!limit.allowed || (process.env.NODE_ENV === "production" && !limit.configured)) {
    throw new Error("Retry limit reached or request protection is unavailable.");
  }

  const retryableCodes = [
    "NETWORK_ERROR",
    "RESEND_REQUEST_TIMEOUT",
    "RESEND_RATE_LIMITED",
    "RESEND_PROVIDER_ERROR",
    "RESEND_RESPONSE_INVALID",
    "DELIVERY_PROCESSING_ERROR",
  ];
  const now = new Date();
  const retryWindowStart = new Date(now.getTime() - 20 * 60 * 60_000);

  await db.$transaction(async (tx) => {
    const delivery = await tx.automationAlertDelivery.findFirst({
      where: {
        id: deliveryId,
        workspaceId: context.workspace.id,
        status: "FAILED",
        lastErrorCode: {in: retryableCodes},
        createdAt: {gte: retryWindowStart},
      },
      select: {id: true, attempts: true, lastErrorCode: true},
    });
    if (!delivery) {
      throw new Error("This delivery is not eligible for manual retry. Only recent transient failures can be requeued.");
    }

    const changed = await tx.automationAlertDelivery.updateMany({
      where: {
        id: delivery.id,
        workspaceId: context.workspace.id,
        status: "FAILED",
        lastErrorCode: {in: retryableCodes},
        createdAt: {gte: retryWindowStart},
      },
      data: {
        status: "RETRY",
        attempts: 0,
        nextAttemptAt: now,
        lockedAt: null,
        lastErrorCode: null,
      },
    });
    if (changed.count !== 1) throw new Error("Delivery state changed; refresh and try again.");

    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "automation.alert_delivery_retried",
        entityType: "automation_alert_delivery",
        entityId: delivery.id,
        metadata: {previousAttempts: delivery.attempts, previousErrorCode: delivery.lastErrorCode},
      },
    });
  });

  await dispatchAutomationAlertEmails(1);
  revalidatePath("/dashboard/automations");
}

