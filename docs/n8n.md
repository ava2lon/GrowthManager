# n8n integration

## Current implementation

GrowthManager includes a workspace n8n connection flow that validates an instance using its API and stores credentials encrypted. Host validation restricts self-hosted instances to an explicit hostname allowlist and permits supported n8n Cloud hostnames. The current integration includes execution snapshots and automation alert workflows; it is not yet a complete generic inbound/outbound event bus.

## Credential and network security

- Require HTTPS.
- Reject redirects for credential-bearing requests.
- Enforce strict hostname validation to mitigate SSRF.
- Apply bounded timeouts and response-size limits.
- Encrypt n8n API credentials at rest.
- Never log API keys or full authorization headers.
- Restrict connection management to workspace owners/admins.

## Planned GrowthManager → n8n

Workspace administrators will configure outbound webhook subscriptions. Each delivery should include an event name, event ID, workspace ID, occurrence timestamp and a minimal data payload. Sign the exact transmitted body with an endpoint-specific secret (HMAC-SHA256), include a timestamp and stable delivery ID, and document receiver-side verification.

Persist delivery attempts before dispatch. Use bounded exponential backoff with jitter, idempotency, delivery status, attempt history and dead-letter visibility. Do not retry permanent 4xx responses except documented retryable statuses.

## Planned n8n → GrowthManager

Expose workspace-scoped public API endpoints under /api/v1 authenticated by revocable, hashed API keys with explicit scopes. The API must derive workspace identity from the key and enforce tenant filters on every query.

## Operational guidance

n8n is an external system. Treat webhook payloads as untrusted. Validate schemas, cap body size, rate-limit inbound requests, prevent replay where signatures are used, and avoid arbitrary URL fetching based on user-provided payload values.
