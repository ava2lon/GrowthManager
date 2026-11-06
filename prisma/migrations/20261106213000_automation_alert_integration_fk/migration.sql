CREATE UNIQUE INDEX "Integration_workspaceId_id_key" ON "Integration"("workspaceId", "id");

ALTER TABLE "AutomationAlertEvent"
ADD CONSTRAINT "AutomationAlertEvent_workspaceId_integrationId_fkey"
FOREIGN KEY ("workspaceId", "integrationId")
REFERENCES "Integration"("workspaceId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;
