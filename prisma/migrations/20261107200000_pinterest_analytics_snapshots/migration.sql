CREATE TABLE "PinterestAnalyticsSnapshot" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "socialAccountId" TEXT NOT NULL,
  "reportDate" DATE NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "metrics" JSONB NOT NULL,
  "rawResponse" JSONB NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PinterestAnalyticsSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PinterestAnalyticsSnapshot_workspaceId_socialAccountId_fkey"
    FOREIGN KEY ("workspaceId", "socialAccountId")
    REFERENCES "SocialAccount"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PinterestAnalyticsSnapshot_workspaceId_socialAccountId_reportDate_key"
  ON "PinterestAnalyticsSnapshot"("workspaceId", "socialAccountId", "reportDate");
CREATE INDEX "PinterestAnalyticsSnapshot_workspaceId_reportDate_idx"
  ON "PinterestAnalyticsSnapshot"("workspaceId", "reportDate");
CREATE INDEX "PinterestAnalyticsSnapshot_workspaceId_socialAccountId_fetchedAt_idx"
  ON "PinterestAnalyticsSnapshot"("workspaceId", "socialAccountId", "fetchedAt");
