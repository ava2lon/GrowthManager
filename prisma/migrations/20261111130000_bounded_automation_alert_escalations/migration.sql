ALTER TABLE "AutomationAlertPolicy"
ADD COLUMN IF NOT EXISTS "lastEscalationAt" TIMESTAMP(3);

ALTER TABLE "AutomationAlertEvent"
ADD COLUMN IF NOT EXISTS "escalationRecipientCursor" TEXT,
ADD COLUMN IF NOT EXISTS "escalatedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "automation_alert_policy_escalation_idx"
ON "AutomationAlertPolicy"("enabled", "lastEscalationAt", "createdAt");

CREATE INDEX IF NOT EXISTS "automation_alert_escalation_due_idx"
ON "AutomationAlertEvent"("workspaceId", "status", "lastNotifiedAt", "escalatedAt", "createdAt");
