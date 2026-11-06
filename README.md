# GrowthManager

Multi-tenant SaaS workspace for growth, marketing, social media, websites, and automation.

## Stack
Next.js App Router, TypeScript, Tailwind CSS, PostgreSQL, Prisma, Auth.js credentials authentication, and Vercel.

## Phase 1 foundation
Responsive public page and dashboard; bcrypt password hashing; account registration creates a workspace and OWNER membership transactionally; multi-tenant data schema for brands, social accounts, content, campaigns, integrations, automations, tasks, and activity logs; protected dashboard routes.

External publishing, AI providers, billing, and automation execution are staged for later phases and are not represented as live integrations.

## Setup
Use Node.js 20.9+ and PostgreSQL. Copy .env.example to .env and configure DATABASE_URL, AUTH_SECRET, and AUTH_URL. Run npm install, npm run db:generate, npm run db:migrate, then npm run dev.

## Vercel
Set DATABASE_URL to a managed PostgreSQL connection string, AUTH_SECRET to a cryptographically random 32+ byte secret, AUTH_URL to the canonical deployment URL, and UPSTASH_REDIS_REST_URL plus UPSTASH_REDIS_REST_TOKEN from an Upstash Redis database. Configure the database before enabling account registration. Use committed Prisma migrations for production schema changes. Configure `DIRECT_URL` for Prisma migration connections (Supabase session pooler on port 5432) and `DATABASE_URL` for serverless runtime queries (transaction pooler on port 6543, with `pgbouncer=true&connection_limit=1`). Apply production migrations with `npm run db:deploy`.

## Workspace invitations
Workspace owners and administrators can invite teammates from `/dashboard/team`. Invitations use random 256-bit tokens; only SHA-256 token hashes are stored in PostgreSQL. Links expire after seven days, are single-use, and require an authenticated account whose normalized email matches the invitation. Owners can invite administrators; administrators can invite members and viewers. Configure `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (a verified Resend sender), and `AUTH_URL` to enable invitation delivery. If email delivery fails, the invitation is revoked. Apply the `20261106170000_workspace_invitations` migration with `npm run db:deploy` after configuring the database.

## Security follow-ups
Encrypt provider credentials at rest before enabling integrations. Registration and credentials login use Redis-backed rate limits. Configure both Upstash variables in every Vercel environment before enabling production sign-up or sign-in. Add email verification and abuse monitoring before public launch.


### Workspace-scoped brand integrity

The migration `20261106180000_enforce_workspace_brand_integrity` backfills `workspaceId` onto social accounts and content posts, then replaces brand-only foreign keys with composite `(workspaceId, brandId)` constraints. Campaign-to-brand references use the same composite key and restrict brand deletion while a campaign still references it. This makes cross-workspace brand references fail at the PostgreSQL layer, even if an application query is incorrectly scoped.

Apply migrations only after configuring `DATABASE_URL` and `DIRECT_URL` for the GrowthManager Supabase project:

```bash
npm run db:deploy
```

Do not use `prisma db push` for production schema changes. Review migration status and the target database before applying.
