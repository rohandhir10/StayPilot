# StayPilot — Railway API + Vercel frontend

This repository package is a backend starter for the StayPilot hotel-sales CRM. It is designed for the requested deployment model:

- **GitHub:** one source of truth for code and review history.
- **Vercel:** frontend only.
- **Railway:** Fastify API and private PostgreSQL database.
- **Clerk:** identity and sign-in. The API separately enforces StayPilot workspace membership and role permissions.

> **Important status:** this is a backend starter, not a live deployment. The target private repository is `https://github.com/rohandhir10/StayPilot`. The original frontend still needs to be located and pointed at these API routes. Provider credentials are placeholders; real secrets must be created in the corresponding owner accounts and added to Railway/Vercel settings.

## What is included

`apps/api/` contains a TypeScript Fastify API, Postgres migration, validation schemas, role checks, provider webhook verification, one-time partner keys, audit/activity logging, a bounded import workflow, and tests for input validation and cryptographic helpers.

Core safety properties:

- All CRM records are scoped to the server-resolved workspace; IDs and workspace IDs from request bodies are never trusted as authorization.
- Staff routes require a valid Clerk session plus an active StayPilot membership. Workspace roles are `owner`, `admin`, `sales`, and `viewer`.
- Only the configured Clerk owner ID can bootstrap the first owner. Other people require a matching, verified-email workspace invitation.
- SQL values use parameters. Multi-record writes and audit/activity records use database transactions.
- Partner API secrets are random 256-bit values; only SHA-256 digests are stored. The plaintext is shown once.
- Meta webhook signatures are checked against the exact raw request bytes before the parsed payload is processed. Webhook and provider-message IDs are deduplicated.
- Public website inquiries fail closed until Turnstile is configured and affirmative consent is supplied.
- The API doesn't log request bodies, raw webhook payloads, authorization values, or provider keys.

## Quick start (local)

Requirements: Node.js 22+, npm, and a local PostgreSQL database.

1. From `apps/api/`, copy `.env.example` to `.env` and replace the local database connection and Clerk values.
2. Create an empty database, then run:

   ```bash
   npm install
   npm run migrate
   npm run dev
   ```

3. Check `http://localhost:3000/api/health` and `http://localhost:3000/api/health/ready`.
4. Sign in through your Clerk-enabled frontend. To make the initial user the owner, set `OWNER_CLERK_USER_ID` to that user's real Clerk ID before making the first authenticated request.

This package does **not** include real Clerk, Meta, or Turnstile keys. Never commit `.env`.

## Deploy the API to Railway

Follow [the Railway setup guide](docs/railway.md). Set the service root directory to `apps/api`, attach a private Railway PostgreSQL service, configure the required Railway Variables, use `npm install && npm run build` as the build command, `npm run migrate:prod` as the pre-deploy command, and `npm start` as the start command. Set the health check to `/api/health/ready`.

## Deploy the frontend to Vercel

Follow [the Vercel integration guide](docs/vercel-frontend.md). The API expects a browser bearer token issued by Clerk. Add a shared fetch helper to the existing frontend rather than creating a duplicate frontend or maintaining a second set of business rules. Set `VITE_API_BASE_URL` to the Railway API origin and `VITE_CLERK_PUBLISHABLE_KEY` to the public Clerk publishable key. The API's `WEB_ORIGINS` variable must list exact approved frontend origins.

## API reference

See [API endpoints](docs/api.md), [architecture](docs/architecture.md), [secrets/provider setup](docs/secrets-and-providers.md), and [launch checklist & limitations](docs/launch-checklist.md).

## Verification status

Latest API CI run: [run 40904115809](https://github.com/rohandhir10/StayPilot/actions/runs/40904115809) at commit `e2d9cab4` passed PostgreSQL migrations (including two concurrent migration runners), schema readiness checks, TypeScript typecheck, all 9 test files (50 tests), and production build.

These results verify the backend against CI's isolated PostgreSQL database. They do **not** verify the live browser workflow, a deployed API, real Clerk sessions, live Turnstile verification, or Meta's production webhook. Some provider behavior is mocked in tests.

Important remaining release blockers:

- `apps/api/package-lock.json` is generated and uploaded as a short-lived CI artifact, but is not yet committed. Commit and validate it before switching CI/deployment to `npm ci`.
- The audit fixes are on `audit/fix-hardening`; `main` and the Railway service still point at the original starter commit.
- The Railway service is offline, has no service domain, and has no application environment variables or PostgreSQL service configured. Its current build failed because the monorepo root directory is not set to `apps/api`.
- No Vercel project connected to this repository or frontend source was found, so the browser-to-API journey cannot yet be exercised.
- GitHub currently reports this repository as **public**. Verify that this is intentional before proceeding; do not commit production credentials or customer data.

The API is **not production-ready** until these deployment and integration blockers are resolved and the post-deployment smoke tests in [the Railway guide](docs/railway.md) pass.

## Publish to GitHub

The starter is being published to the existing private repository [`rohandhir10/StayPilot`](https://github.com/rohandhir10/StayPilot). See [the GitHub publish guide](docs/github-publish.md) for the repository and deployment workflow. A successful source upload does **not** mean the API has been configured or deployed.
