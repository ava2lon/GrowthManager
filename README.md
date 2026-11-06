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
Provider credentials are encrypted at rest using AES-256-GCM. Registration and credentials login use Redis-backed rate limits. Configure both Upstash variables in every Vercel environment before enabling production sign-up or sign-in. Add email verification and abuse monitoring before public launch.


### Workspace-scoped brand integrity

The migration `20261106180000_enforce_workspace_brand_integrity` backfills `workspaceId` onto social accounts and content posts, then replaces brand-only foreign keys with composite `(workspaceId, brandId)` constraints. Campaign-to-brand references use the same composite key and restrict brand deletion while a campaign still references it. This makes cross-workspace brand references fail at the PostgreSQL layer, even if an application query is incorrectly scoped.

Apply migrations only after configuring `DATABASE_URL` and `DIRECT_URL` for the GrowthManager Supabase project:

```bash
npm run db:deploy
```

Do not use `prisma db push` for production schema changes. Review migration status and the target database before applying.


### Invitation-based account registration

Recipients who do not yet have a GrowthManager account can create one directly from `/invite/[token]`. Registration requires the exact invited email address, validates the invitation token and expiry, applies the normal password policy, and atomically claims the invitation, creates the user, creates the workspace membership with the invited role, and records the acceptance activity. It does not create a second workspace. Invitation registration is rate-limited by client IP and fails closed in production when the rate-limit store is unavailable. Existing users should sign in with the invited email and accept the invitation from the invitation page.

## Automated tests

Run the unit and policy tests with:

```bash
npm test
```

The PostgreSQL tenant-isolation suite is in `src/lib/tenant-isolation.integration.test.ts`. It is skipped when `DATABASE_URL_TEST` is not set. To enable it, create a **disposable local PostgreSQL database**, apply the committed Prisma migrations to that database, and set:

```bash
export DATABASE_URL_TEST="postgresql://postgres:postgres@localhost:5432/growthmanager_test"
npm run test:integration
```

The integration test guard rejects production mode and non-local database hosts. It creates uniquely named fixtures and deletes only those fixtures. Never point `DATABASE_URL_TEST` at the production GrowthManager database. These tests validate PostgreSQL constraints; they do not replace authorization tests for every server action.



## Integration credential encryption

The `Integration.credentialsEncrypted` column stores versioned AES-256-GCM envelopes, not plaintext JSON. Encryption uses a fresh 96-bit nonce per write and authenticates the workspace and integration IDs as additional authenticated data. The application refuses to encrypt or decrypt credentials when the key is missing or invalid.

Generate a 32-byte key:

```bash
openssl rand -base64 32
```

Configure `INTEGRATION_ENCRYPTION_KEY` and a stable `INTEGRATION_ENCRYPTION_KEY_ID` in Vercel and local secret stores. Never commit a real key or send it through chat. The optional previous-key variables support staged rotation:

1. Set the new key as `INTEGRATION_ENCRYPTION_KEY` with a new key ID.
2. Set the old key as `INTEGRATION_ENCRYPTION_KEY_PREVIOUS` with its former ID.
3. Run the owner-only `rotateWorkspaceIntegrationCredentials()` operation for each workspace.
4. Verify all workspace credentials have been re-encrypted before removing the previous key.

The migration `20261106190000_encrypt_integration_credentials` deliberately aborts if any existing integration row contains non-null plaintext credentials. Export and encrypt such values through a controlled migration process before retrying; do not bypass the guard or apply this migration to a database containing unreviewed credentials.

Only workspace ADMIN/OWNER roles can save or read integration credentials; only OWNER can initiate workspace key rotation. All credential reads and writes include the active workspace ID in their database predicates. Never log decrypted credential objects.


## Integration connection health

The Resend integration supports API-key validation and manual health checks. The health check decrypts credentials only on the server, calls the fixed Resend domains endpoint with a 10-second timeout, and never returns or logs the API key. Checks are workspace-admin-only and rate-limited through Upstash Redis.

Integration records store:
- `lastValidatedAt`: timestamp of the most recent successful provider validation.
- `lastErrorAt`: timestamp of the most recent failed health check.
- `lastErrorCode`: a sanitized classification such as `AUTH_FAILED`, `PROVIDER_RATE_LIMITED`, or `PROVIDER_UNAVAILABLE`; provider response bodies and credentials are not stored.

The migration `20261106200000_integration_health_metadata` adds these fields and a workspace/status index. Apply it with `npm run db:deploy` only after the GrowthManager database environment variables are configured and the migration target has been verified. Other catalog providers remain setup placeholders until their provider-specific authorization and lifecycle flows are implemented.

## n8n workspace integration

Workspace owners and administrators can connect an n8n instance using an n8n public API key. GrowthManager validates the connection with `GET /api/v1/workflows?limit=1` and the `X-N8N-API-KEY` header, then stores the base URL and API key in the workspace's AES-256-GCM encrypted credential envelope. Workflow definitions and execution data are not copied into GrowthManager by the connection health check.

n8n Cloud hostnames matching `<instance>.app.n8n.cloud` are accepted by default. Self-hosted n8n instances require the platform operator to set `N8N_ALLOWED_HOSTS` to a comma-separated list of exact hostnames (no URL scheme, port, path, or wildcard). This restriction prevents a workspace administrator from using the integration as an arbitrary server-side HTTP request/SSRF primitive. The connection uses HTTPS only, rejects redirects, and has a 10-second timeout.

To create an API key in n8n, open **Settings → n8n API → Create an API key**. Use the minimum available workflow-list/read scope for health validation. n8n API access is not available during the free Cloud trial; self-hosted instances provide API access according to the n8n plan and configuration.

The integration supports manual health checks and stores only sanitized status metadata. Workflow discovery, activation/deactivation, execution monitoring, and webhook management are separate capabilities and are not enabled by this initial connection release.
