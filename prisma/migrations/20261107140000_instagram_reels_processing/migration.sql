ALTER TABLE "SocialPostTarget"
  ADD COLUMN "providerContainerId" TEXT,
  ADD COLUMN "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN "nextCheckAt" TIMESTAMP(3);

CREATE INDEX "SocialPostTarget_workspaceId_provider_status_nextCheckAt_idx"
  ON "SocialPostTarget"("workspaceId", "provider", "status", "nextCheckAt");
