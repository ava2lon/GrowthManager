CREATE TABLE "XAnalyticsSnapshot" (
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
 CONSTRAINT "XAnalyticsSnapshot_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "x_analytics_account_fk" FOREIGN KEY ("workspaceId","socialAccountId") REFERENCES "SocialAccount"("workspaceId","id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "x_analytics_target_fk" FOREIGN KEY ("workspaceId","targetId") REFERENCES "SocialPostTarget"("workspaceId","id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "x_analytics_subject_report_uq" ON "XAnalyticsSnapshot"("workspaceId","socialAccountId","subjectType","subjectId","reportDate");
CREATE INDEX "x_analytics_workspace_date_idx" ON "XAnalyticsSnapshot"("workspaceId","reportDate");
CREATE INDEX "x_analytics_account_type_fetched_idx" ON "XAnalyticsSnapshot"("workspaceId","socialAccountId","subjectType","fetchedAt");
CREATE INDEX "x_analytics_target_idx" ON "XAnalyticsSnapshot"("targetId");
