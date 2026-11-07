CREATE TABLE "YouTubeAnalyticsSnapshot" (
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
  CONSTRAINT "YouTubeAnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "youtube_analytics_subject_report_uq"
  ON "YouTubeAnalyticsSnapshot"("workspaceId","socialAccountId","subjectType","subjectId","reportDate");
CREATE INDEX "youtube_analytics_workspace_date_idx"
  ON "YouTubeAnalyticsSnapshot"("workspaceId","reportDate");
CREATE INDEX "youtube_analytics_account_type_fetched_idx"
  ON "YouTubeAnalyticsSnapshot"("workspaceId","socialAccountId","subjectType","fetchedAt");
CREATE INDEX "youtube_analytics_target_idx" ON "YouTubeAnalyticsSnapshot"("targetId");
ALTER TABLE "YouTubeAnalyticsSnapshot"
  ADD CONSTRAINT "YouTubeAnalyticsSnapshot_workspaceId_socialAccountId_fkey"
  FOREIGN KEY ("workspaceId","socialAccountId") REFERENCES "SocialAccount"("workspaceId","id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YouTubeAnalyticsSnapshot"
  ADD CONSTRAINT "YouTubeAnalyticsSnapshot_workspaceId_targetId_fkey"
  FOREIGN KEY ("workspaceId","targetId") REFERENCES "SocialPostTarget"("workspaceId","id")
  ON DELETE CASCADE ON UPDATE CASCADE;
