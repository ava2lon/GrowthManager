ALTER TABLE "Integration"
  ADD COLUMN "lastValidatedAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorCode" TEXT;

CREATE INDEX "Integration_workspaceId_status_updatedAt_idx"
  ON "Integration"("workspaceId", "status", "updatedAt");
