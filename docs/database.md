# Database architecture

## Engine and ORM

GrowthManager uses PostgreSQL with Prisma 6. The canonical schema is prisma/schema.prisma and committed migrations live in prisma/migrations.

## Current domain models

The schema currently includes identity/workspace membership, invitations, brands, social accounts, content posts and revisions, content review, campaigns, media assets/folders, social publication targets and attempts, integrations, automations, tasks, activity logs, notifications, provider analytics snapshots, incidents, and AI usage/generation records.

Phase 2 adds Website, WebsiteVisitor, WebsiteSession, WebsiteEvent, and WebsiteIdentity. Lead, Contact, Conversion, ApiKey, generic Webhook, and WebhookDelivery models remain unimplemented. Website-owned records are linked through Website and use website-scoped compound unique keys for visitor/session identity.

## Tenant integrity

Workspace-owned models carry workspaceId. Prefer indexes beginning with workspaceId for tenant-scoped access patterns. Use compound unique keys and composite relations when a child references another workspace-owned record. A foreign key on a globally unique child ID alone does not prove both records belong to the same tenant.

Every service query must still include workspaceId from the authenticated server-side membership context. Database constraints complement authorization; they do not replace it.

## Migration operations

Local development:
- npm run db:generate
- npm run db:migrate

Production:
- Confirm DATABASE_URL and DIRECT_URL target the intended managed database.
- Inspect migration status with npm run db:status.
- Apply committed migrations with npm run db:deploy.

Do not use prisma db push for production schema changes. Never run destructive schema operations against production to resolve migration drift. Database migrations must be additive where practical, include safe backfills for existing rows, and be tested against a disposable PostgreSQL database.

## Connection configuration

DATABASE_URL is the serverless runtime connection (Supabase transaction pooler). DIRECT_URL is the direct/session-pooler connection used by Prisma migrations. Keep both server-only and never expose either through NEXT_PUBLIC variables.
