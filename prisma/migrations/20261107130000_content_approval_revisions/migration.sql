ALTER TYPE "PostStatus" ADD VALUE IF NOT EXISTS 'APPROVED';

CREATE TABLE "ContentPostRevision" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "contentPostId" TEXT NOT NULL,
  "title" TEXT,
  "body" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "changeReason" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContentPostRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContentPostRevision_contentPostId_version_key"
  ON "ContentPostRevision"("contentPostId", "version");
CREATE INDEX "ContentPostRevision_workspaceId_contentPostId_createdAt_idx"
  ON "ContentPostRevision"("workspaceId", "contentPostId", "createdAt");

ALTER TABLE "ContentPostRevision"
  ADD CONSTRAINT "ContentPostRevision_workspaceId_contentPostId_fkey"
  FOREIGN KEY ("workspaceId", "contentPostId")
  REFERENCES "ContentPost"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
