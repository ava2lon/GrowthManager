ALTER TYPE "WorkspaceNotificationType" ADD VALUE IF NOT EXISTS 'SOCIAL_INCIDENT';
ALTER TYPE "WorkspaceNotificationType" ADD VALUE IF NOT EXISTS 'SOCIAL_INCIDENT_RESOLVED';
ALTER TYPE "WorkspaceNotificationType" ADD VALUE IF NOT EXISTS 'SOCIAL_INCIDENT_ESCALATED';

CREATE TABLE "WorkspaceIncident" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "socialAccountId" TEXT,
  "socialPostTargetId" TEXT,
  "category" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "dedupeKey" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "errorCode" TEXT,
  "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "escalatedAt" TIMESTAMP(3),
  "resolutionMessage" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceIncident_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkspaceIncident_workspaceId_dedupeKey_key" ON "WorkspaceIncident"("workspaceId","dedupeKey");
CREATE INDEX "WorkspaceIncident_workspaceId_status_severity_lastSeenAt_idx" ON "WorkspaceIncident"("workspaceId","status","severity","lastSeenAt");
CREATE INDEX "WorkspaceIncident_workspaceId_sourceType_sourceId_idx" ON "WorkspaceIncident"("workspaceId","sourceType","sourceId");
CREATE INDEX "WorkspaceIncident_status_lastSeenAt_idx" ON "WorkspaceIncident"("status","lastSeenAt");
ALTER TABLE "WorkspaceIncident" ADD CONSTRAINT "WorkspaceIncident_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceIncident" ADD CONSTRAINT "WorkspaceIncident_workspaceId_socialAccountId_fkey" FOREIGN KEY ("workspaceId","socialAccountId") REFERENCES "SocialAccount"("workspaceId","id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceIncident" ADD CONSTRAINT "WorkspaceIncident_workspaceId_socialPostTargetId_fkey" FOREIGN KEY ("workspaceId","socialPostTargetId") REFERENCES "SocialPostTarget"("workspaceId","id") ON DELETE CASCADE ON UPDATE CASCADE;
