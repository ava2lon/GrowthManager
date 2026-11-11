# Deployment

## Platform

GrowthManager is designed for Vercel with Next.js App Router, PostgreSQL and managed external services. Vercel functions must remain bounded; durable retries and long-running media operations must use scheduled or queued workers.

## Required environment

See .env.example for the full variable catalog. Core deployment configuration includes:
- DATABASE_URL: PostgreSQL runtime connection string.
- DIRECT_URL: PostgreSQL migration connection string.
- AUTH_SECRET: high-entropy Auth.js secret.
- AUTH_URL: canonical application URL.
- UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN: distributed rate limits.
- INTEGRATION_ENCRYPTION_KEY and INTEGRATION_ENCRYPTION_KEY_ID: encrypted integration credentials.
- CRON_SECRET: protected scheduled route secret.
- Supabase Storage variables when media storage is enabled.

Provider and AI credentials are optional until the corresponding integration is configured. Never prefix server secrets with NEXT_PUBLIC_.

## Release procedure

1. Review the pull request and CI results.
2. Verify Vercel environment variables for the intended environment.
3. Confirm DATABASE_URL and DIRECT_URL point to the intended database.
4. Run npm run db:status against the intended database.
5. Apply committed migrations with npm run db:deploy through the approved release process.
6. Deploy the application.
7. Verify sign-in, workspace selection, core dashboard routes and integration health.
8. Inspect Vercel function logs for sanitized errors and request correlation IDs.

## Local development

Use Node.js 20.9 or later. Install dependencies with npm install, copy .env.example to .env, configure a disposable PostgreSQL database, then run npm run db:generate, npm run db:migrate and npm run dev.

## CI quality gates

The repository CI workflow runs Prisma validation/generation, TypeScript, ESLint, unit tests, PostgreSQL tenant-isolation tests against a disposable database, and a production build. A green CI run does not prove third-party OAuth credentials or provider permissions are configured.
