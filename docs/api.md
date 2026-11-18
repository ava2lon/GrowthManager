# GrowthManager API

## Implementation status

The API supports authenticated website management through browser sessions and workspace API keys. API keys are workspace-scoped, stored as SHA-256 hashes, explicitly scoped, revocable, optionally expiring, and rate-limited through the shared Redis rate-limit service. Website creation through an API key requires an idempotency key.

The API key management endpoints are session-authenticated and restricted to workspace OWNER/ADMIN members:
- `GET /api/v1/keys` — list metadata for workspace keys (never returns secrets).
- `POST /api/v1/keys` — create a key; the raw secret is returned once.
- `DELETE /api/v1/keys/:keyId` — revoke an active key.

Supported scopes:
- `websites:read` — read workspace website records and related read endpoints where implemented.
- `websites:write` — create and modify website resources where implemented.
- `content:read`, `content:write`, `campaigns:read`, `campaigns:write`, `social:read`, `social:write`, `analytics:read`, `webhooks:read`, `webhooks:write` — reserved scope identifiers for the corresponding API resource groups; routes must enforce the matching scope before use.


## Authentication

Send the API key in the Authorization header:

```http
Authorization: Bearer gm_live_<prefix>_<secret>
```

The prefix is used only to locate the key record. The complete key is hashed with SHA-256 and compared in constant time. Workspace identity is derived from the key record; callers cannot select a workspace by supplying a workspace ID. Revoked and expired keys are rejected. Keys are shown only once at creation and must be stored securely by the client.

Example key creation request (browser session, workspace OWNER/ADMIN required):

```http
POST /api/v1/keys
Content-Type: application/json

{
  "name": "Production website sync",
  "scopes": ["websites:read", "websites:write"],
  "expiresAt": "2027-11-18T00:00:00.000Z"
}
```

Omit `expiresAt` for a non-expiring key. Prefer an expiry and rotate keys periodically. Never put API keys in browser JavaScript, source control, query parameters, logs, or n8n workflow exports. Store them in n8n credentials.

## Website API

### List websites

```http
GET /api/v1/websites
Authorization: Bearer gm_live_<prefix>_<secret>
```

Requires `websites:read`.

### Read a website\n\n`GET /api/v1/websites/:websiteId` requires `websites:read` and returns website metadata and event/visitor/session counts.\n\n`GET /api/v1/websites/:websiteId/events` requires `websites:read`; supports bounded pagination (`page`, `limit`), sorting (`sort=asc|desc`), event/type filters, date bounds (`from`, `to`) and text search (`q`).\n\n`GET /api/v1/websites/:websiteId/stats` requires `websites:read`; accepts `days` from 1 to 90 (default 30).\n\nThese endpoints preserve browser-session authentication when no Bearer authorization is supplied. API-key workspace identity is taken exclusively from the validated key record.\n\n### Create a website

```http
POST /api/v1/websites
Authorization: Bearer gm_live_<prefix>_<secret>
Idempotency-Key: <unique-client-generated-key>
Content-Type: application/json

{
  "name": "Marketing site",
  "domain": "example.com",
  "description": "Primary marketing website"
}
```

Requires `websites:write` and an `Idempotency-Key` header containing 8–128 characters from `A-Z a-z 0-9 . _ : -`. The same key and identical request body replay the original successful response for 24 hours. Reusing a key with a different request body returns 409. Concurrent duplicate requests return 409 while the first request is processing. The resource creation, audit event and stored idempotent response are committed in one database transaction.


### Update a website

`PATCH /api/v1/websites/:websiteId` accepts the same validated website fields as the session endpoint and requires `websites:write` for API-key authentication.

### Delete a website

`DELETE /api/v1/websites/:websiteId` requires `websites:write` for API-key authentication. Deletion is workspace-scoped and follows the database's configured cascade/restrict behavior.

For both API-key mutation endpoints, send an `Idempotency-Key` header (8–128 characters from `A-Z a-z 0-9 . _ : -`). Identical requests replay the original successful response for 24 hours; reusing a key with a different body returns 409. Mutation, activity audit record and idempotency completion are committed in one database transaction. Request bodies are limited to 16 KiB. Browser-session OWNER/ADMIN mutation behavior remains supported without requiring an idempotency header.

## Rate limits and failures

API-key requests are limited to 300 requests per key per 60-second window using the shared Redis-backed limiter. Production fails closed with 503 if the limiter is not configured or unavailable; callers should retry with bounded exponential backoff and respect `Retry-After`. Rate limits are enforced per API key and therefore cannot be bypassed by rotating client IP addresses.

## Request and response conventions

- JSON request and response bodies.
- Zod validation at every input boundary.
- Consistent error envelope: `{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "request_id": "..." } }`.
- Include `X-Request-Id` and `Cache-Control: no-store` on responses.
- Do not return stack traces, SQL errors, provider response bodies or secrets.
- Use bounded pagination and allowlisted filters/sorts.
- Never trust a caller-supplied workspace identifier.

## Error codes

`VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429), `PROVIDER_ERROR` (502), `INTERNAL_ERROR` (500).

## Service boundary and remaining rollout

Route handlers authenticate, validate, call workspace-scoped data access, and serialize safe responses. API-key support is wired to website list, detail, events and stats reads, plus website creation. Website PATCH and DELETE support both session authentication and workspace API keys with the `websites:write` scope. API-key mutations require idempotency keys and commit resource changes, activity audit records and idempotency completion atomically. Content, campaign, social, analytics and webhook resource APIs are not yet exposed through API keys; the scope names above define the controlled future permissions, not implemented route availability.

Idempotency primitives currently back API-key website creation. Every additional mutation endpoint must adopt the same claim/complete transaction pattern before it is exposed to external clients.
## Content API

- `GET /api/v1/content` — requires `content:read`; workspace-scoped, excludes archived items, supports bounded `page`/`limit` pagination and `q`, `brandId`, `campaignId`, `status`, and `type` filters.
- `POST /api/v1/content` — requires `content:write` and an `Idempotency-Key`; creates a content item in IDEA workflow state. Requires an active workspace brand; an optional campaign must belong to the same workspace and either be workspace-wide or assigned to that brand. Tags are limited to 20 values, each at most 40 characters. Body limit: 16 KiB.

Example content creation:

```http
POST /api/v1/content
Authorization: Bearer gm_live_<prefix>_<secret>
Idempotency-Key: content-create-0001
Content-Type: application/json

{
  "brandId": "brand_id",
  "title": "Launch announcement",
  "body": "Approved copy goes here",
  "contentType": "POST",
  "tags": ["launch", "product"]
}
```

## Campaign API

- `GET /api/v1/campaigns` — requires `campaigns:read`; workspace-scoped, supports bounded `page`/`limit` pagination and `status` and `brandId` filters.
- `POST /api/v1/campaigns` — requires `campaigns:write` and an `Idempotency-Key`; creates a campaign. Optional brand must belong to the key's workspace. Date range and budget are validated. Body limit: 16 KiB.
- `PATCH /api/v1/campaigns/{campaignId}` — requires `campaigns:write` and an `Idempotency-Key`; updates only supplied fields. Brand ownership and date range are validated. Body limit: 16 KiB. Concurrent updates are rejected.
- `DELETE /api/v1/campaigns/{campaignId}` — requires `campaigns:write` and an `Idempotency-Key`; deletes a campaign only when no content posts reference it. Campaigns with linked content return HTTP 409.

Example campaign creation:

```http
POST /api/v1/campaigns
Authorization: Bearer gm_live_<prefix>_<secret>
Idempotency-Key: campaign-create-0001
Content-Type: application/json

{
  "name": "Q1 launch",
  "objective": "Increase qualified leads",
  "status": "PLANNING"
}
```

Campaign social-account assignment remains session-only; the campaign CRUD endpoints above are workspace-scoped and idempotent.
## Social API

- `GET /api/v1/social/accounts` — requires `social:read`; lists at most 100 workspace-owned social accounts, with optional `brandId`, `provider`, and `status` filters. Credential ciphertext and provider metadata are never returned.
- `GET /api/v1/social/posts` — requires `social:read`; lists workspace-owned publishing targets with bounded pagination and optional `status`, `provider`, and `brandId` filters. Content and account fields are limited to safe display fields.

## Analytics API

- `GET /api/v1/analytics` — requires `analytics:read`; returns stored provider analytics snapshots for the previous 1–90 UTC calendar days (default 30), optionally filtered by `socialAccountId`. The response is capped at 500 records and exposes normalized metrics, not raw provider responses or credentials. `truncated` indicates the cap was reached.

## Outbound webhook read API

- `GET /api/v1/webhooks` — requires `webhooks:read`; lists at most 100 workspace subscriptions and delivery counts. Signing-secret ciphertext and endpoint URL are not returned.
- `GET /api/v1/webhooks/{subscriptionId}/deliveries` — requires `webhooks:read`; lists deliveries belonging to that workspace subscription, with bounded pagination and an optional persisted delivery `status` filter. Attempt response bodies and signing secrets are not returned.

These are read-only API surfaces. Subscription creation, pause/resume, secret rotation, and manual redelivery remain available through the existing administrator dashboard actions; API-key mutation routes are not exposed until their security and idempotency contracts are implemented and tested.
