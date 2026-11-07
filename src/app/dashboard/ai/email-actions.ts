"use server";

import {revalidatePath} from "next/cache";
import {requireWorkspaceRole} from "@/lib/workspace";
import {db} from "@/lib/db";
import {consumeRateLimit} from "@/lib/rate-limit";

export async function retryContentReviewEmail(deliveryId: string) {
  const context = await requireWorkspaceRole("ADMIN");
  if (typeof deliveryId !== "string" || !deliveryId.trim() || deliveryId.length > 128) {
    throw new Error("Invalid delivery record.");
  }

  const rate = await consumeRateLimit("content-review-email-retry:" + context.workspace.id + ":" + context.userId, 10, 3600);
  if (!rate.allowed || (process.env.NODE_ENV === "production" && !rate.configured)) {
    throw new Error("Retry limit reached or protection is unavailable.");
  }

  await db.$transaction(async (tx) => {
    const delivery = await tx.contentReviewEmailDelivery.findFirst({
      where: {
        id: deliveryId,
        workspaceId: context.workspace.id,
        status: "FAILED",
        providerMessageId: null,
      },
      select: {
        id: true,
        assignmentId: true,
        eventType: true,
        eventKey: true,
        recipientEmail: true,
        recipientName: true,
      },
    });
    if (!delivery) {
      throw new Error("Only failed, unaccepted email deliveries can be retried. Delivered, bounced, complained, and in-progress records cannot be retried.");
    }

    const assignment = await tx.contentReviewAssignment.findFirst({
      where: {id: delivery.assignmentId, workspaceId: context.workspace.id},
      select: {id: true},
    });
    if (!assignment) throw new Error("The associated review assignment no longer exists.");

    const retryAt = new Date();
    const retry = await tx.contentReviewEmailDelivery.create({
      data: {
        workspaceId: context.workspace.id,
        assignmentId: delivery.assignmentId,
        eventType: delivery.eventType,
        eventKey: delivery.eventKey + ":MANUAL_RETRY:" + retryAt.getTime(),
        recipientEmail: delivery.recipientEmail,
        recipientName: delivery.recipientName,
      },
      select: {id: true},
    });

    await tx.activityLog.create({
      data: {
        workspaceId: context.workspace.id,
        userId: context.userId,
        action: "content.review_email_manual_retry_queued",
        entityType: "ContentReviewEmailDelivery",
        entityId: retry.id,
        metadata: {originalDeliveryId: delivery.id, eventType: delivery.eventType},
      },
    });
  });

  revalidatePath("/dashboard/ai");
}
