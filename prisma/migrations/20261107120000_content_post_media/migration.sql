CREATE TABLE "ContentPostMedia" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "contentPostId" TEXT NOT NULL,
  "mediaAssetId" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContentPostMedia_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContentPostMedia_workspaceId_contentPostId_fkey" FOREIGN KEY ("workspaceId", "contentPostId") REFERENCES "ContentPost"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ContentPostMedia_workspaceId_mediaAssetId_fkey" FOREIGN KEY ("workspaceId", "mediaAssetId") REFERENCES "MediaAsset"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ContentPostMedia_workspaceId_contentPostId_mediaAssetId_key" ON "ContentPostMedia"("workspaceId", "contentPostId", "mediaAssetId");
CREATE UNIQUE INDEX "ContentPostMedia_workspaceId_contentPostId_position_key" ON "ContentPostMedia"("workspaceId", "contentPostId", "position");
CREATE INDEX "ContentPostMedia_workspaceId_mediaAssetId_idx" ON "ContentPostMedia"("workspaceId", "mediaAssetId");
