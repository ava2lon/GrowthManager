# Production database schema drift recovery

**Scope:** GrowthManager production PostgreSQL, inspected read-only on 2026-11-11. No production DDL, migration resolution, or data writes were performed during this audit.

## Verified migration state

The latest successful row in `public._prisma_migrations` is:

`20261108113000_social_incident_acknowledgement`

The repository contains eight later migrations:

1. `20261108120000_n8n_execution_sync_cursor`
2. `20261108123000_automation_alert_fair_scheduler`
3. `20261108230000_social_analytics_retry_ledger`
4. `20261111130000_bounded_automation_alert_escalations`
5. `20261111150000_bounded_social_incident_escalations`
6. `20261111170000_phase3_content_campaign_management`
7. `20261111180000_phase4_ai_content_growth_assistant`
8. `20261111190000_website_tracking`

These migration names were absent from the inspected migration history. The migration sequence is not simply the three feature migrations: the four operational migrations before Phase 3 must also be accounted for.

## Confirmed schema drift

Read-only inspection of `information_schema`, `pg_type`, and `_prisma_migrations` confirmed:

| Object | Expected effect | Live state |
|---|---|---|
| `Integration.lastExecutionSyncCursor` | n8n sync cursor | Missing |
| `AutomationAlertPolicy.lastEvaluatedAt` | fair scheduler timestamp | Present |
| `AutomationAlertPolicy.lastEscalationAt` | bounded escalation timestamp | Present |
| `AutomationAlertEvent.escalationRecipientCursor` | escalation recipient cursor | Missing |
| `AutomationAlertEvent.escalatedAt` | escalation timestamp | Missing |
| `WorkspaceIncident.escalationRecipientCursor` | incident escalation cursor | Missing |
| `SocialAnalyticsRetry` | retry ledger table | Missing |
| Phase 3 ContentPost fields | content workflow and archive metadata | Missing |
| Phase 3 Campaign fields | description, budget, audience | Missing |
| `MediaFolder` | media folder table | Missing |
| `CampaignSocialAccount` | campaign/account join table | Missing |
| MediaAsset folder metadata | folderId, tags, url | Missing |
| `Brand.industry` and `Brand.targetAudience` | Phase 4 brand context | **Present already** |
| `WorkspaceAISettings`, `WorkspaceAIUsage`, `AIGeneration` | Phase 4 AI persistence | Missing |
| Website tracking enum and five tables | website analytics | Missing |

The current production error digests independently reported missing `ContentPost.archivedAt`, `MediaFolder`, `Campaign.description`, `AutomationAlertEvent.escalationRecipientCursor`, and `Integration.lastExecutionSyncCursor`. The website table failure was also observed in runtime errors.

## Duplicate-object hazards

- Phase 4 originally attempted to add `Brand.industry` and `Brand.targetAudience`, although both columns already exist in production.
- `AutomationAlertPolicy.lastEvaluatedAt` and `lastEscalationAt` also exist even though the migrations that introduce them are absent from the recorded migration history.
- This is evidence of partial schema application / migration-history drift. It is not safe to infer that an absent migration record means every statement in that migration is absent.
- The later migration SQL is now guarded for repeatable additions: enums, columns, tables, indexes, and named foreign-key constraints use existence checks. These guards avoid duplicate-object failures while allowing missing objects to be created.
- `CREATE TABLE IF NOT EXISTS` does not repair an already-existing but structurally incomplete table. The current inspection found the newly introduced Phase 3/4/website tables absent, so the guarded create path is applicable to those tables. Re-run the full schema audit before production approval.

## Data preservation

The recovery migrations only add schema objects and preserve the existing rows. The Phase 3 migration retains its existing MediaAsset URL backfill for rows where `url IS NULL`; it does not overwrite non-null URLs. No `DROP`, `TRUNCATE`, table replacement, or destructive type conversion is part of this recovery.

## Required pre-deployment checks

1. Confirm the Supabase project and production database target.
2. Take a fresh managed backup / PITR restore point and verify its completion and restore availability. Record its timestamp and identifier in the change record.
3. Confirm no other migration process is running.
4. Run `npx prisma migrate status` against the production migration connection and save the output.
5. Run the read-only schema audit again. Verify existing Brand and AutomationAlertPolicy columns and check all indexes / constraints by definition, not name alone.
6. Review every pending migration diff in this branch.
7. Obtain the GitHub `production-migrations` environment approval from an authorized reviewer.
8. Dispatch `.github/workflows/production-migrations.yml` only after the backup verification is explicitly attested.
9. After migration deploy, rerun the schema audit, `npx prisma migrate status`, and the production smoke tests for login, workspace dashboard, brands, content/campaigns, AI settings, and website tracking.

## Failure and rollback procedure

- The migration workflow stops on the first SQL error (`ON_ERROR_STOP` / Prisma failure) and does not mark a failed migration as applied.
- Do not use `prisma migrate resolve --applied` to bypass a failed migration. Do not edit `_prisma_migrations` manually.
- Preserve the failed migration logs and inspect the exact failing statement and live object definition.
- Because these are additive migrations, the preferred recovery is a forward corrective migration after backup verification. Do not automatically roll back by dropping newly created tables or columns.
- If application availability or data integrity is threatened, pause application writes / migration activity and restore using the verified Supabase backup/PITR procedure with the database owner. A restore is a deliberate operator action and is not automated by this workflow.
- Redeploy the last known-good application only if it remains compatible with the database schema. Application rollback does not reverse database migrations.

## CI coverage

The CI migration-recovery test deploys all migrations to a clean PostgreSQL database, inserts representative pre-existing user/workspace/brand/campaign/content/integration rows, replays all eight recovery migrations twice, and asserts the seeded records remain present. This validates clean migration application plus duplicate-safe replay on a populated schema. It is not a substitute for the production preflight, backup, approval, or post-deploy audit.
