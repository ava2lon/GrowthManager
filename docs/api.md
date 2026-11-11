# API standards and implementation status

## Current status

The repository currently has internal Route Handlers for authentication, registration, integrations, media, AI, cron jobs and provider webhooks. A complete public /api/v1 resource API and API-key authentication are not implemented yet. This document defines the contract to use when that surface is introduced; it does not imply that the endpoints are already available.

## Planned base path

All public resources will live under /api/v1. Initial resource groups are workspaces, leads, content, campaigns, websites, website events, social accounts/posts, analytics and webhooks.

## Authentication

Public API requests will use revocable, workspace-scoped API keys. Store only a cryptographic hash of each key; show the raw secret once at creation. Derive workspace identity from the validated key record, never from a caller-supplied workspace_id. Scope keys by permissions and support rotation/revocation.

## Request and response conventions

- JSON request and response bodies.
- Zod validation at every input boundary.
- Consistent error envelope: { "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "request_id": "..." } }.
- Include X-Request-Id and Cache-Control: no-store on error responses.
- Do not return stack traces, SQL errors, provider response bodies or secrets.
- Use cursor pagination for large collections; enforce bounded page sizes.
- Allowlist filter and sort fields; never interpolate arbitrary client-provided SQL/order expressions.
- Use idempotency keys for externally retried create/publish operations.
- Apply distributed rate limits per API key and workspace.

## Error codes

VALIDATION_ERROR (400), UNAUTHENTICATED (401), FORBIDDEN (403), NOT_FOUND (404), CONFLICT (409), RATE_LIMITED (429), PROVIDER_ERROR (502), INTERNAL_ERROR (500).

## Service boundary

Route handlers should authenticate, validate, call a workspace-scoped service, and serialize a safe response. Business rules and database access must not be duplicated across route handlers. API keys must never grant access beyond their workspace and explicit scopes.

## Initial planned routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET/POST | /api/v1/workspaces | List accessible workspaces / create workspace |
| GET/POST | /api/v1/leads | List / create leads |
| GET/POST | /api/v1/content | List / create content |
| GET/POST | /api/v1/campaigns | List / create campaigns |
| GET/POST | /api/v1/websites | List / register websites |
| POST | /api/v1/events | Ingest validated events |
| GET | /api/v1/social/accounts | List connected accounts |
| POST | /api/v1/social/posts | Create a publication request |
| GET | /api/v1/analytics | Query available metrics |
| GET/POST | /api/v1/webhooks | List / configure outbound subscriptions |

The route list is a target contract, not a claim of current availability.
