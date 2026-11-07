CREATE TABLE "WorkspaceNotificationPreference" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "inAppReviewAssigned" BOOLEAN NOT NULL DEFAULT true,
  "emailReviewAssigned" BOOLEAN NOT NULL DEFAULT true,
  "inAppReviewDecisions" BOOLEAN NOT NULL DEFAULT true,
  "emailReviewDecisions" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceNotificationPreference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkspaceNotificationPreference_workspaceId_userId_key" ON "WorkspaceNotificationPreference"("workspaceId","userId");
CREATE INDEX "WorkspaceNotificationPreference_userId_updatedAt_idx" ON "WorkspaceNotificationPreference"("userId","updatedAt");
ALTER TABLE "WorkspaceNotificationPreference" ADD CONSTRAINT "WorkspaceNotificationPreference_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceNotificationPreference" ADD CONSTRAINT "WorkspaceNotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
