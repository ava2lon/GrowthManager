CREATE TYPE "ContentReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED');
CREATE TYPE "WorkspaceNotificationType" AS ENUM ('CONTENT_REVIEW_ASSIGNED', 'CONTENT_REVIEW_COMPLETED', 'CONTENT_CHANGES_REQUESTED');

CREATE TABLE "ContentReviewAssignment" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "contentPostId" TEXT NOT NULL,
  "reviewerUserId" TEXT NOT NULL,
  "assignedById" TEXT NOT NULL,
  "status" "ContentReviewStatus" NOT NULL DEFAULT 'PENDING',
  "feedback" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContentReviewAssignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContentReviewAssignment_workspaceId_contentPostId_reviewerUserId_key"
  ON "ContentReviewAssignment"("workspaceId","contentPostId","reviewerUserId");
CREATE UNIQUE INDEX "ContentReviewAssignment_workspaceId_id_key"
  ON "ContentReviewAssignment"("workspaceId","id");
CREATE INDEX "ContentReviewAssignment_workspaceId_reviewerUserId_status_updatedAt_idx"
  ON "ContentReviewAssignment"("workspaceId","reviewerUserId","status","updatedAt");
CREATE INDEX "ContentReviewAssignment_workspaceId_contentPostId_status_idx"
  ON "ContentReviewAssignment"("workspaceId","contentPostId","status");
ALTER TABLE "ContentReviewAssignment"
  ADD CONSTRAINT "ContentReviewAssignment_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentReviewAssignment"
  ADD CONSTRAINT "ContentReviewAssignment_workspaceId_contentPostId_fkey"
  FOREIGN KEY ("workspaceId","contentPostId") REFERENCES "ContentPost"("workspaceId","id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentReviewAssignment"
  ADD CONSTRAINT "ContentReviewAssignment_reviewerUserId_fkey"
  FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentReviewAssignment"
  ADD CONSTRAINT "ContentReviewAssignment_assignedById_fkey"
  FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkspaceNotification" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "WorkspaceNotificationType" NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "href" TEXT NOT NULL,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceNotification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkspaceNotification_workspaceId_userId_readAt_createdAt_idx"
  ON "WorkspaceNotification"("workspaceId","userId","readAt","createdAt");
ALTER TABLE "WorkspaceNotification"
  ADD CONSTRAINT "WorkspaceNotification_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceNotification"
  ADD CONSTRAINT "WorkspaceNotification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
