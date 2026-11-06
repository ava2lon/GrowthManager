CREATE TABLE "AutomationAlertDeliveryAttempt" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "errorCode" TEXT,
  "httpStatus" INTEGER,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  CONSTRAINT "AutomationAlertDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AutomationAlertDelivery_workspaceId_id_key" ON "AutomationAlertDelivery"("workspaceId", "id");
CREATE UNIQUE INDEX "AutomationAlertDeliveryAttempt_deliveryId_attemptNumber_key" ON "AutomationAlertDeliveryAttempt"("deliveryId", "attemptNumber");
CREATE INDEX "AutomationAlertDeliveryAttempt_workspaceId_startedAt_idx" ON "AutomationAlertDeliveryAttempt"("workspaceId", "startedAt");
CREATE INDEX "AutomationAlertDeliveryAttempt_workspaceId_deliveryId_attemptNumber_idx" ON "AutomationAlertDeliveryAttempt"("workspaceId", "deliveryId", "attemptNumber");

ALTER TABLE "AutomationAlertDeliveryAttempt"
ADD CONSTRAINT "AutomationAlertDeliveryAttempt_workspaceId_deliveryId_fkey"
FOREIGN KEY ("workspaceId", "deliveryId") REFERENCES "AutomationAlertDelivery"("workspaceId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;
