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

That message belongs to an older, immutable Clerk build. The `audit/fix-hardening` branch now uses Firebase Auth and contains a separate read-only preview mode. Vercel environment changes only apply after a build, and an old deployment URL continues serving its original source.

The current branch preview build was verified as **READY** from commit `f94aa6366415a5bce33fad9c5fdce6885f70a058`. Use the [current branch preview](https://stay-pilot-git-audit-fix-hardening-rohandhir10s-projects.vercel.app/) or its current immutable deployment URL, not a URL from an older failed build. Preview deployments may require signing into the Vercel team because deployment protection is enabled.

The Vercel project has `VITE_PREVIEW_MODE=true` scoped to Preview. This should show labeled sample inquiries in read-only mode without requiring Clerk or Firebase values and without calling the live API. Never set this flag in Production.

Live Google sign-in remains separate from the read-only preview and requires the real Firebase Web App config in Vercel plus the Firebase Admin service-account JSON and owner UID in Railway.
