"use server";

import {randomUUID} from "node:crypto";
import {revalidatePath} from "next/cache";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";
import {createWebhookSigningSecret, encryptWebhookSigningSecret} from "@/lib/webhook-secret-crypto";
import {resolveSafeWebhookEndpoint} from "@/lib/webhook-endpoint-security";
import {WORKSPACE_WEBHOOK_EVENT_TYPES} from "@/lib/workspace-webhooks";

const WEBHOOK_PATH = "/dashboard/integrations/webhooks";

function subscriptionIdFrom(formData: FormData): string {
  const id = String(formData.get("subscriptionId") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error("Invalid webhook subscription.");
  return id;
}

async function enforceWebhookAdminLimit(workspaceId: string, userId: string, operation: string) {
  const result = await consumeRateLimit("webhook:" + operation + ":" + workspaceId + ":" + userId, 10, 3600);
  if (!result.allowed || (process.env.NODE_ENV === "production" && !result.configured)) {
    throw new Error("Webhook management rate limit reached or protection is unavailable.");
  }
}

export async function createWorkspaceWebhookSubscription(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  await enforceWebhookAdminLimit(context.workspace.id, context.userId, "create");
  const name = String(formData.get("name") ?? "").trim();
  const endpointUrl = String(formData.get("endpointUrl") ?? "").trim();
  const eventTypes = [...new Set(formData.getAll("eventTypes").map((value) => String(value).trim()))];

  if (!name || name.length > 80 || !endpointUrl || endpointUrl.length > 2048 ||
      eventTypes.length < 1 || eventTypes.length > 30 ||
      eventTypes.some((eventType) => eventType !== "*" && !(WORKSPACE_WEBHOOK_EVENT_TYPES as readonly string[]).includes(eventType))) {
    throw new Error("Enter a valid name, HTTPS endpoint, and between 1 and 30 event types.");
  }

  await resolveSafeWebhookEndpoint(endpointUrl);
  const id = randomUUID();
  const signingSecret = createWebhookSigningSecret();
  const signingSecretEncrypted = encryptWebhookSigningSecret(signingSecret, context.workspace.id, id);

  await db.$transaction(async (tx) => {
    await tx.webhookSubscription.create({
      data: {
        id,
        workspaceId: context.workspace.id,
        name,
        endpointUrl,
        eventTypes,
        signingSecretEncrypted,
      },
    });
    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "webhook.subscription_created",
        entityType: "webhook_subscription",
        entityId: id,
        metadata: {eventTypes, destinationHost: new URL(endpointUrl).hostname},
      },
    });
  });

  revalidatePath(WEBHOOK_PATH);
  return {subscriptionId: id, signingSecret};
}

export async function pauseWorkspaceWebhookSubscription(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const id = subscriptionIdFrom(formData);
  await enforceWebhookAdminLimit(context.workspace.id, context.userId, "status");
  const changed = await db.webhookSubscription.updateMany({
    where: {id, workspaceId: context.workspace.id, status: "ACTIVE"},
    data: {status: "PAUSED", disabledAt: new Date()},
  });
  if (changed.count !== 1) throw new Error("Active webhook subscription not found in this workspace.");
  await db.activityLog.create({
    data: {workspaceId: context.workspace.id, userId: context.userId, action: "webhook.subscription_paused", entityType: "webhook_subscription", entityId: id},
  });
  revalidatePath(WEBHOOK_PATH);
}

export async function resumeWorkspaceWebhookSubscription(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const id = subscriptionIdFrom(formData);
  await enforceWebhookAdminLimit(context.workspace.id, context.userId, "status");
  const changed = await db.webhookSubscription.updateMany({
    where: {id, workspaceId: context.workspace.id, status: "PAUSED"},
    data: {status: "ACTIVE", disabledAt: null, consecutiveFailures: 0},
  });
  if (changed.count !== 1) throw new Error("Paused webhook subscription not found in this workspace.");
  await db.activityLog.create({
    data: {workspaceId: context.workspace.id, userId: context.userId, action: "webhook.subscription_resumed", entityType: "webhook_subscription", entityId: id},
  });
  revalidatePath(WEBHOOK_PATH);
}

export async function rotateWorkspaceWebhookSigningSecret(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const id = subscriptionIdFrom(formData);
  await enforceWebhookAdminLimit(context.workspace.id, context.userId, "rotate");
  const signingSecret = createWebhookSigningSecret();
  const encrypted = encryptWebhookSigningSecret(signingSecret, context.workspace.id, id);
  const changed = await db.webhookSubscription.updateMany({
    where: {id, workspaceId: context.workspace.id},
    data: {signingSecretEncrypted: encrypted},
  });
  if (changed.count !== 1) throw new Error("Webhook subscription not found in this workspace.");
  await db.activityLog.create({
    data: {workspaceId: context.workspace.id, userId: context.userId, action: "webhook.signing_secret_rotated", entityType: "webhook_subscription", entityId: id},
  });
  revalidatePath(WEBHOOK_PATH);
  return {subscriptionId: id, signingSecret};
}

export async function redeliverWorkspaceWebhookDelivery(formData: FormData) {
  const context = await requireWorkspaceRole("ADMIN");
  const deliveryId = String(formData.get("deliveryId") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(deliveryId)) throw new Error("Invalid webhook delivery.");
  await enforceWebhookAdminLimit(context.workspace.id, context.userId, "redeliver");
  const changed = await db.webhookDelivery.updateMany({
    where: {id: deliveryId, workspaceId: context.workspace.id, status: "FAILED", subscription: {status: "ACTIVE", disabledAt: null}},
    data: {
      status: "PENDING",
      retryAttempts: 0,
      nextAttemptAt: new Date(),
      lockedAt: null,
      deliveredAt: null,
      lastHttpStatus: null,
      lastErrorCode: null,
    },
  });
  if (changed.count !== 1) throw new Error("Failed webhook delivery not found in this workspace.");
  await db.activityLog.create({
    data: {workspaceId: context.workspace.id, userId: context.userId, action: "webhook.delivery_redelivered", entityType: "webhook_delivery", entityId: deliveryId},
  });
  revalidatePath(WEBHOOK_PATH);
}
