# Railway API + PostgreSQL setup

## Current StayPilot deployment state

The connected Railway project is `endearing-expression`. It contains the StayPilot API service and a private `Postgres` service. The API is connected to `rohandhir10/StayPilot` on branch `audit/fix-hardening`, with root directory `apps/api`, public service domain `https://staypilot-production-f8a6.up.railway.app`, pre-deploy command `npm run migrate:prod`, and health check `/api/health/ready`.

The database service deployed successfully, but the most recent API deployment failed during its migration pre-deploy command. Do not treat the API as live until database TLS, migrations, Firebase credentials, health checks, and a real authenticated browser-to-API test pass.

## 1. PostgreSQL service and private connection

Use a Railway PostgreSQL service in the same Railway project and keep it private. The StayPilot API's `DATABASE_URL` variable references `${{Postgres.DATABASE_URL}}`. Never copy database passwords into source control or Vercel.

The standard Railway Postgres image creates a self-signed certificate. This project intentionally keeps TLS certificate validation enabled, so the API must trust the database CA and use the server name in the certificate rather than turning validation off. The official image generates a CA certificate at `/var/lib/postgresql/data/certs/root.crt` and a server certificate for `localhost` (see the [template's SSL initialization script](https://github.com/railwayapp-templates/postgres-ssl/blob/main/init-ssl.sh)).

For this template, export only the public root CA certificate from the Postgres service using Railway's shell/CLI, for example:

```sh
railway ssh --service Postgres --environment production -- cat /var/lib/postgresql/data/certs/root.crt > postgres-root.crt
```

Inspect the file and confirm it contains a PEM certificate (the `-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----` lines). Do **not** export or share `root.key` or `server.key`. In Railway's **StayPilot API service Variables**, set `DATABASE_SSL_CA` to the full contents of `postgres-root.crt` and `DATABASE_SSL_SERVERNAME=localhost`. Then redeploy. If the template uses another certificate path, inspect its `postgresql.conf` / initialization script and use the configured CA file. Keep `DATABASE_SSL=true` and `DATABASE_SSL_REJECT_UNAUTHORIZED=true`.

## 2. API service

The current API service is configured as follows:

| Setting | Value |
|---|---|
| Root Directory | `apps/api` |
| Build command | `npm install --no-audit --no-fund && npm run build` |
| Pre-deploy command | `npm run migrate:prod` |
| Start command | `npm run start` |
| Healthcheck path | `/api/health/ready` |
| Healthcheck timeout | At least 60 seconds |

Migration failure must fail the deployment. Do not run destructive migrations automatically, and do not edit an already-applied migration file; add a new numbered migration instead.

## 3. Railway Variables

Use the Railway Variables UI. Do not commit real values.

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `PORT` | yes | Set to `3000` or Railway's assigned app port |
| `HOST` | yes | `0.0.0.0` |
| `DATABASE_URL` | yes | Reference to the private PostgreSQL URL |
| `DATABASE_SSL` | yes | `true` in production |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | yes | `true`; never disable certificate validation to work around a trust issue |
| `DATABASE_SSL_CA` | for custom/private CA | PEM contents of the trusted root CA certificate |
| `DATABASE_SSL_SERVERNAME` | for the stock Railway Postgres image | `localhost`, the server certificate's DNS identity |
| `FIREBASE_PROJECT_ID` | yes for live sign-in | Firebase project ID |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | yes for live sign-in | Entire Firebase Admin service-account JSON, stored as a Railway secret only |
| `OWNER_FIREBASE_UID` | yes for first owner | Firebase Authentication UID of the intended first workspace owner |
| `WEB_ORIGINS` | yes | Comma-separated exact HTTPS origins; no paths, wildcards, or trailing slashes |
| `DATABASE_POOL_MAX` | recommended | Start at `10`, adjusted to database limits |
| `RATE_LIMIT_PUBLIC_PER_HOUR` | recommended | `5` per contact/email as an abuse-control starting point |
| `RATE_LIMIT_PARTNER_PER_MINUTE` | recommended | `120` per API key as a starting point |
| `WEBHOOK_BODY_LIMIT_BYTES` | recommended | `1048576` |
| `LOG_LEVEL` | recommended | `info` |
| `META_APP_SECRET` | only for Meta webhook | Meta app secret for HMAC verification |
| `META_WEBHOOK_VERIFY_TOKEN` | only for Meta webhook | High-entropy token (at least 24 characters) configured in Meta and Railway |
| `TURNSTILE_SECRET_KEY` | only for public inquiry form | Server-only Cloudflare Turnstile secret |
| `TURNSTILE_SITE_KEY` | only for public inquiry form | Public Turnstile site key returned by the form config endpoint |

If `DATABASE_SSL_CA` is not needed because the selected database has a publicly trusted CA chain, it may be omitted. Do not set `DATABASE_SSL_REJECT_UNAUTHORIZED=false` in production.

## 4. Firebase Google sign-in

1. Create/select the Firebase project, register a Web App, enable Google in **Authentication → Sign-in method**, and add the intended Vercel hostnames under **Authentication → Settings → Authorized domains**.
2. Set the public web settings (`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`) in Vercel for the intended environments.
3. Create a Firebase Admin SDK service-account JSON key. Put the complete JSON only into Railway `FIREBASE_SERVICE_ACCOUNT_JSON`, and set `FIREBASE_PROJECT_ID` to the same project ID.
4. Sign in with the intended owner Google account and copy its Firebase Authentication UID. Set `OWNER_FIREBASE_UID` before the first authenticated CRM request.
5. Other users need a verified email matching an unexpired StayPilot workspace invitation.

Never put the Firebase Admin JSON key in the frontend, Vercel, or GitHub. The API verifies Firebase ID tokens and then enforces StayPilot workspace membership and role permissions. A Google sign-in does not automatically grant workspace access.

## 5. Deployment smoke checks

After successful deployment:

- `GET /api/health` returns `200`.
- `GET /api/health/ready` returns `200` only when PostgreSQL is reachable and migrations `0001` through `0004` are registered.
- `GET /api/session` without a token returns `401`; an authenticated but uninvited user receives `403`; the configured owner can access the default workspace.
- `GET /api/leads/list` returns only the authorized user's workspace records.
- `POST /api/public/inquiry` fails closed without valid Turnstile verification and affirmative consent.
- Invalid Meta webhook signatures fail before message persistence.

Do not route real customers into this backend until the database CA, authentication, migrations, CORS, provider integrations, and recovery steps have been verified.
