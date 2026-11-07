CREATE TABLE "N8nExecutionSnapshot" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "workflowId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3),
  "stoppedAt" TIMESTAMP(3),
  "waitTill" TIMESTAMP(3),
  "retryOf" TEXT,
  "retrySuccessId" TEXT,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "N8nExecutionSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "N8nExecutionSnapshot_workspaceId_integrationId_fkey"
    FOREIGN KEY ("workspaceId", "integrationId")
    REFERENCES "Integration"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "N8nExecutionSnapshot_workspaceId_integrationId_executionId_key"
  ON "N8nExecutionSnapshot"("workspaceId", "integrationId", "executionId");
CREATE INDEX "N8nExecutionSnapshot_workspaceId_startedAt_idx"
  ON "N8nExecutionSnapshot"("workspaceId", "startedAt");
CREATE INDEX "N8nExecutionSnapshot_workspaceId_integrationId_status_startedAt_idx"
  ON "N8nExecutionSnapshot"("workspaceId", "integrationId", "status", "startedAt");
CREATE INDEX "N8nExecutionSnapshot_workspaceId_workflowId_startedAt_idx"
  ON "N8nExecutionSnapshot"("workspaceId", "workflowId", "startedAt");
