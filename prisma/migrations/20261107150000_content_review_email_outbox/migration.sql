CREATE TABLE "ContentReviewEmailDelivery" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "eventType" "WorkspaceNotificationType" NOT NULL,
  "eventKey" TEXT NOT NULL,
  "recipientEmail" TEXT NOT NULL,
  "recipientName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "providerMessageId" TEXT,
  "lastErrorCode" TEXT,
  "sentAt" TIMESTAMP(3),
  "lastProviderEventAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContentReviewEmailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContentReviewEmailDelivery_eventKey_key" ON "ContentReviewEmailDelivery"("eventKey");
CREATE UNIQUE INDEX "ContentReviewEmailDelivery_workspaceId_id_key" ON "ContentReviewEmailDelivery"("workspaceId", "id");
CREATE INDEX "ContentReviewEmailDelivery_status_nextAttemptAt_idx" ON "ContentReviewEmailDelivery"("status", "nextAttemptAt");
CREATE INDEX "ContentReviewEmailDelivery_workspaceId_createdAt_idx" ON "ContentReviewEmailDelivery"("workspaceId", "createdAt");
CREATE INDEX "ContentReviewEmailDelivery_providerMessageId_idx" ON "ContentReviewEmailDelivery"("providerMessageId");

ALTER TABLE "ContentReviewEmailDelivery"
  ADD CONSTRAINT "ContentReviewEmailDelivery_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentReviewEmailDelivery"
  ADD CONSTRAINT "ContentReviewEmailDelivery_workspaceId_assignmentId_fkey"
  FOREIGN KEY ("workspaceId", "assignmentId") REFERENCES "ContentReviewAssignment"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "ContentReviewEmailWebhookEvent" (
  "id" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContentReviewEmailWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContentReviewEmailWebhookEvent_providerEventId_key" ON "ContentReviewEmailWebhookEvent"("providerEventId");
CREATE INDEX "ContentReviewEmailWebhookEvent_deliveryId_occurredAt_idx" ON "ContentReviewEmailWebhookEvent"("deliveryId", "occurredAt");
ALTER TABLE "ContentReviewEmailWebhookEvent"
  ADD CONSTRAINT "ContentReviewEmailWebhookEvent_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "ContentReviewEmailDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
