# Integrations and provider adapters

## Current integrations

The application contains implemented provider-specific flows for Meta (Facebook/Instagram), LinkedIn, Pinterest, TikTok, X and YouTube, alongside Resend, Supabase Storage and n8n integration support. Actual feature support differs by provider and must be checked against the implementation and provider permissions. Do not advertise a capability merely because a provider enum exists.

## Adapter design

New integrations should expose a typed provider contract and isolate:
- OAuth authorization URL and callback validation.
- Token exchange, refresh and revocation.
- Account discovery and identity validation.
- Explicit capability metadata.
- Provider request/response mapping.
- Provider-specific rate limits, errors and retry rules.

Business services should depend on the contract, not import provider-specific HTTP details. Keep provider API versions and scopes in server-side configuration. Treat provider payloads as untrusted input.

## Credential handling

Provider credentials must be encrypted at rest using the existing integration credential encryption utilities or a reviewed equivalent. Bind encrypted data to workspace and resource identity with authenticated encryption. Never return credentials to the browser, write them to logs, include them in audit metadata, or commit them to Git.

## Adding a provider

1. Read the provider's current official API and platform policy documentation.
2. Define capability flags for each operation; unsupported methods must fail explicitly.
3. Implement OAuth state/PKCE and callback validation as required.
4. Encrypt tokens and persist only sanitized metadata.
5. Add request timeouts, rate-limit handling and safe token refresh.
6. Add adapter contract tests with deterministic provider mocks.
7. Add tenant isolation and credential redaction tests.
8. Document required app review, scopes, quotas, redirect URIs and deployment secrets.
9. Do not mark the integration production-ready until real-provider verification has been performed with authorized credentials.
