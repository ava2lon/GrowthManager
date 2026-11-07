ALTER TABLE "WorkspaceNotificationPreference"
  ADD COLUMN "inAppSocialIncidents" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "emailSocialIncidents" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX "WorkspaceIncident_workspaceId_id_key" ON "WorkspaceIncident"("workspaceId","id");

CREATE TABLE "WorkspaceIncidentEmailDelivery" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "incidentId" TEXT NOT NULL,
  "recipientUserId" TEXT NOT NULL,
  "recipientEmail" TEXT NOT NULL,
  "incidentOccurrence" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "providerMessageId" TEXT,
  "lastErrorCode" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceIncidentEmailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceIncidentEmailDelivery_workspaceId_incidentId_recipientUserId_incidentOccurrence_eventType_key"
ON "WorkspaceIncidentEmailDelivery"("workspaceId","incidentId","recipientUserId","incidentOccurrence","eventType");
CREATE INDEX "WorkspaceIncidentEmailDelivery_status_nextAttemptAt_idx"
ON "WorkspaceIncidentEmailDelivery"("status","nextAttemptAt");
CREATE INDEX "WorkspaceIncidentEmailDelivery_workspaceId_createdAt_idx"
ON "WorkspaceIncidentEmailDelivery"("workspaceId","createdAt");
CREATE INDEX "WorkspaceIncidentEmailDelivery_providerMessageId_idx"
ON "WorkspaceIncidentEmailDelivery"("providerMessageId");

ALTER TABLE "WorkspaceIncidentEmailDelivery"
  ADD CONSTRAINT "WorkspaceIncidentEmailDelivery_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceIncidentEmailDelivery"
  ADD CONSTRAINT "WorkspaceIncidentEmailDelivery_workspaceId_incidentId_fkey"
  FOREIGN KEY ("workspaceId","incidentId") REFERENCES "WorkspaceIncident"("workspaceId","id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceIncidentEmailDelivery"
  ADD CONSTRAINT "WorkspaceIncidentEmailDelivery_recipientUserId_fkey"
  FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
