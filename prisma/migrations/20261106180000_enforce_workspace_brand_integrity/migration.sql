-- Backfill workspace ownership from each existing brand before enforcing composite relations.
ALTER TABLE "SocialAccount" ADD COLUMN "workspaceId" TEXT;
UPDATE "SocialAccount" AS child
SET "workspaceId" = brand."workspaceId"
FROM "Brand" AS brand
WHERE child."brandId" = brand."id";
ALTER TABLE "SocialAccount" ALTER COLUMN "workspaceId" SET NOT NULL;

ALTER TABLE "ContentPost" ADD COLUMN "workspaceId" TEXT;
UPDATE "ContentPost" AS child
SET "workspaceId" = brand."workspaceId"
FROM "Brand" AS brand
WHERE child."brandId" = brand."id";
ALTER TABLE "ContentPost" ALTER COLUMN "workspaceId" SET NOT NULL;

-- A composite unique key is required as the target of workspace-scoped foreign keys.
CREATE UNIQUE INDEX "Brand_workspaceId_id_key" ON "Brand"("workspaceId", "id");

-- Replace brand-only references with workspace + brand references.
ALTER TABLE "SocialAccount" DROP CONSTRAINT "SocialAccount_brandId_fkey";
ALTER TABLE "ContentPost" DROP CONSTRAINT "ContentPost_brandId_fkey";
ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_brandId_fkey";

DROP INDEX "SocialAccount_brandId_provider_idx";
DROP INDEX "ContentPost_brandId_status_scheduledAt_idx";

ALTER TABLE "SocialAccount"
  ADD CONSTRAINT "SocialAccount_workspaceId_brandId_fkey"
  FOREIGN KEY ("workspaceId", "brandId")
  REFERENCES "Brand"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentPost"
  ADD CONSTRAINT "ContentPost_workspaceId_brandId_fkey"
  FOREIGN KEY ("workspaceId", "brandId")
  REFERENCES "Brand"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict brand deletion while a campaign references it. This avoids a composite
-- SET NULL operation accidentally nulling the campaign's required workspaceId.
ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_workspaceId_brandId_fkey"
  FOREIGN KEY ("workspaceId", "brandId")
  REFERENCES "Brand"("workspaceId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "SocialAccount_workspaceId_brandId_provider_idx"
  ON "SocialAccount"("workspaceId", "brandId", "provider");
CREATE INDEX "ContentPost_workspaceId_brandId_status_scheduledAt_idx"
  ON "ContentPost"("workspaceId", "brandId", "status", "scheduledAt");
