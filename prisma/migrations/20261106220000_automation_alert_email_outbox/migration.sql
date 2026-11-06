ALTER TABLE "AutomationAlertPolicy"
  ADD COLUMN "emailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "notificationEmail" TEXT;

ALTER TABLE "AutomationAlertEvent"
  ADD CONSTRAINT "AutomationAlertEvent_workspaceId_id_key" UNIQUE ("workspaceId", "id");

CREATE TABLE "AutomationAlertDelivery" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "alertEventId" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "channel" TEXT NOT NULL DEFAULT 'EMAIL',
  "recipient" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "providerMessageId" TEXT,
  "lastErrorCode" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationAlertDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AutomationAlertDelivery_workspaceId_alertEventId_channel_recipient_key"
  ON "AutomationAlertDelivery"("workspaceId", "alertEventId", "channel", "recipient");
CREATE INDEX "AutomationAlertDelivery_status_nextAttemptAt_idx"
  ON "AutomationAlertDelivery"("status", "nextAttemptAt");
CREATE INDEX "AutomationAlertDelivery_workspaceId_createdAt_idx"
  ON "AutomationAlertDelivery"("workspaceId", "createdAt");

ALTER TABLE "AutomationAlertDelivery"
  ADD CONSTRAINT "AutomationAlertDelivery_workspaceId_alertEventId_fkey"
  FOREIGN KEY ("workspaceId", "alertEventId")
  REFERENCES "AutomationAlertEvent"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AutomationAlertDelivery"
  ADD CONSTRAINT "AutomationAlertDelivery_workspaceId_integrationId_fkey"
  FOREIGN KEY ("workspaceId", "integrationId")
  REFERENCES "Integration"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
