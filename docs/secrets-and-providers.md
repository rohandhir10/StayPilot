# Provider setup and secret handling

Real credentials must be created or authorized in the corresponding provider account. The backend cannot invent valid external account keys. No real provider secrets are present in this bundle.

## Auth.js / Google (authentication)

1. Create a Google OAuth client in Google Cloud Console for the StayPilot web application.
2. Add the exact Auth.js callback URI: `https://YOUR-VERCEL-DOMAIN/api/auth/callback/google`.
3. Set `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` in Vercel server-side environment variables only.
4. Set a unique `AUTH_SECRET` for encrypted Auth.js sessions. Do not reuse the API signing secret.
5. Set `API_AUTH_SECRET` to a separate random value of at least 32 characters in both Vercel and Railway. The API verifies tokens signed by the Next.js server using this secret.
6. Set the same exact `AUTH_TOKEN_ISSUER` in Vercel and Railway. API tokens are audience-restricted to `staypilot-api` and expire after five minutes.
7. Google sign-in is accepted only when Google's profile reports `email_verified=true`. The API still requires a workspace membership or a verified-email invitation.

## Manual test credentials

The Credentials provider is disabled unless `TEST_LOGIN_ENABLED=true`. It accepts one exact `TEST_LOGIN_EMAIL` and a bcrypt `TEST_LOGIN_PASSWORD_HASH` stored in Vercel server-side variables. The same feature flag and email must be configured on Railway. The API provisions this identity only into the synthetic `test` workspace. Never enable the provider without a strong unique password, and do not put the plaintext password or hash in GitHub.

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
3. Implement the Turnstile widget in the existing Vercel frontend and POST the validated form fields to `/api/public/inquiry`. This backend bundle deliberately does not ship a second frontend or standalone inquiry page.
4. Verify a valid submission creates a lead, and submissions without CAPTCHA or affirmative privacy consent are rejected.

The endpoint fails closed when the secret is missing or verification is unavailable. Do not bypass CAPTCHA in production to make a form work.

## Partner API keys

An authorized owner/admin uses `POST /api/integrations/keys` or the current UI compatibility path `POST /api/integrations/api-keys` with a descriptive `name`. The backend creates a random `sp_live_…` secret, stores only a SHA-256 hash, and displays the plaintext once. Copy it straight into the approved partner's **server-side** secret manager. Never paste it into frontend JavaScript, query strings, GitHub, chat, or logs. Revoke with `DELETE /api/integrations/keys/:id` (or the compatibility delete body).

Partner submissions use `POST /api/partner/inquiries`, the header `Authorization: Bearer sp_live_…`, and a unique `Idempotency-Key` header. Scope is currently only `inquiries:create`.

## Action Centre and connected mail

The Action Centre creates idempotent suggested tasks from CRM fields and the latest inbound messages already stored in `sp_channel_messages`. Its first message classifier uses conservative, tested phrase rules and attaches an evidence excerpt. It does not claim to understand every conversation. Staff must verify each suggestion, especially pricing, room availability, dates and reservations. Marking a task complete requires a human-supplied completion record; it does not send messages or modify bookings.

Testing preview uses synthetic sample conversations and never reads a live mailbox. Production uses workspace-scoped records and only messages ingested by an explicitly connected provider/webhook. WhatsApp messages flow through the existing verified Meta webhook. Gmail/Outlook require the OAuth setup below and a manual `Sync now` or `POST /api/integrations/sync`; this initial release does not run scheduled background mailbox polling.

### Configure Gmail and Outlook OAuth

Set these variables **only on the API service in Railway**. Never put OAuth client secrets or the encryption key in frontend/Vercel variables, source control, chat or logs:

- `API_PUBLIC_ORIGIN`: the exact public HTTPS origin of the deployed API (no path, e.g. `https://api.example.com`).
- `OAUTH_TOKEN_ENCRYPTION_KEY`: a base64-encoded 32-byte key. Generate a value with `openssl rand -base64 32`. Keep it backed up securely; rotating it without re-encrypting existing credentials will disconnect previously stored mail tokens.
- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`: a Google OAuth web application configured for Gmail API read-only access.
- `MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_OAUTH_CLIENT_SECRET`: a Microsoft Entra web application with delegated `Mail.Read` and `User.Read` permissions (plus the standard offline/OIDC scopes used in the authorization flow).

Register the exact redirect URIs in both provider consoles:
- `API_PUBLIC_ORIGIN/api/channels/oauth/google/callback`
- `API_PUBLIC_ORIGIN/api/channels/oauth/microsoft/callback`

Enable the Gmail API in Google Cloud. Google may require consent-screen configuration, a security review or verification for the Gmail read scope. For Microsoft, the app's supported account types and tenant consent policy must match the customer; tenant admin consent may be required. A provider app must be approved/configured before a hotel can connect its mailbox.

Only an owner/admin can start mailbox authorization. The flow uses one-use, short-lived state and PKCE. Tokens are encrypted with AES-256-GCM before storage. Gmail uses the read-only Gmail scope and the Inbox label; Microsoft Graph reads the Inbox with delegated `Mail.Read`. StayPilot imports message text/headers only (not attachments), deduplicates provider message IDs, stores a continuation cursor for bounded sync pages and exposes sync errors without returning tokens. The first sync starts with the most recent 30 days; the UI may require another Sync action when additional pages remain. OAuth access can be revoked at the provider. A refresh-token/key/permission problem is reported as a connection error, not a successful sync.

A connected mailbox is **read-only** in this release: StayPilot does not send email or create/confirm reservations. Provider credentials must exist in Railway before the Connect button can complete. Empty credentials in `apps/api/.env.example` are intentionally not working credentials.

### Other channels

WhatsApp inbound is supported only when the hotel's Meta Business app, business number, required permissions and verified webhook are configured. Testing preview messages are synthetic and never use a real inbox. WhatsApp outbound, phone-system ingest, OTA reservation APIs and channel-manager integrations are not enabled in this release.
