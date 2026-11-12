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
DO $recovery$
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
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Brand' AND column_name='industry') THEN
    RAISE EXCEPTION 'Brand.industry missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Brand' AND column_name='targetAudience') THEN
    RAISE EXCEPTION 'Brand.targetAudience missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ContentPost' AND column_name='archivedAt') THEN
    RAISE EXCEPTION 'ContentPost.archivedAt missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='AutomationAlertEvent' AND column_name='escalationRecipientCursor') THEN
    RAISE EXCEPTION 'AutomationAlertEvent.escalationRecipientCursor missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Integration' AND column_name='lastExecutionSyncCursor') THEN
    RAISE EXCEPTION 'Integration.lastExecutionSyncCursor missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='SocialAnalyticsRetry') OR
     NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='MediaFolder') OR
     NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='CampaignSocialAccount') OR
     NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='WorkspaceAISettings') OR
     NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='WorkspaceAIUsage') OR
     NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='AIGeneration') OR
     NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='Website') OR
     NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='WebsiteVisitor') OR
     NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='WebsiteSession') OR
     NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='WebsiteEvent') OR
     NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='WebsiteIdentity') THEN
    RAISE EXCEPTION 'One or more required feature tables are missing';
  END IF;
  IF EXISTS (
    SELECT expected.index_name
    FROM unnest(ARRAY[
      'AutomationAlertPolicy_enabled_lastEvaluatedAt_idx',
      'automation_alert_policy_escalation_idx',
      'automation_alert_escalation_due_idx',
      'workspace_incident_escalation_due_idx',
      'SocialAnalyticsRetry_workspaceId_provider_subjectType_subjectId_reportDate_key',
      'SocialAnalyticsRetry_status_nextAttemptAt_idx',
      'SocialAnalyticsRetry_workspaceId_status_nextAttemptAt_idx',
      'ContentPost_workspaceId_workflowStatus_createdAt_idx',
      'ContentPost_workspaceId_campaignId_idx',
      'ContentPost_workspaceId_archivedAt_updatedAt_idx',
      'Campaign_workspaceId_id_key',
      'MediaFolder_workspaceId_id_key',
      'MediaFolder_workspaceId_brandId_name_key',
      'MediaFolder_workspaceId_createdAt_idx',
      'MediaAsset_workspaceId_folderId_createdAt_idx',
      'CampaignSocialAccount_workspaceId_campaignId_socialAccountId_key',
      'CampaignSocialAccount_workspaceId_socialAccountId_idx',
      'WorkspaceAISettings_workspaceId_key',
      'WorkspaceAIUsage_workspaceId_periodStart_key',
      'WorkspaceAIUsage_workspaceId_periodStart_idx',
      'AIGeneration_workspaceId_id_key',
      'AIGeneration_workspaceId_brandId_createdAt_idx',
      'AIGeneration_workspaceId_userId_createdAt_idx',
      'AIGeneration_workspaceId_campaignId_createdAt_idx',
      'Website_trackingId_key',
      'Website_workspaceId_domain_key',
      'Website_workspaceId_id_key',
      'Website_workspaceId_status_createdAt_idx',
      'Website_workspaceId_updatedAt_idx',
      'WebsiteVisitor_websiteId_anonymousId_key',
      'WebsiteVisitor_websiteId_id_key',
      'WebsiteVisitor_websiteId_lastSeenAt_idx',
      'WebsiteSession_websiteId_sessionId_key',
      'WebsiteSession_websiteId_id_key',
      'WebsiteSession_websiteId_startedAt_idx',
      'WebsiteSession_websiteId_visitorId_startedAt_idx',
      'WebsiteEvent_websiteId_timestamp_idx',
      'WebsiteEvent_websiteId_eventName_timestamp_idx',
      'WebsiteEvent_websiteId_visitorId_timestamp_idx',
      'WebsiteEvent_websiteId_sessionId_timestamp_idx',
      'WebsiteEvent_websiteId_eventType_timestamp_idx',
      'WebsiteIdentity_websiteId_visitorId_key',
      'WebsiteIdentity_websiteId_email_idx'
    ]) AS expected(index_name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=expected.index_name)
  ) THEN
    RAISE EXCEPTION 'One or more expected recovery indexes are missing';
  END IF;
  IF EXISTS (
    SELECT expected.constraint_name
    FROM unnest(ARRAY[
      'SocialAnalyticsRetry_workspaceId_fkey',
      'ContentPost_workspaceId_campaignId_fkey',
      'ContentPost_authorId_fkey',
      'MediaFolder_workspaceId_fkey',
      'MediaFolder_workspaceId_brandId_fkey',
      'MediaAsset_workspaceId_folderId_fkey',
      'CampaignSocialAccount_workspaceId_campaignId_fkey',
      'CampaignSocialAccount_workspaceId_socialAccountId_fkey',
      'WorkspaceAISettings_workspaceId_fkey',
      'WorkspaceAIUsage_workspaceId_fkey',
      'AIGeneration_workspaceId_fkey',
      'AIGeneration_workspaceId_brandId_fkey',
      'AIGeneration_workspaceId_campaignId_fkey',
      'AIGeneration_userId_fkey',
      'Website_workspaceId_fkey',
      'WebsiteVisitor_websiteId_fkey',
      'WebsiteSession_websiteId_fkey',
      'WebsiteSession_websiteId_visitorId_fkey',
      'WebsiteEvent_websiteId_fkey',
      'WebsiteEvent_websiteId_visitorId_fkey',
      'WebsiteEvent_websiteId_sessionId_fkey',
      'WebsiteIdentity_websiteId_fkey',
      'WebsiteIdentity_websiteId_visitorId_fkey'
    ]) AS expected(constraint_name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=expected.constraint_name)
  ) THEN
    RAISE EXCEPTION 'One or more expected recovery foreign keys are missing';
  END IF;
END $recovery$;
SQL

echo "Migration replay and populated-data preservation checks passed."
