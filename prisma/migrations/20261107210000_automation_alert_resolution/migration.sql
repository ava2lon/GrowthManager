ALTER TABLE "AutomationAlertEvent"
ADD COLUMN "resolvedAt" TIMESTAMP(3),
ADD COLUMN "resolutionMessage" TEXT;

CREATE INDEX "AutomationAlertEvent_workspaceId_integrationId_status_idx"
ON "AutomationAlertEvent"("workspaceId", "integrationId", "status");
