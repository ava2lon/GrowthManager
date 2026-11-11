# GrowthManager architecture

## Product boundary

GrowthManager is a multi-tenant growth operating system. Its product lifecycle is Acquire → Convert → Retain → Analyze → Automate → Optimize. Social publishing is one capability, not the product boundary.

## Current runtime

- Next.js App Router and React, with TypeScript strict mode.
- NextAuth/Auth.js v5 Credentials provider with bcrypt password verification and JWT sessions.
- PostgreSQL accessed through Prisma 6.
- Vercel-compatible Route Handlers and server-rendered application routes.
- Tailwind CSS for the application UI.
- Vitest for unit/policy tests and PostgreSQL integration tests.
- Upstash Redis REST for distributed authentication/registration rate limiting and public website event ingestion.
- Supabase Storage for private media objects.
- External provider credentials are encrypted server-side using AES-256-GCM.

## Tenant and authorization model

A User can belong to multiple Workspaces through WorkspaceMembership. The active-workspace cookie is only a selection hint: server code must resolve the user session and re-check membership against PostgreSQL before returning workspace data. Never accept a workspace ID from a browser as proof of authorization.

Workspace-owned records must include workspaceId and query predicates must include the resolved workspace ID. For relations that connect two tenant-owned records, prefer composite foreign keys that include workspaceId. The existing Brand, SocialAccount, ContentPost, Campaign, and media relationships demonstrate this integrity pattern.

Authorization belongs in server actions, route handlers, and service functions. UI visibility is not an authorization boundary. Use the workspace role policy in src/lib/workspace-access.ts and the server-side context helpers in src/lib/workspace.ts.

## Existing bounded contexts

- Identity and workspace membership: User, Workspace, WorkspaceMembership, WorkspaceInvitation.
- Brand and campaigns: Brand, Campaign, CampaignSocialAccount.
- Content and publishing: ContentPost, ContentPostRevision, ContentReviewAssignment, SocialPostTarget, SocialPublishAttempt.
- Social integrations: SocialAccount and provider-specific OAuth, publishing, analytics and retry services.
- Media: MediaAsset, MediaFolder and ContentPostMedia.
- Automation and n8n: Integration, Automation, Task, N8nExecutionSnapshot and alert/delivery records.
- AI: WorkspaceAISettings, WorkspaceAIUsage and AIGeneration.
- Audit and notifications: ActivityLog, WorkspaceNotification and incident records.

## Extension rules

1. Keep provider-specific HTTP and payload handling inside provider adapters.
2. Expose provider capabilities explicitly; do not infer support from a provider enum.
3. Keep external calls behind typed services with timeouts and sanitized errors.
4. Persist durable work before acknowledging asynchronous operations.
5. Make retries idempotent and do not retry ambiguous publication outcomes automatically.
6. Keep analytics calculations in server-side services and label observed, calculated and estimated values.
7. Validate all external input at boundaries and keep secrets server-only.

## Planned bounded contexts

Website tracking, unified leads, a versioned public API, generic outbound webhook delivery, and broader conversion analytics are not yet present in the current Prisma schema/API tree. They must be introduced through additive migrations and workspace-scoped services. Do not claim these capabilities are live until their end-to-end flows and tests are merged.

## Runtime constraints

Vercel Route Handlers are request/response workloads, not durable workers. Use short bounded operations and scheduled/queued processing for publishing, retries and webhook delivery. Long-running work should be moved to a durable queue/worker design before request timeouts become a reliability risk.
\n\n## Website tracking (Phase 2)\n\nWebsite tracking extends the existing workspace model. Authenticated website APIs derive workspace membership server-side; public event ingestion resolves the website from its tracking ID and enforces website status, payload limits, origin checks, and distributed rate limiting. Visitor/session/event records are scoped to a Website and cascade on website deletion. See [website tracking](website-tracking.md) for installation, event, privacy, and operational details.\n