# GrowthManager

Multi-tenant SaaS workspace for growth, marketing, social media, websites, and automation.

## Stack
Next.js App Router, TypeScript, Tailwind CSS, PostgreSQL, Prisma, Auth.js credentials authentication, and Vercel.

## Phase 1 foundation
Responsive public page and dashboard; bcrypt password hashing; account registration creates a workspace and OWNER membership transactionally; multi-tenant data schema for brands, social accounts, content, campaigns, integrations, automations, tasks, and activity logs; protected dashboard routes.

External publishing, AI providers, billing, and automation execution are staged for later phases and are not represented as live integrations.

## Engineering documentation

- [Architecture](docs/architecture.md)
- [Database and migrations](docs/database.md)
- [Public API standards and implementation status](docs/api.md)
- [Provider integrations](docs/integrations.md)
- [n8n integration](docs/n8n.md)
- [Vercel deployment](docs/deployment.md)
- [Security model](docs/security.md)

The public `/api/v1`, website tracking, unified lead management, and generic outbound webhook delivery are documented as planned capabilities; they are not represented as implemented until their routes, schema, services, and tests are merged.

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

Content-review assignment and decision emails use the platform-level Resend configuration in `RESEND_API_KEY` and `RESEND_FROM_EMAIL`. Configure a Resend webhook for `/api/webhooks/resend` and set its signing secret as `RESEND_WEBHOOK_SECRET` to record delivered, delayed, bounced, complained, and failed outcomes. The authenticated `/api/cron/content-review-emails` worker is invoked every five minutes by GitHub Actions. Review email records are queued transactionally with their in-app notification; delivery retries use a stable idempotency key and stop after bounded attempts. Add `RESEND_WEBHOOK_SECRET` to the Vercel production environment and GitHub Actions invokes the worker using the existing `GROWTHMANAGER_CRON_SECRET` secret. Workspace administrators can inspect the latest 50 review email deliveries on the AI review page. Only failed messages without a provider message ID can be manually retried; each retry creates a new audited outbox record. Bounced and complained messages are intentionally not retryable from the monitor.

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

The media library at `/dashboard/media` stores workspace-scoped metadata in PostgreSQL and file bytes in a **private Supabase Storage bucket**. Browser uploads use short-lived signed upload URLs; the Supabase service-role key remains server-only. Upload initialization and completion are authenticated, workspace-scoped, rate-limited, and audited. The completion endpoint verifies the stored object's size and MIME type before marking the asset `READY`, and persists browser-read dimensions plus video duration metadata. Video uploads must report a 3-second to 15-minute duration and dimensions no larger than 1920 × 1920 pixels. These metadata checks do not inspect the encoded video/audio codecs; Meta performs the authoritative media processing and validation during Reels container creation.

When configuring storage:
1. Create a **private** Supabase Storage bucket named `growthmanager-media` (or set `SUPABASE_MEDIA_BUCKET` to another valid bucket name).
2. Set the bucket's maximum file size to at least 100 MB and restrict allowed MIME types to `image/jpeg`, `image/png`, `image/webp`, `video/mp4`, `video/quicktime`, `application/pdf`, `text/plain`, `text/csv`, and the DOCX, XLSX, and PPTX OpenXML MIME types.
3. Add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and optionally `SUPABASE_MEDIA_BUCKET` to the server-side Vercel environment. Never use a `NEXT_PUBLIC_` prefix for the service-role key.
4. Apply the committed Prisma migration `20261107110000_media_assets` only after the GrowthManager database target and connection variables have been confirmed.

Application limits are 20 MB per image and 100 MB per video. Supported formats are JPEG, PNG, WebP, MP4, MOV, PDF, TXT, CSV, DOCX, XLSX, and PPTX. Files are organized under a workspace-specific object prefix, and downloads are issued as five-minute signed URLs after membership and workspace ownership checks. The bucket must remain private; do not enable public object access.


### Media attachments on social drafts

The Facebook composer can attach up to 10 `READY` media assets to a draft. The attachment relation is workspace-scoped at the database level and the server verifies that each selected asset is either workspace-wide or assigned to the same brand as the selected Facebook Pages. Drafts display their attached filenames and media types.

**Facebook media publishing:** connected Pages can publish text-only posts or posts with up to 10 JPEG/PNG images. The publisher creates 1-hour signed URLs from the private workspace media bucket, stages photos as unpublished Page photos, then creates the feed post with `attached_media`. Only ready, same-workspace assets assigned to the post brand (or workspace-wide assets) are accepted. Other image formats and video assets are rejected for Facebook.\n\n**Instagram image publishing:** connected Instagram Professional accounts can publish one JPEG image or a carousel of 2–10 JPEG images. The publisher creates private signed media URLs, stages child containers for carousels, waits for container processing to finish, creates the carousel container, and calls `media_publish`. Captions are limited to 2,200 characters. Only ready, same-workspace JPEG assets assigned to the post brand (or workspace-wide assets) are accepted. **Instagram Reels publishing:** one MP4/MOV video per Reel is supported, with a conservative 100 MB application limit, 3-second to 15-minute duration, and dimensions no larger than 1920 × 1920. Reels use a separate asynchronous pipeline: the app creates a Meta `REELS` container, persists its ID and next-check time, then the scheduled worker polls processing status and publishes only after `FINISHED`. Container processing is resumed across worker runs rather than held open in a request. `ERROR`/`EXPIRED` containers fail; uncertain publish outcomes are marked `UNKNOWN` and are not automatically retried. The app's browser-read metadata is a preliminary check; Meta remains authoritative for codec and media compatibility. Scheduled Reels use the same worker.\n\nFor either provider, an uncertain publishing outcome is marked `UNKNOWN` and is not automatically retried, avoiding accidental duplicate public posts.

## TikTok account lifecycle and webhooks

The TikTok inbox-upload integration uses the creator's `video.upload` permission. Disconnecting a TikTok account attempts server-side OAuth token revocation at TikTok's `/v2/oauth/revoke/` endpoint, then removes the locally stored encrypted credentials regardless of provider availability. The audit event records whether provider revocation succeeded; it never records a token.

Configure the TikTok developer application's webhook callback URL as:

`https://growthmanager.vercel.app/api/webhooks/tiktok`

The handler verifies the raw request body using the `TikTok-Signature` timestamp/HMAC-SHA256 format and `TIKTOK_CLIENT_SECRET`, enforces a five-minute replay window and a 64 KiB body limit, and checks `client_key` against `TIKTOK_CLIENT_KEY`. It processes the documented `authorization.removed` event by disconnecting matching TikTok accounts across their respective workspaces, clearing credentials and scopes, and writing workspace-scoped audit events. Duplicate notifications are idempotent. Workspace administrators can also run a TikTok account health check from Social Media. It refreshes an expiring access token through the existing refresh helper, validates the creator's `open_id` through the User Info API, and records a sanitized audit result. Definitive authorization, account-identity, or required-scope failures move the account to `ERROR`; transient provider/network failures are recorded without falsely disconnecting the account.

TikTok's currently documented `video.upload.failed` and `video.publish.completed` webhook events refer to Video Kit. They are not treated as Content Posting API inbox-upload status notifications. GrowthManager therefore continues to reconcile inbox uploads through the Content Posting API status endpoint and its scheduled worker. Configure both TikTok OAuth variables and the public HTTPS callback in the TikTok developer portal before expecting live webhook delivery.

## YouTube channel connection

GrowthManager supports YouTube OAuth channel connection and resumable video publishing. Enable **YouTube Data API v3** in the Google Cloud project, create a Web application OAuth client, and register this exact authorized redirect URI:

`https://growthmanager.vercel.app/api/integrations/youtube/callback`

Set `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and `YOUTUBE_REDIRECT_URI` in the deployment environment. The OAuth flow requests `youtube.upload` and `youtube.readonly`, uses offline access, validates a signed workspace-bound state cookie, verifies the authenticated workspace administrator and active brand on callback, fetches the authenticated channel identity, and stores access/refresh tokens encrypted with the workspace and account identifiers as AES-GCM associated data. Tokens are never returned to the browser or logged. The connected channel can be used by the Social Media video composer after the required deployment configuration is present.

Google may require OAuth consent-screen configuration and verification depending on the audience and requested scopes. YouTube Data API quota is project-scoped; review quota and API compliance before enabling production publishing.

YouTube channel credentials are refreshed server-side through Google's OAuth token endpoint when the access token is near expiry. The refresh helper retains the long-lived refresh token, encrypts the replacement access token, and uses a conditional update to avoid overwriting concurrent refreshes. Workspace administrators can run **Check health** from the Social Media account inventory; the action verifies the connected channel identity, records a sanitized audit event, and only moves the channel to `ERROR` for definitive authorization, scope, or identity failures. Transient API/network failures do not automatically disconnect a channel.

## YouTube resumable video publishing

The Social Media workspace now supports YouTube video drafts and resumable uploads. A connected channel with the `youtube.upload` scope can create a draft with title, description, category ID, tags, and privacy (private by default). The draft must contain one READY MP4 or MOV asset from the same workspace and brand; the current media-library upload ceiling is 100 MB.

Starting an upload creates a YouTube resumable session and stores its session URI encrypted with workspace/target-bound AES-GCM associated data. The background social-publishing worker reconciles the authoritative byte offset with YouTube before sending each 8 MiB range from private Supabase Storage. Network interruptions are reconciled from the provider session rather than blindly retransmitting bytes. Completed byte transfers persist the YouTube video ID and move the target into YouTube processing reconciliation. The target is marked uploaded only after videos.list reports uploadStatus=processed; failed or rejected processing is recorded as a terminal failure. The session URI is cleared after completion or terminal failure. Optional scheduled publication uses the YouTube `status.publishAt` field and requires `privacyStatus=private`; the composer accepts a timezone-qualified ISO 8601 timestamp in UTC (for example `2026-11-10T14:30:00Z`) at least 15 minutes ahead. Once processing completes, the target enters `SCHEDULED` and is reconciled again at the scheduled time so GrowthManager distinguishes a private queued video from a publicly published video. To schedule a video, save the draft and explicitly start its upload before the scheduled time.

GitHub Actions invokes the protected `/api/cron/social-publishing`, `/api/cron/social-media-processing`, and `/api/cron/social-analytics` endpoints every five minutes, using `CRON_SECRET` in Vercel and the matching `GROWTHMANAGER_CRON_SECRET` repository Actions secret. The publishing endpoint handles due Facebook/Instagram image posts and incident delivery; the media-processing endpoint claims and advances one due Pinterest, Instagram Reel, TikTok, YouTube, or X scheduled/resumable job per invocation; analytics refreshes run independently in a rotating provider slot so slow reports cannot consume the publishing worker's runtime budget. Each Vercel function is bounded to 60 seconds. Scheduled YouTube targets are checked again at their publish time. No video bytes are exposed to the browser.

**Database migration required:** `prisma/migrations/20261107180000_youtube_resumable_upload/migration.sql`. The migration is committed but has not been applied. Apply it only after the GrowthManager Supabase database environment is configured and confirmed.

Before enabling production uploads, configure YouTube Data API v3 and complete the applicable Google OAuth consent-screen configuration. The current YouTube video resource documentation says uploads from unverified API projects are not restricted to private viewing; public and unlisted privacy values can be requested. The default videos.insert quota is 100 upload calls per day, so GrowthManager must still enforce conservative workspace and account rate limits as usage grows. The current composer defaults to private visibility. Scheduled publishing, thumbnails, captions, and channel analytics are not yet implemented.

#### YouTube upload operational limits

The YouTube Data API resumable protocol uses a session URI returned by `videos.insert`, HTTP 308 responses with a committed `Range` header, and 201 when the upload completes. GrowthManager uses 8 MiB chunks (a multiple of Google's 256 KiB chunk alignment), persists the encrypted session URI, and asks Google for the authoritative committed byte offset before every continuation. The default YouTube API project quota currently allows 100 video uploads per day; verify the actual quota in Google Cloud Console before enabling high-volume workspace usage. See Google's [resumable upload protocol](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol) and [videos.insert reference](https://developers.google.com/youtube/v3/docs/videos/insert).


## LinkedIn OAuth and text publishing

GrowthManager supports LinkedIn member-profile and eligible organization Page connections through LinkedIn OAuth 2.0. Register the callback URL exactly as:

`https://growthmanager.vercel.app/api/integrations/linkedin/callback`

Configure `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`, and `LINKEDIN_API_VERSION`. The current example uses API version `202610`; use a currently supported monthly version from LinkedIn's versioning documentation when configuring the application.

The OAuth flow always requests OpenID Connect identity and member posting. Organization posting and organization administration read scopes are requested only when `LINKEDIN_ENABLE_ORGANIZATION_SCOPES=true`. This opt-in avoids requesting Community Management permissions from applications that have not been approved for those products. LinkedIn grants only the products and permissions approved for the developer application. GrowthManager always stores the member identity; organization Pages are discovered only when the relevant organization permissions are granted and the authenticated member has an approved eligible Page role. The member's organization role is rechecked before every organization post. A missing Community Management API product or role does not prevent member-profile connection.

The current publishing phase supports text-only organic posts through `POST /rest/posts`, using the required `Linkedin-Version` and `X-Restli-Protocol-Version: 2.0.0` headers. Posts are published immediately; scheduling, images, videos, documents, analytics, and comments remain staged. An ambiguous provider response is marked `UNKNOWN` and is not blindly retried. LinkedIn access tokens are typically valid for 60 days. If LinkedIn has enabled programmatic refresh tokens for the developer application, GrowthManager refreshes them server-side and persists token rotation with compare-and-swap protection. Refresh-token access is restricted to approved LinkedIn Marketing Developer Platform partners; if no valid refresh token is issued or refresh is rejected, the workspace administrator must reconnect the identity.

Credentials are encrypted at rest with workspace/account-bound AES-GCM. OAuth state is HMAC-signed, short-lived, cookie-bound, and checked against the current authenticated workspace administrator. Account health checks and publishing actions remain workspace-scoped and audited.


## Pinterest account connection

GrowthManager supports Pinterest API v5 OAuth account connection, identity validation, and board discovery. Register the callback URL exactly as:

`https://growthmanager.vercel.app/api/integrations/pinterest/callback`

Configure `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`, and `PINTEREST_REDIRECT_URI`. The OAuth flow requests `user_accounts:read`, `boards:read`, and `pins:write`; it uses a short-lived HMAC-signed, HttpOnly, SameSite=Lax state cookie bound to the authenticated user, workspace, and active brand. Callback handling rechecks current workspace administrator membership and brand ownership before storing credentials.

Access and refresh tokens are encrypted using the workspace/account-bound AES-GCM credential envelope. Pinterest access tokens are refreshed server-side before expiry; refresh-token rotation is persisted with compare-and-swap protection. The connection callback verifies the Pinterest user identity and retrieves the first 100 boards. Workspace administrators can run an account health check to validate identity, scopes, and board discovery. Disconnect removes locally stored credentials and scopes.

The connection is now used by image and video Pin publishing. Board discovery currently stores the first 100 boards; board pagination, scheduling, and Pinterest analytics are not yet enabled. Pinterest Trial access may restrict Pins created through the API to creator-visible content; public distribution requires the appropriate Pinterest API access tier. See the [Pinterest OAuth guide](https://developer.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/) and [organic content guide](https://dev.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/).


## Pinterest image Pin publishing

Pinterest publishing supports one image Pin per target using the Pinterest API v5 `POST /v5/pins` endpoint and `media_source.source_type=image_url`. A saved draft is scoped to the connected Pinterest account's workspace brand and a board discovered through that account. It accepts one ready JPEG or PNG image up to 20 MB, a title up to 100 characters, a description up to 500 characters, and an optional HTTPS destination link.

Before publishing, GrowthManager verifies the workspace, account, brand, board discovery metadata, image readiness, image MIME type, and granted `pins:write` scope. It creates a one-hour Supabase signed object URL so Pinterest can fetch the image without exposing storage credentials. Publishing uses an atomic target claim and a durable attempt record. Definitive provider rejections are recorded as failed; transport uncertainty, provider 5xx, or a successful response without a Pin ID is recorded as `UNKNOWN` and is never blindly retried. Known definitive failures can be manually retried after the underlying issue is corrected. Check Pinterest directly before manually creating another Pin after an unknown result.

**Current limits:** image Pins support one JPEG/PNG image per Pin. Video Pins require one MP4/MOV video plus a separate JPEG/PNG cover image; the application limit is 100 MB, 3 seconds to 15 minutes, and no dimension above 1920 pixels. The video is registered with `POST /v5/media`, uploaded using Pinterest's returned multipart form parameters, and checked through `GET /v5/media/{media_id}` until Pinterest reports `succeeded`; only then does GrowthManager create the Pin with `source_type=video_id`. The media upload is performed server-to-server from a one-hour private Supabase signed URL; the browser never receives Pinterest upload credentials or storage service credentials. A definitive media upload/processing failure is retryable after correction. Once the final Pin-create request begins, any transport ambiguity is recorded as `UNKNOWN` and is never blindly retried. Media duration and dimensions are currently based on Media Library metadata collected at upload completion; they are not independently inspected server-side. No multi-image Pins, scheduling, or Pinterest analytics are enabled. Pinterest Trial access makes API-created Pins visible only to the creator; Standard access is required for normal public distribution. See [Create boards and Pins](https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/) and [Pinterest access tiers](https://developers.pinterest.com/docs/key-concepts/access-tiers/).


## Phase 3: content and campaign management

The content library at `/dashboard/content` supports workspace/brand-scoped content CRUD, duplication, archive/restore, safe deletion (published social history is retained), content types, workflow transitions, categories, tags, campaign association, author metadata, media attachments, search, filters, sorting, and pagination. The workflow is enforced server-side: Idea → Draft → Review → Approved → Scheduled → Published, with explicit review and failure recovery transitions.

Campaigns at `/dashboard/campaigns` support objectives, descriptions, budgets, date ranges, audience definitions, brand/content associations, and connected social-account associations. The dashboard reports content delivery progress and tracked Meta engagement snapshots; unavailable analytics remain unreported rather than simulated.

Media folders and tags are workspace-scoped. The reusable media picker attaches ready, same-workspace assets to content. Stable media URLs are authenticated application download routes; signed object-store URLs are short-lived and are never persisted. The storage adapter contract is provider-neutral, with Supabase Storage as the configured implementation. Configure `MEDIA_STORAGE_PROVIDER=SUPABASE` (or leave unset) and the private bucket's allowlist for the supported image, video, PDF, text, CSV, DOCX, XLSX, and PPTX MIME types.

Apply the Phase 3 migration with `npm run db:deploy` after verifying the GrowthManager production database target. Do not use `prisma db push` for production changes.


## Phase 4: AI Content & Growth Assistant

The AI assistant is available at `/dashboard/ai`. It uses active-workspace brand context (industry, description, target audience), campaign details, recent content, and connected social platforms. Brand context can be maintained from **Brands → Edit brand context for AI**. The Phase 3 Add Brand workflow remains available.

Supported providers are OpenAI, Anthropic, and Groq. Configure credentials only as server-side environment variables:
- `OPENAI_API_KEY`, optional `OPENAI_MODEL`, and optional `OPENAI_BASE_URL`
- `ANTHROPIC_API_KEY` and optional `ANTHROPIC_MODEL`
- `GROQ_API_KEY` and optional `GROQ_MODEL`

Workspace owners and administrators choose the provider/model and set a monthly request limit from the AI Assistant page. Credentials are never saved in workspace settings or exposed to browsers. Each generation is recorded in tenant-scoped history with provider/model, request/result, user, timestamp, and token usage when returned by the provider. Monthly request reservations are atomic to prevent concurrent requests from exceeding the workspace limit. The quota resets on the first day of each UTC calendar month. Provider rate limits and hourly request protection are also enforced.

Apply the committed migration `20261111180000_phase4_ai_content_growth_assistant` using `npm run db:deploy` only after verifying the configured GrowthManager database target. Do not use `prisma db push` in production.

Generated output is editable and can be saved explicitly to the content library as a DRAFT. The assistant never approves, schedules, or publishes AI-generated content. AI usage metadata reports provider token counts when available; monetary cost remains unset unless a provider supplies reliable cost data. Deleting a campaign clears its optional association from retained AI history so campaign maintenance does not remove generation records.
