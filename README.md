# StayPilot — Railway API + Vercel frontend

This repository contains the StayPilot hotel-sales CRM web app and backend API. The frontend follows the visual design and interaction patterns from the Hospitality Sales Intelligence reference app. It is designed for this deployment model:

- **GitHub:** one source of truth for code and review history.
- **Vercel:** frontend only.
- **Railway:** Fastify API and private PostgreSQL database.
- **Firebase Authentication:** Google identity and sign-in. The API separately enforces StayPilot workspace membership and role permissions.

> **Important status:** the audit work and the new full web app are on `audit/fix-hardening`, not `main`. Source has been pushed to GitHub, but production configuration and a live browser-to-database workflow are not yet verified. The GitHub repository currently reports **public** visibility; confirm that this is intentional. Provider credentials are placeholders; create real secrets in the relevant owner accounts and add them only to Railway/Vercel settings.

## What is included

`apps/web/` contains the reference dashboard, authenticated sign-in page, public hotel inquiry form, Vite multi-page build and Vercel routing. `apps/api/` contains the TypeScript Fastify API, Postgres migrations, validation schemas, workspace role checks, provider webhook verification, one-time partner keys, audit/activity logging, a bounded import workflow and automated tests.

Core safety properties:

- All CRM records are scoped to the server-resolved workspace; IDs and workspace IDs from request bodies are never trusted as authorization.
- Staff routes require a valid Firebase Authentication session plus an active StayPilot membership. Workspace roles are `owner`, `admin`, `sales`, and `viewer`.
- Only the configured Firebase Authentication owner ID can bootstrap the first owner. Other people require a matching, verified-email workspace invitation.
- SQL values use parameters. Multi-record writes and audit/activity records use database transactions.
- Partner API secrets are random 256-bit values; only SHA-256 digests are stored. The plaintext is shown once.
- Meta webhook signatures are checked against the exact raw request bytes before the parsed payload is processed. Webhook and provider-message IDs are deduplicated.
- Public website inquiries fail closed until Turnstile is configured and affirmative consent is supplied.
- The API doesn't log request bodies, raw webhook payloads, authorization values, or provider keys.

## Quick start (local)

Requirements: Node.js 22+, npm, and a local PostgreSQL database.

1. From `apps/api/`, copy `.env.example` to `.env` and replace the local database connection and Firebase Auth values.
2. Create an empty database, then run:

   ```bash
   npm install
   npm run migrate
   npm run dev
   ```

3. Check `http://localhost:3000/api/health` and `http://localhost:3000/api/health/ready`.
4. Sign in through your Firebase-enabled frontend. To make the initial user the owner, set `OWNER_FIREBASE_USER_ID` to that user's real Firebase Authentication ID before making the first authenticated request.

This package does **not** include real Firebase Authentication, Meta, or Turnstile keys. Never commit `.env`.

## Deploy the API to Railway

Follow [the Railway setup guide](docs/railway.md). Set the service root directory to `apps/api`, attach a private Railway PostgreSQL service, configure the required Railway Variables, use `npm install && npm run build` as the build command, `npm run migrate:prod` as the pre-deploy command, and `npm start` as the start command. Set the health check to `/api/health/ready`.

## Run and deploy the frontend

From `apps/web/`, copy `.env.example` to `.env`, set `VITE_API_BASE_URL` to the Railway API origin and the four `VITE_FIREBASE_*` Web App settings from Firebase Console, then run `npm install`, `npm run typecheck` and `npm run build`. The Vercel project root must be `apps/web`. Follow [the Vercel setup guide](docs/vercel-frontend.md). Add the exact approved frontend origin(s) to Railway `WEB_ORIGINS`. The public `/inquiry` form requires Turnstile site/secret configuration before submissions can succeed.

## API reference

See [API endpoints](docs/api.md), [architecture](docs/architecture.md), [secrets/provider setup](docs/secrets-and-providers.md), and [launch checklist & limitations](docs/launch-checklist.md).

## Verification status

Latest API CI run: [run 40904115809](https://github.com/rohandhir10/StayPilot/actions/runs/40904115809) at commit `e2d9cab4` passed PostgreSQL migrations (including two concurrent migration runners), schema readiness checks, TypeScript typecheck, all 9 test files (50 tests), and production build.

These results verify the backend against CI's isolated PostgreSQL database. They do **not** verify the live browser workflow, a deployed API, real Firebase sessions, live Turnstile verification, or Meta's production webhook. Some provider behavior is mocked in tests.

Important remaining release blockers:

- `apps/api/package-lock.json` and `apps/web/package-lock.json` are currently generated by CI and uploaded as short-lived artifacts, but are not committed yet. Commit both verified lockfiles before switching CI/deployment to `npm ci`.
- The audit fixes are on `audit/fix-hardening`; `main` and the Railway service still point at the original starter commit.
- The Railway service is offline, has no service domain, and has no application environment variables or PostgreSQL service configured. Its current build failed because the monorepo root directory is not set to `apps/api`.
- The frontend source is now in `apps/web/`. The connected `stay-pilot` Vercel project has been changed from Fastify to Vite with Root Directory `apps/web`, but the prior deployment has not been redeployed. The Vercel project currently has no environment variables; it needs the real Firebase Authentication publishable key and deployed Railway API origin before a complete browser-to-API smoke test can pass.
- GitHub currently reports this repository as **public**. Verify that this is intentional before proceeding; do not commit production credentials or customer data.

The API is **not production-ready** until these deployment and integration blockers are resolved and the post-deployment smoke tests in [the Railway guide](docs/railway.md) pass.

## Publish to GitHub

The work has been pushed to the existing repository [`rohandhir10/StayPilot`](https://github.com/rohandhir10/StayPilot) on branch `audit/fix-hardening`; `main` has not been changed. See [the GitHub publish guide](docs/github-publish.md) for the repository and deployment workflow. A successful source upload does **not** mean the API has been configured or deployed.
