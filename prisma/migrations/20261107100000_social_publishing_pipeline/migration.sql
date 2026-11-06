-- Durable, workspace-scoped publishing targets and provider attempt ledger.
ALTER TABLE "SocialAccount"
  ADD CONSTRAINT "SocialAccount_workspaceId_id_key" UNIQUE ("workspaceId", "id");

ALTER TABLE "ContentPost"
  ADD CONSTRAINT "ContentPost_workspaceId_id_key" UNIQUE ("workspaceId", "id");

CREATE TABLE "SocialPostTarget" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "contentPostId" TEXT NOT NULL,
  "socialAccountId" TEXT NOT NULL,
  "provider" "SocialProvider" NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "providerPostId" TEXT,
  "errorCode" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialPostTarget_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialPostTarget_workspaceId_contentPostId_fkey"
    FOREIGN KEY ("workspaceId", "contentPostId") REFERENCES "ContentPost"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SocialPostTarget_workspaceId_socialAccountId_fkey"
    FOREIGN KEY ("workspaceId", "socialAccountId") REFERENCES "SocialAccount"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SocialPublishAttempt" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "providerPostId" TEXT,
  "errorCode" TEXT,
  "httpStatus" INTEGER,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  CONSTRAINT "SocialPublishAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SocialPublishAttempt_workspaceId_targetId_fkey"
    FOREIGN KEY ("workspaceId", "targetId") REFERENCES "SocialPostTarget"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SocialPostTarget_workspaceId_id_key" ON "SocialPostTarget"("workspaceId", "id");
CREATE UNIQUE INDEX "SocialPostTarget_contentPostId_socialAccountId_key" ON "SocialPostTarget"("contentPostId", "socialAccountId");
CREATE INDEX "SocialPostTarget_workspaceId_status_createdAt_idx" ON "SocialPostTarget"("workspaceId", "status", "createdAt");
CREATE INDEX "SocialPostTarget_workspaceId_socialAccountId_status_idx" ON "SocialPostTarget"("workspaceId", "socialAccountId", "status");
CREATE UNIQUE INDEX "SocialPublishAttempt_idempotencyKey_key" ON "SocialPublishAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "SocialPublishAttempt_targetId_attemptNumber_key" ON "SocialPublishAttempt"("targetId", "attemptNumber");
CREATE INDEX "SocialPublishAttempt_workspaceId_startedAt_idx" ON "SocialPublishAttempt"("workspaceId", "startedAt");
