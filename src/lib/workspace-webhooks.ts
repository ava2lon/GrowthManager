import "server-only";
import {randomUUID} from "node:crypto";
import {Prisma} from "@prisma/client";
import {db} from "@/lib/db";

export const WORKSPACE_WEBHOOK_EVENT_TYPES = [
  "social.incident.created",
  "social.incident.reopened",
  "social.incident.resolved",
  "automation.alert.created",
  "automation.alert.resolved",
] as const;

export type WorkspaceWebhookEventInput = {
  workspaceId: string;
  eventType: string;
  data: Prisma.InputJsonObject;
  eventId?: string;
  occurredAt?: Date;
};

function validateInput(input: WorkspaceWebhookEventInput) {
  if (!input.workspaceId || input.workspaceId.length > 128) throw new Error("Invalid webhook workspace.");
  if (!(WORKSPACE_WEBHOOK_EVENT_TYPES as readonly string[]).includes(input.eventType)) throw new Error("Unsupported webhook event type.");
  if (input.eventId !== undefined && (!/^[A-Za-z0-9_-]{8,128}$/.test(input.eventId))) {
    throw new Error("Invalid webhook event identifier.");
  }
  const occurredAt = input.occurredAt ?? new Date();
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("Invalid webhook event timestamp.");
  return {eventId: input.eventId ?? randomUUID(), occurredAt};
}

/**
 * Enqueues an event inside the caller's transaction so domain changes and
 * webhook delivery intents can commit or roll back atomically.
 */
export async function enqueueWorkspaceWebhookEvent(
  tx: Prisma.TransactionClient,
  input: WorkspaceWebhookEventInput,
): Promise<{eventId: string; queued: number}> {
  const {eventId, occurredAt} = validateInput(input);
  const serializedData = JSON.stringify(input.data);
  if (typeof serializedData !== "string" || Buffer.byteLength(serializedData, "utf8") > 256 * 1024) {
    throw new Error("Webhook event data exceeds the 256 KB payload limit.");
  }
  const subscriptions = await tx.webhookSubscription.findMany({
    where: {
      workspaceId: input.workspaceId,
      status: "ACTIVE",
      disabledAt: null,
      eventTypes: {hasSome: [input.eventType, "*"]},
    },
    select: {id: true},
  });
  if (!subscriptions.length) return {eventId, queued: 0};

  const payload: Prisma.InputJsonObject = {
    id: eventId,
    type: input.eventType,
    version: 1,
    occurredAt: occurredAt.toISOString(),
    workspaceId: input.workspaceId,
    data: input.data,
  };
  const result = await tx.webhookDelivery.createMany({
    data: subscriptions.map((subscription) => ({
      workspaceId: input.workspaceId,
      subscriptionId: subscription.id,
      eventId,
      eventType: input.eventType,
      payload,
    })),
    skipDuplicates: true,
  });
  return {eventId, queued: result.count};
}

/** Convenience wrapper for events that do not share a transaction with a domain mutation. */
export async function emitWorkspaceWebhookEvent(input: WorkspaceWebhookEventInput) {
  return db.$transaction((tx) => enqueueWorkspaceWebhookEvent(tx, input));
}
