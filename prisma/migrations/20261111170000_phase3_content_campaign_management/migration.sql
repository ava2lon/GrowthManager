CREATE TYPE "ContentType" AS ENUM ('POST', 'ARTICLE', 'VIDEO', 'IMAGE', 'CAROUSEL', 'STORY', 'SHORT_FORM_VIDEO');
CREATE TYPE "ContentWorkflowStatus" AS ENUM ('IDEA', 'DRAFT', 'REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED');

ALTER TABLE "ContentPost"
  ADD COLUMN "contentType" "ContentType" NOT NULL DEFAULT 'POST',
  ADD COLUMN "workflowStatus" "ContentWorkflowStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "category" TEXT,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "campaignId" TEXT,
  ADD COLUMN "authorId" TEXT,
  ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "ContentPost_workspaceId_workflowStatus_createdAt_idx" ON "ContentPost"("workspaceId", "workflowStatus", "createdAt");
CREATE INDEX "ContentPost_workspaceId_campaignId_idx" ON "ContentPost"("workspaceId", "campaignId");
CREATE INDEX "ContentPost_workspaceId_archivedAt_updatedAt_idx" ON "ContentPost"("workspaceId", "archivedAt", "updatedAt");

ALTER TABLE "Campaign"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "budget" DECIMAL(12,2),
  ADD COLUMN "targetAudience" TEXT;

CREATE UNIQUE INDEX "Campaign_workspaceId_id_key" ON "Campaign"("workspaceId", "id");

ALTER TABLE "ContentPost"
  ADD CONSTRAINT "ContentPost_workspaceId_campaignId_fkey"
  FOREIGN KEY ("workspaceId", "campaignId") REFERENCES "Campaign"("workspaceId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ContentPost_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;



CREATE TABLE "MediaFolder" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "brandId" TEXT,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MediaFolder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MediaFolder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MediaFolder_workspaceId_brandId_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "Brand"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MediaFolder_workspaceId_id_key" ON "MediaFolder"("workspaceId", "id");
CREATE UNIQUE INDEX "MediaFolder_workspaceId_brandId_name_key" ON "MediaFolder"("workspaceId", "brandId", "name");
CREATE INDEX "MediaFolder_workspaceId_createdAt_idx" ON "MediaFolder"("workspaceId", "createdAt");

ALTER TABLE "MediaAsset"
  ADD COLUMN "folderId" TEXT,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "url" TEXT;
UPDATE "MediaAsset" SET "url" = '/api/media/' || "id" || '/download' WHERE "url" IS NULL;
ALTER TABLE "MediaAsset"
  ADD CONSTRAINT "MediaAsset_workspaceId_folderId_fkey"
  FOREIGN KEY ("workspaceId", "folderId") REFERENCES "MediaFolder"("workspaceId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "MediaAsset_workspaceId_folderId_createdAt_idx" ON "MediaAsset"("workspaceId", "folderId", "createdAt");

CREATE TABLE "CampaignSocialAccount" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "socialAccountId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CampaignSocialAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CampaignSocialAccount_workspaceId_campaignId_fkey" FOREIGN KEY ("workspaceId", "campaignId") REFERENCES "Campaign"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CampaignSocialAccount_workspaceId_socialAccountId_fkey" FOREIGN KEY ("workspaceId", "socialAccountId") REFERENCES "SocialAccount"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CampaignSocialAccount_workspaceId_campaignId_socialAccountId_key" ON "CampaignSocialAccount"("workspaceId", "campaignId", "socialAccountId");
CREATE INDEX "CampaignSocialAccount_workspaceId_socialAccountId_idx" ON "CampaignSocialAccount"("workspaceId", "socialAccountId");
