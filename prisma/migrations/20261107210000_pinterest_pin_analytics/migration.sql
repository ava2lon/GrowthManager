CREATE TABLE "PinterestPinAnalyticsSnapshot" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "pinId" TEXT NOT NULL,
  "reportDate" DATE NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "metrics" JSONB NOT NULL,
  "rawResponse" JSONB NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PinterestPinAnalyticsSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PinterestPinAnalyticsSnapshot_workspaceId_targetId_fkey"
    FOREIGN KEY ("workspaceId", "targetId")
    REFERENCES "SocialPostTarget"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PinterestPinAnalyticsSnapshot_workspaceId_targetId_reportDate_key"
  ON "PinterestPinAnalyticsSnapshot"("workspaceId", "targetId", "reportDate");
CREATE INDEX "PinterestPinAnalyticsSnapshot_workspaceId_reportDate_idx"
  ON "PinterestPinAnalyticsSnapshot"("workspaceId", "reportDate");
CREATE INDEX "PinterestPinAnalyticsSnapshot_workspaceId_targetId_fetchedAt_idx"
  ON "PinterestPinAnalyticsSnapshot"("workspaceId", "targetId", "fetchedAt");
