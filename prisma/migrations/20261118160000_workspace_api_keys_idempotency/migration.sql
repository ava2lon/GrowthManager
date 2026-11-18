CREATE TABLE "WorkspaceApiKey" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "keyPrefix" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "lastUsedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceApiKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApiIdempotencyRecord" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  "responseStatus" INTEGER,
  "responseBody" JSONB,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApiIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceApiKey_keyPrefix_key" ON "WorkspaceApiKey"("keyPrefix");
CREATE UNIQUE INDEX "WorkspaceApiKey_keyHash_key" ON "WorkspaceApiKey"("keyHash");
CREATE UNIQUE INDEX "WorkspaceApiKey_workspaceId_id_key" ON "WorkspaceApiKey"("workspaceId", "id");
CREATE INDEX "WorkspaceApiKey_workspaceId_revokedAt_createdAt_idx" ON "WorkspaceApiKey"("workspaceId", "revokedAt", "createdAt");
CREATE INDEX "WorkspaceApiKey_expiresAt_revokedAt_idx" ON "WorkspaceApiKey"("expiresAt", "revokedAt");
CREATE UNIQUE INDEX "api_idempotency_workspace_key_method_route" ON "ApiIdempotencyRecord"("workspaceId", "idempotencyKey", "method", "route");
CREATE INDEX "ApiIdempotencyRecord_workspaceId_expiresAt_idx" ON "ApiIdempotencyRecord"("workspaceId", "expiresAt");

ALTER TABLE "WorkspaceApiKey"
  ADD CONSTRAINT "WorkspaceApiKey_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceApiKey"
  ADD CONSTRAINT "WorkspaceApiKey_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApiIdempotencyRecord"
  ADD CONSTRAINT "ApiIdempotencyRecord_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
