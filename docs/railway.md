# Railway API + PostgreSQL setup

Railway supports a private PostgreSQL service and a separate application service. A `DATABASE_URL` reference should point to the database service in the same Railway project; don't expose PostgreSQL publicly for the API to reach it. See [Railway PostgreSQL documentation](https://docs.railway.com/databases/postgresql) and [health checks](https://docs.railway.com/deployments/healthchecks).

## 1. Create/locate the correct project

Use the Railway project connected to the repository that will contain this backend. The connected Railway account available during preparation did not contain a project explicitly named StayPilot, so no new service or database was created here.

## 2. PostgreSQL service

Create a Railway PostgreSQL service, keep it private, enable backups/PITR if the plan supports it, and attach a database connection variable to the API service using Railway's variable reference (shown in the Railway UI), e.g. `DATABASE_URL=${{Postgres.DATABASE_URL}}` where `Postgres` is the actual database service name. Use the database-provided URL; don't copy the password into source control.

## 3. API service

Connect the correct GitHub repository to the API service. Set **Root Directory** to `apps/api` for this package layout. Configure:

| Setting | Value |
|---|---|
| Build command | `npm install --no-audit --no-fund && npm run build` (after `package-lock.json` is generated and committed, change to `npm ci && npm run build`) |
| Pre-deploy command | `npm run migrate:prod` |
| Start command | `npm start` |
| Healthcheck path | `/api/health/ready` |
| Healthcheck timeout | At least 60 seconds to allow startup/migration work |

Migration failure must fail the deployment. Do not run destructive migrations automatically, and don't edit an already-applied migration file; add the next numbered migration instead.

## 4. Required and optional Railway Variables

Use Railway's Variables UI. Do not add real values to GitHub.

| Variable | Required | Value / purpose |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `PORT` | Railway provides | Fastify listens on this port |
| `HOST` | yes | `0.0.0.0` |
| `DATABASE_URL` | yes | Reference to private PostgreSQL URL |
| `DATABASE_SSL` | yes | `true` in production |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | yes | `true`; certificate verification must stay enabled |
| `CLERK_PUBLISHABLE_KEY` | yes | Real `pk_live_…` publishable key from Clerk |
| `CLERK_SECRET_KEY` | yes | Real `sk_live_…` secret key from Clerk; Railway only |
| `OWNER_CLERK_USER_ID` | yes | Real `user_…` ID of the intended initial owner |
| `WEB_ORIGINS` | yes | Comma-separated exact HTTPS origins of approved Vercel production/preview deployments; no paths/wildcard/trailing slash |
| `TRUST_PROXY_HOPS` | not used | Fastify proxy trust is deliberately disabled. Rate limiting reads a syntactically valid `X-Real-IP` only for public-ingress bucketing; Railway's public edge overwrites this header. Private-network callers bypass that edge and must be treated as trusted workloads. |
| `DATABASE_POOL_MAX` | recommended | `10` to start; size against Railway Postgres connection limits |
| `RATE_LIMIT_PUBLIC_PER_HOUR` | recommended | `5` per contact email as an abuse-control starting point |
| `RATE_LIMIT_PARTNER_PER_MINUTE` | recommended | `120` per key as a starting point |
| `WEBHOOK_BODY_LIMIT_BYTES` | recommended | `1048576` |
| `LOG_LEVEL` | recommended | `info` |
| `META_APP_SECRET` | only for Meta webhook | Meta app secret used to verify inbound webhook HMAC |
| `META_WEBHOOK_VERIFY_TOKEN` | only for Meta webhook | A random high-entropy value chosen by the owner and entered in Meta and Railway; at least 24 characters |
| `TURNSTILE_SECRET_KEY` | only for public form | Cloudflare Turnstile secret; server-only |
| `TURNSTILE_SITE_KEY` | only for public form | Public Turnstile site key returned by the public form config endpoint |

`DATABASE_SSL=true` with `DATABASE_SSL_REJECT_UNAUTHORIZED=true` is required in production. If the selected Railway database endpoint's CA chain is not trusted by Node, configure a trusted CA instead of turning certificate validation off.

## 5. Bootstrap the first owner

1. Create the Clerk application and configure sign-in (see [provider setup](secrets-and-providers.md)).
2. Create the intended owner's account in Clerk, then copy that user's real `user_…` identifier from the Clerk Dashboard.
3. Set `OWNER_CLERK_USER_ID` in Railway and redeploy.
4. The owner signs in through the frontend; the first authenticated API request creates the owner membership in the default workspace.
5. The owner can create StayPilot workspace invitations and partner API keys through the API.

The `/api/team/invites` endpoint creates an access grant but **does not send an email**. Until an email provider/workflow is implemented, use the Clerk Dashboard or your chosen secure channel to invite the person into the Clerk application and give them the frontend sign-in URL. The API will still deny them unless the verified email matches an unexpired StayPilot invite.

## 6. Deployment smoke checks

After deployment:

- `GET /api/health` returns `200`.
- `GET /api/health/ready` returns `200` only when PostgreSQL is reachable and migration `0001_initial.sql` is registered.
- `GET /api/session` without a token returns `401`; as a signed-in but uninvited user it returns `403`; as the configured owner it returns the user/workspace/role object.
- `GET /api/leads/list` for an authorized member returns only the default workspace's inquiries.
- `POST /api/public/inquiry` without a valid Turnstile response or affirmative consent fails closed.
- Invalid Meta signatures fail before any message persistence.

Do not route real customers into this backend until the authentication, migration, CORS, provider and recovery steps have been verified against your actual deployed environment.
