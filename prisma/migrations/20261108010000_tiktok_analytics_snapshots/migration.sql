CREATE TABLE "TikTokAnalyticsSnapshot" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "socialAccountId" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "targetId" TEXT,
  "reportDate" DATE NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "metrics" JSONB NOT NULL,
  "rawResponse" JSONB NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TikTokAnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tiktok_analytics_subject_report_uq"
  ON "TikTokAnalyticsSnapshot"("workspaceId","socialAccountId","subjectType","subjectId","reportDate");
CREATE INDEX "tiktok_analytics_workspace_date_idx"
  ON "TikTokAnalyticsSnapshot"("workspaceId","reportDate");
CREATE INDEX "tiktok_analytics_account_type_fetched_idx"
  ON "TikTokAnalyticsSnapshot"("workspaceId","socialAccountId","subjectType","fetchedAt");
CREATE INDEX "tiktok_analytics_target_idx" ON "TikTokAnalyticsSnapshot"("targetId");
ALTER TABLE "TikTokAnalyticsSnapshot"
  ADD CONSTRAINT "TikTokAnalyticsSnapshot_workspaceId_socialAccountId_fkey"
  FOREIGN KEY ("workspaceId","socialAccountId") REFERENCES "SocialAccount"("workspaceId","id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TikTokAnalyticsSnapshot"
  ADD CONSTRAINT "TikTokAnalyticsSnapshot_workspaceId_targetId_fkey"
  FOREIGN KEY ("workspaceId","targetId") REFERENCES "SocialPostTarget"("workspaceId","id")
  ON DELETE CASCADE ON UPDATE CASCADE;
