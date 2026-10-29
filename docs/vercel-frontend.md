# Vercel frontend setup

The dashboard is in `apps/web/` and uses Vite. Set the Vercel project root directory to **`apps/web`**, build command to `npm run build`, and output directory to `dist`. Do not point Vercel at `apps/api`.

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | Vercel (all environments) | HTTPS Railway API URL, with or without the `/api` suffix. |
| `VITE_FIREBASE_API_KEY` | Vercel (all environments) | Public Firebase Web App API key. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Vercel (all environments) | Firebase Auth domain, typically `<project-id>.firebaseapp.com`. |
| `VITE_FIREBASE_PROJECT_ID` | Vercel (all environments) | Firebase project ID. |
| `VITE_FIREBASE_APP_ID` | Vercel (all environments) | Firebase Web App ID. |
| `VITE_PREVIEW_MODE` | Vercel Preview only | Set to `true` to show read-only sample records without requesting live API data. Do not set this for Production. |

The Firebase web config is public browser configuration, not an Admin credential. Never put `FIREBASE_SERVICE_ACCOUNT_JSON` or any private key in Vercel. After changing variables, deploy a fresh build.

## Google sign-in

In Firebase Console, register a Web App, enable **Authentication → Sign-in method → Google**, and add each intended Vercel hostname under **Authentication → Settings → Authorized domains**. The sign-in page uses Google OAuth through Firebase Auth; users still need StayPilot workspace membership before accessing actual CRM records.

## Routes and preview behavior

Vite builds the dashboard (`/`), Google sign-in (`/login`), and public, Turnstile-protected inquiry form (`/inquiry`). Vercel rewrites the friendly paths to their HTML entries.

When `VITE_PREVIEW_MODE=true` is configured for Preview, the dashboard shows clearly marked demo records in read-only mode. It does not call the CRM API or write data. This makes UI review possible before Firebase credentials and the API are fully configured. Keep this flag Preview-only.

## API and CORS

In configured deployments, the frontend obtains a Firebase ID token and sends it in the `Authorization: Bearer` header. The API verifies that token with Firebase Admin and separately enforces workspace membership and role permissions. A Google-authenticated user does not automatically gain CRM access.

Set Railway `WEB_ORIGINS` to the exact scheme + host of each approved origin. Avoid paths, trailing slashes, wildcards or arbitrary preview domains. Approve changed preview URLs deliberately.

## Public inquiry form

`/inquiry` uses `GET /api/public/form-config` and `POST /api/public/inquiry` against the API. Before using it, set the Turnstile public site key and server-side secret in the relevant environments. Submissions fail closed while Turnstile is missing or invalid.

## Deployment verification boundary

A successful Vercel static build does not prove that Google sign-in, Firebase token verification, database migrations, CORS, invitations, or Turnstile work end to end. Real Firebase web config and the Admin service-account JSON must come from the Firebase project owner. Do not commit them.


## Troubleshooting: existing preview still says “StayPilot needs configuration”

That message is from an older, already-built Clerk frontend. The source on `audit/fix-hardening` has been migrated to Firebase Auth and includes a read-only preview mode. Vercel environment changes do not alter an existing deployment; Vercel must build the latest branch after these changes.

The connected Vercel API available during this task returned permission errors for preview deployment creation and project creation, so a new deployment could not be triggered through that connection. In Vercel, connect the `rohandhir10/StayPilot` Git repository to the frontend project (or restore deploy permissions), keep the root directory at `apps/web`, and deploy branch `audit/fix-hardening` as a **Preview**, not Production. The project already has `VITE_PREVIEW_MODE=true` scoped to Preview. That build should show explicitly labeled sample inquiries in read-only mode without Clerk or Firebase values. Do not reuse the old immutable deployment URL to verify the new source.

Live Google sign-in remains separate from the read-only preview and requires the real Firebase Web App config in Vercel plus the Firebase Admin service-account JSON and owner UID in Railway.
