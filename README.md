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
Set DATABASE_URL to a managed PostgreSQL connection string, AUTH_SECRET to a cryptographically random 32+ byte secret, and AUTH_URL to the canonical deployment URL. Configure the database before enabling account registration. Use committed Prisma migrations for production schema changes. Configure `DIRECT_URL` for Prisma migration connections (Supabase session pooler on port 5432) and `DATABASE_URL` for serverless runtime queries (transaction pooler on port 6543, with `pgbouncer=true&connection_limit=1`). Apply production migrations with `npm run db:deploy`.

## Security follow-ups
Encrypt provider credentials at rest before enabling integrations. Add registration rate limiting and email verification before public launch.
