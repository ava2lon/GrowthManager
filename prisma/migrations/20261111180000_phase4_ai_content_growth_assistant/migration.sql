ALTER TABLE "Brand"
  ADD COLUMN IF NOT EXISTS "industry" TEXT,
  ADD COLUMN IF NOT EXISTS "targetAudience" TEXT;

CREATE TABLE IF NOT EXISTS "WorkspaceAISettings" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'OPENAI',
  "model" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  "monthlyRequestLimit" INTEGER NOT NULL DEFAULT 100,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceAISettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceAISettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceAISettings_workspaceId_key" ON "WorkspaceAISettings"("workspaceId");

CREATE TABLE IF NOT EXISTS "WorkspaceAIUsage" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "requestsUsed" INTEGER NOT NULL DEFAULT 0,
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DECIMAL(12,6),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceAIUsage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceAIUsage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceAIUsage_workspaceId_periodStart_key" ON "WorkspaceAIUsage"("workspaceId","periodStart");
CREATE INDEX IF NOT EXISTS "WorkspaceAIUsage_workspaceId_periodStart_idx" ON "WorkspaceAIUsage"("workspaceId","periodStart");

CREATE TABLE IF NOT EXISTS "AIGeneration" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "brandId" TEXT NOT NULL,
  "campaignId" TEXT,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'SUCCEEDED',
  "request" JSONB NOT NULL,
  "result" JSONB,
  "promptTokens" INTEGER,
  "completionTokens" INTEGER,
  "totalTokens" INTEGER,
  "costUsd" DECIMAL(12,6),
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AIGeneration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AIGeneration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AIGeneration_workspaceId_brandId_fkey" FOREIGN KEY ("workspaceId","brandId") REFERENCES "Brand"("workspaceId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AIGeneration_workspaceId_campaignId_fkey" FOREIGN KEY ("workspaceId","campaignId") REFERENCES "Campaign"("workspaceId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AIGeneration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AIGeneration_workspaceId_id_key" ON "AIGeneration"("workspaceId","id");
CREATE INDEX IF NOT EXISTS "AIGeneration_workspaceId_brandId_createdAt_idx" ON "AIGeneration"("workspaceId","brandId","createdAt");
CREATE INDEX IF NOT EXISTS "AIGeneration_workspaceId_userId_createdAt_idx" ON "AIGeneration"("workspaceId","userId","createdAt");
CREATE INDEX IF NOT EXISTS "AIGeneration_workspaceId_campaignId_createdAt_idx" ON "AIGeneration"("workspaceId","campaignId","createdAt");
