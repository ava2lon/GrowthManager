# Security model

## Authentication

The application uses Auth.js v5 Credentials authentication, bcrypt password hashes and JWT sessions. Login and registration attempts use distributed Redis-backed rate limits. Production authentication must fail closed if the rate-limit service is unavailable or required configuration is missing.

Before public launch, evaluate email verification, password reset lifecycle, account recovery, session revocation and abuse monitoring. Do not replace Auth.js with custom session/password handling.

## Tenant isolation

Resolve the authenticated user on the server, then resolve WorkspaceMembership from PostgreSQL. The active-workspace cookie is an untrusted selection hint. Every read and write must be scoped to the resolved workspace ID. Cross-tenant relationships should be constrained by composite foreign keys wherever applicable.

## Secrets and credentials

- Store only password hashes.
- Encrypt provider credentials using AES-256-GCM.
- Store API key hashes, never raw API keys.
- Keep secrets in deployment environment variables/secret stores.
- Never expose secrets to client components or NEXT_PUBLIC variables.
- Never log access tokens, refresh tokens, API keys, passwords, encryption keys or authorization headers.

## HTTP and API controls

Validate request bodies and query parameters with Zod. Enforce body-size limits, timeouts, rate limits and safe pagination. Return generic errors with request IDs; do not disclose stack traces or database/provider internals. Apply secure headers and verify cookie/CSRF assumptions for each state-changing route. Webhook receivers must verify signatures against the raw body and enforce replay windows.

## External network requests

Validate hostnames and protocols before server-side requests. Reject redirects when credentials could be forwarded. Use fixed provider endpoints, bounded timeouts and response-size limits to reduce SSRF and resource-exhaustion risk.

## Audit and observability

Audit security-sensitive workspace actions using workspace-scoped records. Structured logs must contain request correlation IDs and sanitized classifications, not sensitive payloads. Monitor authentication failures, provider failures, webhook deliveries, publication attempts and automation executions.

## Verification still required

The existing codebase has meaningful encryption, rate limiting, workspace access helpers and PostgreSQL tenant-integrity tests. A complete production security review still needs route-by-route authorization coverage, CSRF/cookie review, secure-header verification, secret scanning, dependency review and live environment configuration checks. Documentation is not a substitute for those tests.
