CREATE TABLE "AutomationAlertPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "failureCountThreshold" INTEGER NOT NULL DEFAULT 3,
    "failureRateThreshold" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "lookbackMinutes" INTEGER NOT NULL DEFAULT 1440,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AutomationAlertPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutomationAlertEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'n8n',
    "alertType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARNING',
    "dedupeKey" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "observedCount" INTEGER NOT NULL,
    "observedRate" DOUBLE PRECISION NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "lastNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationAlertEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AutomationAlertPolicy_workspaceId_key" ON "AutomationAlertPolicy"("workspaceId");
CREATE UNIQUE INDEX "AutomationAlertEvent_workspaceId_dedupeKey_key" ON "AutomationAlertEvent"("workspaceId", "dedupeKey");
CREATE INDEX "AutomationAlertEvent_workspaceId_status_createdAt_idx" ON "AutomationAlertEvent"("workspaceId", "status", "createdAt");
CREATE INDEX "AutomationAlertEvent_workspaceId_integrationId_createdAt_idx" ON "AutomationAlertEvent"("workspaceId", "integrationId", "createdAt");

ALTER TABLE "AutomationAlertPolicy" ADD CONSTRAINT "AutomationAlertPolicy_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationAlertEvent" ADD CONSTRAINT "AutomationAlertEvent_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
