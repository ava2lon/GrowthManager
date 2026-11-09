CREATE TABLE "SocialAnalyticsRetry" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "reportDate" DATE NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialAnalyticsRetry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialAnalyticsRetry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SocialAnalyticsRetry_workspaceId_provider_subjectType_subjectId_reportDate_key"
  ON "SocialAnalyticsRetry"("workspaceId", "provider", "subjectType", "subjectId", "reportDate");
CREATE INDEX "SocialAnalyticsRetry_status_nextAttemptAt_idx"
  ON "SocialAnalyticsRetry"("status", "nextAttemptAt");
CREATE INDEX "SocialAnalyticsRetry_workspaceId_status_nextAttemptAt_idx"
  ON "SocialAnalyticsRetry"("workspaceId", "status", "nextAttemptAt");
