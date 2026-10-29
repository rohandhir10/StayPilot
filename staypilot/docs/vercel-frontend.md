# Vercel frontend integration

The backend does not replace or duplicate the frontend. Connect the existing frontend repository to Vercel and use the Railway service's HTTPS origin as its API origin. A Vercel project/repository named StayPilot was not visible in the connected account used during preparation, so this document is a setup contract rather than a claim that the frontend has been wired.

## Vercel environment variables

| Variable | Environment | Notes |
|---|---|---|
| `VITE_API_BASE_URL` | Production/Preview/Development | Railway API origin only, e.g. `https://<your-api-service>.up.railway.app` (no trailing slash and no `/api` suffix) |
| `VITE_CLERK_PUBLISHABLE_KEY` | Production/Preview/Development | Public Clerk publishable key (`pk_live_…` in production) |

Never put `CLERK_SECRET_KEY`, `DATABASE_URL`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `TURNSTILE_SECRET_KEY`, or any partner API secret into Vercel frontend variables prefixed with `VITE_`, `NEXT_PUBLIC_`, or any other client-exposed namespace.

## Fetch contract

Private endpoints require a Clerk session bearer token. A plain `fetch('/api/leads/list')` call is not sufficient when the API lives on Railway. For React with Clerk, a single shared client helper can look like this:

```ts
const API_ORIGIN = (import.meta.env.VITE_API_BASE_URL as string).replace(/\/$/, '');

type TokenProvider = () => Promise<string | null>;

export async function stayPilotFetch<T>(
  getToken: TokenProvider,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error('Sign in to StayPilot first.');

  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body.error === 'string' ? body.error : `Request failed (${response.status}).`;
    const error = new Error(message) as Error & { status?: number; code?: string; body?: unknown };
    error.status = response.status;
    error.code = typeof body.code === 'string' ? body.code : undefined;
    error.body = body;
    throw error;
  }
  return body as T;
}
```

Example in a React component:

```ts
const { getToken } = useAuth();
const data = await stayPilotFetch(() => getToken(), '/api/leads/list');
```

Use the *same* helper for existing UI pages and actions. Don't copy authorization logic into each page. `GET /api/public/form-config` and `POST /api/public/inquiry` are public endpoints and can use ordinary `fetch`; the public form submission still requires a valid Turnstile token and privacy-consent flag.

## CORS configuration

Set Railway `WEB_ORIGINS` to exact origins, e.g. `https://your-frontend.vercel.app,https://sales.example.com`. An origin consists of scheme + hostname + optional port, with no path or trailing slash. Do not use `*`. Vercel preview domains can vary by branch/commit; list the specific trusted preview origin you are testing, or use a stable preview domain you control. Do not use a broad regex that trusts arbitrary `*.vercel.app` sites.

## Existing UI routes preserved

The backend includes compatibility paths for the current UI's lead CRUD, `/api/session`, unified inbox, channel status, CSV import and `/api/integrations/api-keys`. But the existing frontend still needs to be updated to call the Railway API origin and attach the Clerk bearer token. The current Hatchable prototype frontend was not found in the connected GitHub account, so that edit has not been made in a Vercel repository.
