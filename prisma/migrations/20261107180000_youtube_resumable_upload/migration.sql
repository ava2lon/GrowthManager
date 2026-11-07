-- Durable YouTube resumable-upload state. The session URI is encrypted at application level.
ALTER TABLE "SocialPostTarget"
  ADD COLUMN "uploadSessionEncrypted" TEXT,
  ADD COLUMN "uploadOffset" BIGINT,
  ADD COLUMN "uploadTotalBytes" BIGINT,
  ADD COLUMN "uploadMetadata" JSONB;

CREATE INDEX "SocialPostTarget_provider_status_nextCheckAt_idx"
  ON "SocialPostTarget"("provider", "status", "nextCheckAt");
