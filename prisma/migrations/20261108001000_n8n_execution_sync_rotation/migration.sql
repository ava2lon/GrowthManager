ALTER TABLE "Integration"
ADD COLUMN "lastExecutionSyncAt" TIMESTAMP(3);

CREATE INDEX "Integration_provider_status_lastExecutionSyncAt_idx"
ON "Integration"("provider", "status", "lastExecutionSyncAt");
