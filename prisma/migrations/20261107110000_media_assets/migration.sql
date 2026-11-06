CREATE TYPE "MediaAssetStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'DELETED');

CREATE TABLE "MediaAsset" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "brandId" TEXT,
  "createdById" TEXT NOT NULL,
  "storageProvider" TEXT NOT NULL DEFAULT 'SUPABASE',
  "bucket" TEXT NOT NULL,
  "objectPath" TEXT NOT NULL,
  "originalFilename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "checksumSha256" TEXT,
  "width" INTEGER,
  "height" INTEGER,
  "durationMs" INTEGER,
  "altText" TEXT,
  "status" "MediaAssetStatus" NOT NULL DEFAULT 'PENDING',
  "uploadedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MediaAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MediaAsset_workspaceId_brandId_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "Brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MediaAsset_workspaceId_id_key" ON "MediaAsset"("workspaceId", "id");
CREATE UNIQUE INDEX "MediaAsset_workspaceId_objectPath_key" ON "MediaAsset"("workspaceId", "objectPath");
CREATE INDEX "MediaAsset_workspaceId_status_createdAt_idx" ON "MediaAsset"("workspaceId", "status", "createdAt");
CREATE INDEX "MediaAsset_workspaceId_brandId_createdAt_idx" ON "MediaAsset"("workspaceId", "brandId", "createdAt");
