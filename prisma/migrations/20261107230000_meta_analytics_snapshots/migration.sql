CREATE TABLE "MetaAnalyticsSnapshot" ("id" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,"socialAccountId" TEXT NOT NULL,"subjectType" TEXT NOT NULL,"subjectId" TEXT NOT NULL,"targetId" TEXT,"reportDate" DATE NOT NULL,"startDate" DATE NOT NULL,"endDate" DATE NOT NULL,"metrics" JSONB NOT NULL,"rawResponse" JSONB NOT NULL,"fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "MetaAnalyticsSnapshot_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "meta_analytics_subject_report_uq" ON "MetaAnalyticsSnapshot"("workspaceId","socialAccountId","subjectType","subjectId","reportDate");
CREATE INDEX "meta_analytics_workspace_date_idx" ON "MetaAnalyticsSnapshot"("workspaceId","reportDate");
CREATE INDEX "meta_analytics_account_type_fetched_idx" ON "MetaAnalyticsSnapshot"("workspaceId","socialAccountId","subjectType","fetchedAt");
CREATE UNIQUE INDEX "MetaAnalyticsSnapshot_targetId_key" ON "MetaAnalyticsSnapshot"("targetId");
CREATE INDEX "MetaAnalyticsSnapshot_targetId_idx" ON "MetaAnalyticsSnapshot"("targetId");
ALTER TABLE "MetaAnalyticsSnapshot" ADD CONSTRAINT "MetaAnalyticsSnapshot_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "SocialPostTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MetaAnalyticsSnapshot" ADD CONSTRAINT "MetaAnalyticsSnapshot_workspaceId_socialAccountId_fkey" FOREIGN KEY ("workspaceId","socialAccountId") REFERENCES "SocialAccount"("workspaceId","id") ON DELETE CASCADE ON UPDATE CASCADE;
