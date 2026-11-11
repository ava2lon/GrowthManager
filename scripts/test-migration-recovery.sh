#!/usr/bin/env bash
set -euo pipefail

: "${DIRECT_URL:?DIRECT_URL must point to the disposable PostgreSQL test database}"

psql "$DIRECT_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "User" ("id", "email", "passwordHash", "createdAt", "updatedAt")
VALUES ('migration-recovery-user', 'migration-recovery@example.invalid', 'ci-only-hash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Workspace" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('migration-recovery-workspace', 'Migration Recovery Fixture', 'migration-recovery-fixture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Brand" ("id", "workspaceId", "name", "status", "createdAt", "updatedAt")
VALUES ('migration-recovery-brand', 'migration-recovery-workspace', 'Recovery Fixture Brand', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Campaign" ("id", "workspaceId", "brandId", "name", "status", "createdAt", "updatedAt")
VALUES ('migration-recovery-campaign', 'migration-recovery-workspace', 'migration-recovery-brand', 'Recovery Fixture Campaign', 'PLANNING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "ContentPost" ("id", "workspaceId", "brandId", "body", "status", "createdAt", "updatedAt")
VALUES ('migration-recovery-content', 'migration-recovery-workspace', 'migration-recovery-brand', 'Preservation fixture', 'DRAFT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Integration" ("id", "workspaceId", "provider", "name", "status", "createdAt", "updatedAt")
VALUES ('migration-recovery-integration', 'migration-recovery-workspace', 'MIGRATION_RECOVERY_TEST', 'Recovery Fixture Integration', 'DISCONNECTED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
SQL

migration_dirs=(
  20261108120000_n8n_execution_sync_cursor
  20261108123000_automation_alert_fair_scheduler
  20261108230000_social_analytics_retry_ledger
  20261111130000_bounded_automation_alert_escalations
  20261111150000_bounded_social_incident_escalations
  20261111170000_phase3_content_campaign_management
  20261111180000_phase4_ai_content_growth_assistant
  20261111190000_website_tracking
)

for pass in 1 2; do
  for migration in "${migration_dirs[@]}"; do
    psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f "prisma/migrations/$migration/migration.sql"
  done
done

psql "$DIRECT_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM "User" WHERE "id" = 'migration-recovery-user') <> 1 THEN
    RAISE EXCEPTION 'User fixture was not preserved';
  END IF;
  IF (SELECT COUNT(*) FROM "Workspace" WHERE "id" = 'migration-recovery-workspace') <> 1 THEN
    RAISE EXCEPTION 'Workspace fixture was not preserved';
  END IF;
  IF (SELECT COUNT(*) FROM "Brand" WHERE "id" = 'migration-recovery-brand') <> 1 THEN
    RAISE EXCEPTION 'Brand fixture was not preserved';
  END IF;
  IF (SELECT COUNT(*) FROM "Campaign" WHERE "id" = 'migration-recovery-campaign') <> 1 THEN
    RAISE EXCEPTION 'Campaign fixture was not preserved';
  END IF;
  IF (SELECT COUNT(*) FROM "ContentPost" WHERE "id" = 'migration-recovery-content') <> 1 THEN
    RAISE EXCEPTION 'Content fixture was not preserved';
  END IF;
  IF (SELECT COUNT(*) FROM "Integration" WHERE "id" = 'migration-recovery-integration') <> 1 THEN
    RAISE EXCEPTION 'Integration fixture was not preserved';
  END IF;
END $$;
SQL

echo "Migration replay and populated-data preservation checks passed."
