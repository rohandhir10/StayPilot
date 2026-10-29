# Provider setup and secret handling

Real credentials must be created or authorized in the corresponding provider account. The backend cannot invent valid external account keys. No real provider secrets are present in this bundle.

## Firebase Authentication (Google sign-in)

1. Create or select a Firebase project and register a Web App.
2. Enable **Authentication → Sign-in method → Google** and add the intended Vercel hostnames under **Authentication → Settings → Authorized domains**.
3. Put the public Web App settings (`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`) in Vercel for the intended environments.
4. Create a Firebase Admin SDK service-account JSON key from the Firebase/Google Cloud project. Store the entire JSON document only in the Railway API's encrypted `FIREBASE_SERVICE_ACCOUNT_JSON` variable, and set `FIREBASE_PROJECT_ID` to the same project ID. Never commit the JSON key or put it in Vercel.
5. Sign in once with the intended Google account, copy that account's Firebase Authentication UID, and set it as `OWNER_FIREBASE_UID` in Railway before the first authenticated CRM request.
6. Other users need a verified email matching an unexpired StayPilot invitation. The invitation endpoint creates a database access grant but does not send email itself.

The API verifies the bearer ID token with Firebase Admin including revocation checking, then uses its UID as the identity key. The API does not trust a client-supplied email, UID, or role as proof of identity. Workspace membership and role checks still run for every protected route.
## Meta (WhatsApp, Facebook, Instagram inbound events)

1. Create/configure a Meta app for the correct business/property accounts and enable only the permissions applicable to those accounts.
2. Set `META_APP_SECRET` in Railway Variables.
3. Generate a random, high-entropy webhook verification token (at least 24 characters), set it as `META_WEBHOOK_VERIFY_TOKEN` in Railway, and enter the same token in Meta webhook configuration.
4. Use the public endpoint `GET/POST https://<railway-api-host>/api/webhooks/meta` as the callback. Subscribe to the correct WhatsApp, Page, or Instagram messaging events supported by your app permissions and account eligibility.
5. Send an intentionally test event; verify the signature rejection path; only then consider the corresponding channel's `inbound_active` status genuine.

Implemented now: raw-body HMAC verification, event de-duplication, normalized inbound text events, and placeholders for media instead of downloading/retaining media. Media is **not** downloaded. Meta approval, business verification, message template rules and account eligibility remain provider-side requirements. No messages are sent by StayPilot.

## Cloudflare Turnstile (public hotel website form)

1. Create a Turnstile widget and register the exact website/preview domains.
2. Put the public site key into Railway as `TURNSTILE_SITE_KEY` (the form-config endpoint returns it to the browser) and the secret key into Railway as `TURNSTILE_SECRET_KEY`.
3. Implement the Turnstile widget in the existing Vercel frontend and POST the validated form fields to `/api/public/inquiry`. The provider's returned hostname must match a hostname in Railway's `WEB_ORIGINS` list; register production and approved preview domains with Turnstile. This backend bundle deliberately does not ship a second frontend or standalone inquiry page.
4. Verify a valid submission creates a lead, and submissions without CAPTCHA or affirmative privacy consent are rejected.

The endpoint fails closed when the secret is missing or verification is unavailable. Do not bypass CAPTCHA in production to make a form work.

## Partner API keys

An authorized owner/admin uses `POST /api/integrations/keys` or the current UI compatibility path `POST /api/integrations/api-keys` with a descriptive `name`. The backend creates a random `sp_live_…` secret, stores only a SHA-256 hash, and displays the plaintext once. Copy it straight into the approved partner's **server-side** secret manager. Never paste it into frontend JavaScript, query strings, GitHub, chat, or logs. Revoke with `DELETE /api/integrations/keys/:id` (or the compatibility delete body).

Partner submissions use `POST /api/partner/inquiries`, the header `Authorization: Bearer sp_live_…`, and a unique `Idempotency-Key` header. Scope is currently only `inquiries:create`.

## Gmail, Outlook and other channels

Gmail/Outlook OAuth mailbox sync, outbound email, WhatsApp outbound, phone-system ingest, OTA reservation/inquiry APIs and channel-manager integrations are **not connected in this release**. The channel dashboard reports status, but `/api/integrations/sync` returns `501` rather than pretending mail was synced. Each connector requires its own OAuth/token lifecycle, least-privilege scopes, provider approval, retry/backoff, paging/checkpoint strategy and tests before enabling it.
