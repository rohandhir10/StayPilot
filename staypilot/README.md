# StayPilot — Railway API + Vercel frontend

This repository package is a backend starter for the StayPilot hotel-sales CRM. It is designed for the requested deployment model:

- **GitHub:** one source of truth for code and review history.
- **Vercel:** frontend only.
- **Railway:** Fastify API and private PostgreSQL database.
- **Clerk:** identity and sign-in. The API separately enforces StayPilot workspace membership and role permissions.

> **Important status:** this is a backend starter bundle, not a live deployment. The connected GitHub/Vercel accounts available in this session did not expose a StayPilot repository/project, so no unrelated repository was modified and no service was deployed. The original frontend still needs to be located and pointed at these API routes. Provider credentials are placeholders; real secrets must be created in the corresponding owner accounts and added to Railway/Vercel settings.

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

## Testing / build status

Run in `apps/api/`:

```bash
npm run typecheck
npm test
npm run build
```

Dependency installation could not be completed in the build environment because the npm registry DNS lookup failed (`EAI_AGAIN registry.npmjs.org`). Therefore, **the package has not yet been dependency-installed, fully typechecked, test-run, or deployed in this environment**. Run the commands above after the files are in the correct GitHub repository and a package registry is reachable; generate and commit `package-lock.json` before production CI so `npm ci` can be used reproducibly.

## Publish to GitHub

The starter is committed on local branch `main`, but **has not been pushed**. Follow [the GitHub publish guide](docs/github-publish.md) to create a new empty private `rohandhir10/staypilot` repository and push the supplied Git bundle. The connected GitHub tool in this session can write files to existing repositories but does not expose an action to create a repository.
