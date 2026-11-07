ALTER TABLE "WorkspaceNotificationPreference"
  ADD COLUMN "digestEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "digestFrequency" TEXT NOT NULL DEFAULT 'DAILY',
  ADD COLUMN "digestSendTime" TEXT NOT NULL DEFAULT '09:00';

CREATE TABLE "ContentReviewEmailDigest" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "recipientUserId" TEXT NOT NULL,
  "recipientEmail" TEXT NOT NULL,
  "recipientName" TEXT,
  "digestKey" TEXT NOT NULL,
  "periodKey" TEXT NOT NULL,
  "deliveryIds" TEXT[] NOT NULL,
  "items" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "providerMessageId" TEXT,
  "lastErrorCode" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContentReviewEmailDigest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContentReviewEmailDigest_digestKey_key" ON "ContentReviewEmailDigest"("digestKey");
CREATE INDEX "ContentReviewEmailDigest_status_nextAttemptAt_idx" ON "ContentReviewEmailDigest"("status", "nextAttemptAt");
CREATE INDEX "ContentReviewEmailDigest_workspaceId_recipientUserId_createdAt_idx" ON "ContentReviewEmailDigest"("workspaceId", "recipientUserId", "createdAt");

ALTER TABLE "ContentReviewEmailDigest"
  ADD CONSTRAINT "ContentReviewEmailDigest_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentReviewEmailDigest"
  ADD CONSTRAINT "ContentReviewEmailDigest_recipientUserId_fkey"
  FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
