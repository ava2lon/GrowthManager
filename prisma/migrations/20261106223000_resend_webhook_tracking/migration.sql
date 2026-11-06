ALTER TABLE "AutomationAlertDelivery"
  ADD COLUMN "lastProviderEventAt" TIMESTAMP(3);

CREATE INDEX "AutomationAlertDelivery_providerMessageId_idx"
  ON "AutomationAlertDelivery"("providerMessageId");

CREATE TABLE "ResendWebhookEvent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "ResendWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResendWebhookEvent_integrationId_providerEventId_key"
  ON "ResendWebhookEvent"("integrationId", "providerEventId");
CREATE INDEX "ResendWebhookEvent_workspaceId_receivedAt_idx"
  ON "ResendWebhookEvent"("workspaceId", "receivedAt");

ALTER TABLE "ResendWebhookEvent"
  ADD CONSTRAINT "ResendWebhookEvent_workspaceId_integrationId_fkey"
  FOREIGN KEY ("workspaceId", "integrationId")
  REFERENCES "Integration"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
