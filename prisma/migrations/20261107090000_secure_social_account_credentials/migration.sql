-- Remove legacy plaintext token columns before any OAuth connection flow is introduced.
ALTER TABLE "SocialAccount"
  DROP COLUMN "accessToken",
  DROP COLUMN "refreshToken",
  ADD COLUMN "credentialsEncrypted" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
  ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "connectedAt" TIMESTAMP(3),
  ADD COLUMN "lastValidatedAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorCode" TEXT;

ALTER TYPE "SocialProvider" ADD VALUE IF NOT EXISTS 'THREADS';
ALTER TYPE "SocialProvider" ADD VALUE IF NOT EXISTS 'SNAPCHAT';
ALTER TYPE "SocialProvider" ADD VALUE IF NOT EXISTS 'REDDIT';
ALTER TYPE "SocialProvider" ADD VALUE IF NOT EXISTS 'TELEGRAM';

CREATE UNIQUE INDEX "SocialAccount_workspaceId_provider_providerUserId_key"
  ON "SocialAccount"("workspaceId", "provider", "providerUserId");
CREATE INDEX "SocialAccount_workspaceId_provider_status_idx"
  ON "SocialAccount"("workspaceId", "provider", "status");
