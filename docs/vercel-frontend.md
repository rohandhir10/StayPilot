# Vercel Next.js application

Set the Vercel project **Root Directory** to `apps/web-next`. Framework preset: Next.js. Build command: `npm run build`; install command: `npm install --no-audit --no-fund`; output: Next.js default. Node.js 22 is required.

## Required Vercel environment variables

| Variable | Purpose |
|---|---|
| `AUTH_SECRET` | Auth.js session encryption secret; generate a unique random value with `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` | Google OAuth client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret; server-only |
| `API_AUTH_SECRET` | Independent 32+ character secret used to sign 5-minute API tokens; must match Railway exactly |
| `AUTH_TOKEN_ISSUER` | Exact issuer string; must match Railway `AUTH_TOKEN_ISSUER` |
| `API_BASE_URL` | Railway API origin only, e.g. `https://your-api.up.railway.app`, without path |
| `TEST_LOGIN_ENABLED` | Set to `true` only on a controlled test deployment |
| `TEST_LOGIN_EMAIL` | Exact test account email; must match the Railway value |
| `TEST_LOGIN_PASSWORD_HASH` | bcrypt hash of the test password; never commit it or expose it to browser code |

Do not reuse `AUTH_SECRET` as `API_AUTH_SECRET`. Do not put database URLs, provider secrets, password hashes or API signing secrets in `NEXT_PUBLIC_*` variables.

## Authentication and API flow

Auth.js creates an HTTP-only session cookie. Google accounts are accepted only when Google reports `email_verified=true`. The restricted Credentials provider is disabled unless `TEST_LOGIN_ENABLED=true` and checks one exact email against a bcrypt password hash.

The dashboard obtains a short-lived API token from `/api/auth/api-token`. The Next.js server signs this token; the browser never receives the signing secret. Dashboard API requests use the same-origin `/api/backend/*` proxy, which forwards only the bearer token and approved request headers to Railway. The API verifies signature, issuer, audience, expiry and verified-email claim before resolving membership and permissions.

## Test account isolation

Enable manual test credentials only in Vercel Preview (or local development), never Production. Set `TEST_LOGIN_ENABLED=true` and the exact `TEST_LOGIN_EMAIL` for Preview in Vercel, and matching values in Railway. The application explicitly suppresses the Credentials provider when `VERCEL_ENV=production`. Generate a bcrypt hash locally; do not share or commit the plaintext password. The API provisions this account into the dedicated `test` workspace created by migration `0006_test_workspace.sql`, which contains synthetic sample leads and no production customer records. Test access does not grant access to the default workspace.

## Google OAuth callback

Configure the Google OAuth consent screen and add the exact Auth.js redirect URI:

`https://YOUR-VERCEL-DOMAIN/api/auth/callback/google`

Also configure the production domain as an authorized JavaScript origin where required by Google. Add preview callback URLs only for explicitly trusted preview domains.

## Deployment safety

The new app is not ready for production cutover until the Next.js build, API typecheck/tests, migration, Google callback, test login, API proxy, membership and role checks have all passed. Keep the old Vite deployment available for rollback until then.
