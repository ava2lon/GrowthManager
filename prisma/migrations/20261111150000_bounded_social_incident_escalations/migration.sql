ALTER TABLE "WorkspaceIncident"
ADD COLUMN "escalationRecipientCursor" TEXT;

CREATE INDEX "workspace_incident_escalation_due_idx"
ON "WorkspaceIncident" ("status", "escalatedAt", "firstSeenAt", "id");
