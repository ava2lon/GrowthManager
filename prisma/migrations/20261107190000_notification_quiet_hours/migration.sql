ALTER TABLE "WorkspaceNotificationPreference"
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "quietHoursStart" TEXT NOT NULL DEFAULT '22:00',
  ADD COLUMN "quietHoursEnd" TEXT NOT NULL DEFAULT '08:00';

ALTER TABLE "ContentReviewEmailDelivery"
  ADD COLUMN "recipientUserId" TEXT;

CREATE INDEX "ContentReviewEmailDelivery_recipientUserId_idx"
  ON "ContentReviewEmailDelivery"("recipientUserId");

ALTER TABLE "ContentReviewEmailDelivery"
  ADD CONSTRAINT "ContentReviewEmailDelivery_recipientUserId_fkey"
  FOREIGN KEY ("recipientUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
