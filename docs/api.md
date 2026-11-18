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

Route handlers authenticate, validate, call workspace-scoped data access, and serialize safe responses. API-key support is wired to website list, detail, events and stats reads, plus website creation. Website PATCH and DELETE remain session-authenticated until scoped mutation and idempotency support are implemented. Content, campaign, social, analytics and webhook resource APIs are not yet exposed through API keys; the scope names above define the controlled future permissions, not implemented route availability.

Idempotency primitives currently back API-key website creation. Every additional mutation endpoint must adopt the same claim/complete transaction pattern before it is exposed to external clients.
