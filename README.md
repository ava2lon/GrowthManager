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

## n8n workspace integration

Workspace owners and administrators can connect an n8n instance using an n8n public API key. GrowthManager validates the connection with `GET /api/v1/workflows?limit=1` and the `X-N8N-API-KEY` header, then stores the base URL and API key in the workspace's AES-256-GCM encrypted credential envelope. Workflow definitions and execution data are not copied into GrowthManager by the connection health check.

n8n Cloud hostnames matching `<instance>.app.n8n.cloud` are accepted by default. Self-hosted n8n instances require the platform operator to set `N8N_ALLOWED_HOSTS` to a comma-separated list of exact hostnames (no URL scheme, port, path, or wildcard). The integration uses HTTPS only, rejects redirects, and has a 10-second timeout. The host restriction prevents workspace administrators from turning this feature into a general-purpose server-side request proxy.

To create an API key in n8n, open **Settings → n8n API → Create an API key**. Use the minimum available workflow-list/read scope for health validation. n8n API access is not available during the free Cloud trial; self-hosted instances provide API access according to the n8n plan and configuration.

The integration supports manual health checks and stores only sanitized status metadata. Workflow discovery, activation/deactivation, execution monitoring, and webhook management are separate capabilities and are not enabled by this initial connection release.


## Automation alert evaluation

The automation health dashboard supports workspace-scoped n8n alert policies and a persisted alert history. Owners and admins can configure failure-count and failure-rate thresholds, the lookback window, and event deduplication cooldown. Manual evaluation is available from `/dashboard/automations`.

A protected Vercel Cron endpoint is configured at `/api/cron/automation-alerts` and scheduled daily at 06:00 UTC. The endpoint:
- Requires `Authorization: Bearer <CRON_SECRET>` and rejects missing or short secrets.
- Evaluates up to 50 enabled workspace policies per invocation.
- Reads n8n credentials only from encrypted workspace integration records.
- Stores events using a workspace-scoped unique deduplication key.
- Records an audit activity for each successfully evaluated workspace.
- Returns only aggregate counts; provider errors and workspace identifiers are not returned.

Set `CRON_SECRET` in the Vercel Production environment and redeploy to activate scheduled evaluation. Generate a random secret locally (for example, `openssl rand -hex 32`) and do not commit it or paste it into chat. Vercel Cron invokes production deployments only. The daily schedule is compatible with Vercel Hobby's once-per-day restriction; higher-frequency schedules require a plan that supports them. Cron runs use UTC.

Email delivery is available as an explicit workspace opt-in:
- Connect the workspace's **Resend** integration and provide an email address on a domain verified in that Resend account. The API key and sender identity are encrypted with the workspace/integration-bound credential envelope.
- In Automation Health, enable **Email notifications** and configure one recipient address. Email remains disabled by default; no workspace members are automatically subscribed.
- Newly created, deduplicated alert events are atomically written to a tenant-scoped email outbox. Existing deduplicated events are not re-emailed.
- The dispatcher sends through the workspace's own Resend API key, uses a deterministic `Idempotency-Key`, stores the provider message ID, and records status, attempts, and sanitized error codes.
- Transient network, HTTP 429, and HTTP 5xx failures are retried up to three attempts with backoff. Permanent provider/configuration errors are marked failed. Retries older than 20 hours are stopped to stay inside the provider idempotency retention window and avoid duplicate messages.
- Manual evaluation dispatches a small batch immediately. The daily Cron also dispatches a bounded batch, so retries may wait until the next invocation on plans restricted to daily Cron schedules. The dashboard shows the latest 25 send records. A `SENT` status means Resend accepted the API request. To track subsequent outcomes, configure a Resend webhook targeting `/api/webhooks/resend`, subscribe to `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`, and `email.failed`, then save that webhook's `whsec_` signing secret in the Resend integration settings. Webhook signatures are verified against the raw request body with a five-minute replay window; provider event IDs are deduplicated, and only the matching tenant's delivery record can be updated. The dashboard then distinguishes accepted, delivered, delayed, bounced, complained, and failed states.

Email notifications are transactional operational alerts, not marketing messages. Slack delivery is not implemented. Vercel does not automatically retry failed Cron invocations, so inspect Cron invocation logs and the aggregate failure response when diagnosing missed evaluations.


## Media library and storage

The media library at `/dashboard/media` stores workspace-scoped metadata in PostgreSQL and file bytes in a **private Supabase Storage bucket**. Browser uploads use short-lived signed upload URLs; the Supabase service-role key remains server-only. Upload initialization and completion are authenticated, workspace-scoped, rate-limited, and audited. The completion endpoint verifies the stored object's size and MIME type before marking the asset `READY`.

When configuring storage:
1. Create a **private** Supabase Storage bucket named `growthmanager-media` (or set `SUPABASE_MEDIA_BUCKET` to another valid bucket name).
2. Set the bucket's maximum file size to at least 100 MB and restrict allowed MIME types to `image/jpeg`, `image/png`, `image/webp`, `video/mp4`, and `video/quicktime`.
3. Add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and optionally `SUPABASE_MEDIA_BUCKET` to the server-side Vercel environment. Never use a `NEXT_PUBLIC_` prefix for the service-role key.
4. Apply the committed Prisma migration `20261107110000_media_assets` only after the GrowthManager database target and connection variables have been confirmed.

Application limits are 20 MB per image and 100 MB per video. Supported formats are JPEG, PNG, WebP, MP4, and MOV. Files are organized under a workspace-specific object prefix, and downloads are issued as five-minute signed URLs after membership and workspace ownership checks. The bucket must remain private; do not enable public object access.


### Media attachments on social drafts

The Facebook composer can attach up to 10 `READY` media assets to a draft. The attachment relation is workspace-scoped at the database level and the server verifies that each selected asset is either workspace-wide or assigned to the same brand as the selected Facebook Pages. Drafts display their attached filenames and media types.

**Important:** this is attachment and draft-management support, not media publishing. The current Facebook publisher remains text-only. To prevent silent content loss, the server rejects publishing and scheduling of drafts that contain media until the provider media publishing pipeline is enabled. Instagram publishing, Reels, and carousel publishing are not yet enabled.
