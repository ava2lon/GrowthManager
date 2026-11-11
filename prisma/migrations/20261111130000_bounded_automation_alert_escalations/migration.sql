ALTER TABLE "AutomationAlertPolicy"
ADD COLUMN "lastEscalationAt" TIMESTAMP(3);

ALTER TABLE "AutomationAlertEvent"
ADD COLUMN "escalationRecipientCursor" TEXT,
ADD COLUMN "escalatedAt" TIMESTAMP(3);

CREATE INDEX "automation_alert_policy_escalation_idx"
ON "AutomationAlertPolicy"("enabled", "lastEscalationAt", "createdAt");

CREATE INDEX "automation_alert_escalation_due_idx"
ON "AutomationAlertEvent"("workspaceId", "status", "lastNotifiedAt", "escalatedAt", "createdAt");
