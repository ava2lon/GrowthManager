ALTER TABLE "AutomationAlertPolicy"
ADD COLUMN IF NOT EXISTS "lastEvaluatedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "AutomationAlertPolicy_enabled_lastEvaluatedAt_idx"
ON "AutomationAlertPolicy"("enabled", "lastEvaluatedAt");
