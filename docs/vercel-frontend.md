# Vercel frontend setup

The reference dashboard is in `apps/web/` and is built with Vite. Set the Vercel project root directory to **`apps/web`**; don't point Vercel at the repository root or `apps/api`.

## Required Vercel environment variables

| Variable | Example | Notes |
|---|---|---|
| `VITE_API_BASE_URL` | `https://your-railway-api-domain.example` | API origin; the client adds `/api` if omitted. Do not include an endpoint path other than the optional `/api` suffix. |
| `VITE_CLERK_PUBLISHABLE_KEY` | `pk_live_…` | Public browser key from the Clerk Dashboard. Never add the Clerk secret key to Vercel frontend variables. |

Add variables to Development/Preview/Production environments as appropriate, then redeploy after changing them. For local development, copy `.env.example` to `.env` and use the local API origin.

## Build and routes

The project uses `npm run build` and outputs `dist/`. Vite builds three entry pages: the dashboard (`/`), Clerk sign-in (`/login`), and the public, Turnstile-protected inquiry form (`/inquiry`). Vercel rewrites these friendly paths to their HTML files.

## API and CORS

The frontend obtains a Clerk session token and sends it in the `Authorization: Bearer` header for private API requests. The API still performs workspace membership and role checks; a signed-in Clerk user does not automatically gain CRM access.

Set Railway `WEB_ORIGINS` to the exact scheme + host of each approved production and test deployment, e.g. `https://sales.example.com,https://stay-pilot-git-audit-fix-hardening-example.vercel.app`. No paths, trailing slashes, wildcards or arbitrary preview domains. If a preview URL changes, approve the specific new origin deliberately.

## Public inquiry form

`/inquiry` uses `GET /api/public/form-config` and `POST /api/public/inquiry` against the same API origin. Before using it, set both the Turnstile public site key and the server-side secret in the relevant environments. The API checks consent, rate limits and Turnstile token/hostname; submissions should fail closed while the security check is missing or invalid.

## Deployment verification boundary

A successful Vercel static build does not confirm that the Railway API is online, CORS is correct, Clerk sessions are accepted, an invitation grants workspace access, or the Turnstile hostname is approved. Test those flows after configuring both services. External reply sending and mailbox sync remain deliberately unavailable in this release.
