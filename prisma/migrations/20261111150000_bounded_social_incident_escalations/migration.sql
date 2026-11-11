ALTER TABLE "WorkspaceIncident"
ADD COLUMN IF NOT EXISTS "escalationRecipientCursor" TEXT;

CREATE INDEX IF NOT EXISTS "workspace_incident_escalation_due_idx"
ON "WorkspaceIncident" ("status", "escalatedAt", "firstSeenAt", "id");
