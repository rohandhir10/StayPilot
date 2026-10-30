# StayPilot — Next.js/Auth.js web app + Railway API

This repository package is a backend starter for the StayPilot hotel-sales CRM. It is designed for the requested deployment model:

- **GitHub:** one source of truth for code and review history.
- **Vercel:** Next.js web app and Auth.js session boundary.
- **Railway:** Fastify API and private PostgreSQL database.
- **Auth.js:** Google OAuth and restricted test credentials. The Fastify API independently verifies short-lived signed tokens and enforces workspace membership and role permissions.

> **Important status:** this is a backend starter, not a live deployment. The target private repository is `https://github.com/rohandhir10/StayPilot`. The original frontend still needs to be located and pointed at these API routes. Provider credentials are placeholders; real secrets must be created in the corresponding owner accounts and added to Railway/Vercel settings.

## What is included

`apps/api/` contains a TypeScript Fastify API, Postgres migration, validation schemas, role checks, provider webhook verification, one-time partner keys, audit/activity logging, a bounded import workflow, and tests for input validation and cryptographic helpers.

Core safety properties:

- All CRM records are scoped to the server-resolved workspace; IDs and workspace IDs from request bodies are never trusted as authorization.
- Staff routes require a valid Auth.js-issued API token plus an active StayPilot membership. Workspace roles are `owner`, `admin`, `sales`, and `viewer`.
- Only the configured owner email can bootstrap the first owner. Other people require a matching, verified-email workspace invitation.
- SQL values use parameters. Multi-record writes and audit/activity records use database transactions.
- Partner API secrets are random 256-bit values; only SHA-256 digests are stored. The plaintext is shown once.
- Meta webhook signatures are checked against the exact raw request bytes before the parsed payload is processed. Webhook and provider-message IDs are deduplicated.
- Public website inquiries fail closed until Turnstile is configured and affirmative consent is supplied.
- The API doesn't log request bodies, raw webhook payloads, authorization values, or provider keys.

## Quick start (local)

Requirements: Node.js 22+, npm, and a local PostgreSQL database.

1. From `apps/api/`, copy `.env.example` to `.env` and replace the local database connection and Auth.js API token secret and owner email.
2. Create an empty database, then run:

   ```bash
   npm install
   npm run migrate
   npm run dev
   ```

3. Check `http://localhost:3000/api/health` and `http://localhost:3000/api/health/ready`.
4. Sign in through the Next.js/Auth.js frontend. Set `OWNER_EMAIL` to the intended owner's verified Google email before the first authenticated request.

This package does **not** include real Auth.js, Google OAuth, Meta, or Turnstile credentials. Never commit `.env`.

## Deploy the API to Railway

Follow [the Railway setup guide](docs/railway.md). Set the service root directory to `apps/api`, attach a private Railway PostgreSQL service, configure the required Railway Variables, use `npm install && npm run build` as the build command, `npm run migrate:prod` as the pre-deploy command, and `npm start` as the start command. Set the health check to `/api/health/ready`.

## Deploy the frontend to Vercel

Follow [the Vercel integration guide](docs/vercel-frontend.md). The Next.js app lives in `apps/web-next`; configure the Vercel project root directory to `apps/web-next`. It issues 5-minute signed API tokens and proxies dashboard API requests server-side to Railway. Set `API_BASE_URL`, `API_AUTH_SECRET`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and `AUTH_TOKEN_ISSUER` in Vercel. The API must use the same `API_AUTH_SECRET` and issuer. The API's `WEB_ORIGINS` variable must list exact approved frontend origins.

## API reference

See [API endpoints](docs/api.md), [architecture](docs/architecture.md), [secrets/provider setup](docs/secrets-and-providers.md), and [launch checklist & limitations](docs/launch-checklist.md).

## Testing / build status

Run in `apps/api/`:

```bash
npm run typecheck
npm test
npm run build
```

Dependency installation could not be completed in the build environment because the npm registry DNS lookup failed (`EAI_AGAIN registry.npmjs.org`). Therefore, **the package has not yet been dependency-installed, fully typechecked, test-run, or deployed in this environment**. Run the commands above after the files are in the correct GitHub repository and a package registry is reachable; generate and commit `package-lock.json` before production CI so `npm ci` can be used reproducibly.

## Publish to GitHub

The starter is being published to the existing private repository [`rohandhir10/StayPilot`](https://github.com/rohandhir10/StayPilot). See [the GitHub publish guide](docs/github-publish.md) for the repository and deployment workflow. A successful source upload does **not** mean the API has been configured or deployed.
