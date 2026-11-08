ALTER TABLE "AutomationAlertPolicy"
ADD COLUMN "lastEvaluatedAt" TIMESTAMP(3);

CREATE INDEX "AutomationAlertPolicy_enabled_lastEvaluatedAt_idx"
ON "AutomationAlertPolicy"("enabled", "lastEvaluatedAt");
