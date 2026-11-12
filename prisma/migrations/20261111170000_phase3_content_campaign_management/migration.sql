DO $$ BEGIN CREATE TYPE "ContentType" AS ENUM ('POST', 'ARTICLE', 'VIDEO', 'IMAGE', 'CAROUSEL', 'STORY', 'SHORT_FORM_VIDEO'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ContentWorkflowStatus" AS ENUM ('IDEA', 'DRAFT', 'REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "ContentPost"
  ADD COLUMN IF NOT EXISTS "contentType" "ContentType" NOT NULL DEFAULT 'POST',
  ADD COLUMN IF NOT EXISTS "workflowStatus" "ContentWorkflowStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS "category" TEXT,
  ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "campaignId" TEXT,
  ADD COLUMN IF NOT EXISTS "authorId" TEXT,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ContentPost_workspaceId_workflowStatus_createdAt_idx" ON "ContentPost"("workspaceId", "workflowStatus", "createdAt");
CREATE INDEX IF NOT EXISTS "ContentPost_workspaceId_campaignId_idx" ON "ContentPost"("workspaceId", "campaignId");
CREATE INDEX IF NOT EXISTS "ContentPost_workspaceId_archivedAt_updatedAt_idx" ON "ContentPost"("workspaceId", "archivedAt", "updatedAt");

ALTER TABLE "Campaign"
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "budget" DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "targetAudience" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Campaign_workspaceId_id_key" ON "Campaign"("workspaceId", "id");

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ContentPost"'::regclass AND conname = 'ContentPost_workspaceId_campaignId_fkey') THEN ALTER TABLE "ContentPost" ADD CONSTRAINT "ContentPost_workspaceId_campaignId_fkey" FOREIGN KEY ("workspaceId", "campaignId") REFERENCES "Campaign"("workspaceId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"ContentPost"'::regclass AND conname = 'ContentPost_authorId_fkey') THEN ALTER TABLE "ContentPost" ADD CONSTRAINT "ContentPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;



CREATE TABLE IF NOT EXISTS "MediaFolder" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "MediaFolder_workspaceId_id_key" ON "MediaFolder"("workspaceId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "MediaFolder_workspaceId_brandId_name_key" ON "MediaFolder"("workspaceId", "brandId", "name");
CREATE INDEX IF NOT EXISTS "MediaFolder_workspaceId_createdAt_idx" ON "MediaFolder"("workspaceId", "createdAt");

ALTER TABLE "MediaAsset"
  ADD COLUMN IF NOT EXISTS "folderId" TEXT,
  ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "url" TEXT;
UPDATE "MediaAsset" SET "url" = '/api/media/' || "id" || '/download' WHERE "url" IS NULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"MediaAsset"'::regclass AND conname = 'MediaAsset_workspaceId_folderId_fkey') THEN ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_workspaceId_folderId_fkey" FOREIGN KEY ("workspaceId", "folderId") REFERENCES "MediaFolder"("workspaceId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;
CREATE INDEX IF NOT EXISTS "MediaAsset_workspaceId_folderId_createdAt_idx" ON "MediaAsset"("workspaceId", "folderId", "createdAt");

CREATE TABLE IF NOT EXISTS "CampaignSocialAccount" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "socialAccountId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CampaignSocialAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CampaignSocialAccount_workspaceId_campaignId_fkey" FOREIGN KEY ("workspaceId", "campaignId") REFERENCES "Campaign"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CampaignSocialAccount_workspaceId_socialAccountId_fkey" FOREIGN KEY ("workspaceId", "socialAccountId") REFERENCES "SocialAccount"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignSocialAccount_workspaceId_campaignId_socialAccountId_key" ON "CampaignSocialAccount"("workspaceId", "campaignId", "socialAccountId");
CREATE INDEX IF NOT EXISTS "CampaignSocialAccount_workspaceId_socialAccountId_idx" ON "CampaignSocialAccount"("workspaceId", "socialAccountId");
