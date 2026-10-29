# Provider setup and secret handling

Real credentials must be created or authorized in the corresponding provider account. Never send secrets through chat, commit them to GitHub, or put backend secrets in browser JavaScript.

## Gmail and Microsoft Outlook OAuth

The API branch now includes OAuth authorization-code + PKCE routes, encrypted token storage (AES-256-GCM), refresh-token handling, inbox import, disconnect routes, and provider connection status updates. This is an initial inbox-sync implementation, not yet production-verified. It does not send replies. It reads up to 50 recent inbox messages per manual sync; pagination/delta sync and scheduled background sync remain to be completed.

Configure these Railway variables:
- `PUBLIC_API_URL`: exact public HTTPS API origin, without a trailing slash.
- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
- `MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_OAUTH_CLIENT_SECRET`.
- `INTEGRATION_TOKEN_ENCRYPTION_KEY`: stable base64-encoded 32-byte key. Generate with `openssl rand -base64 32`. Store securely and do not rotate without reconnecting every mailbox.

Register the following exact redirect URIs with each OAuth provider:
- `https://<railway-api-host>/api/integrations/oauth/google/callback`
- `https://<railway-api-host>/api/integrations/oauth/microsoft/callback`

API routes:
- `POST /api/integrations/email/google/connect` or `POST /api/integrations/email/microsoft/connect` returns an authorization URL. Open it in the browser from the authenticated UI.
- Provider redirects back to the registered callback.
- `POST /api/integrations/email/google/sync` or `POST /api/integrations/email/microsoft/sync` imports recent inbox messages.
- `DELETE /api/integrations/email/google` or `DELETE /api/integrations/email/microsoft` disconnects and deletes stored credentials.

Google scopes are read-only Gmail plus basic email identity. Microsoft scopes are Mail.Read, User.Read and offline_access. Do not add sending scopes until outbound delivery, approval and audit controls are implemented. Test revoked consent, expired access tokens, duplicate syncs, oversized messages, HTML sanitization, account disconnect, and wrong/expired/replayed OAuth state before production.

## Clerk (authentication)

1. Create a Clerk application owned by the intended StayPilot operator.
2. Copy the publishable key to Vercel as `VITE_CLERK_PUBLISHABLE_KEY` and the matching secret key to Railway as `CLERK_SECRET_KEY`.
3. Add the same publishable key to Railway as `CLERK_PUBLISHABLE_KEY`.
4. Configure allowed application origins and sign-in behavior in Clerk; use production keys for production.
5. Create the intended first owner account and set the user's real `user_…` ID as Railway's `OWNER_CLERK_USER_ID` before first API sign-in.
6. Other users require an authenticated Clerk session and a verified email matching an unexpired StayPilot workspace invitation.

## Meta (WhatsApp, Facebook, Instagram inbound events)

1. Create/configure a Meta app for the correct business/property accounts and enable only the permissions applicable to those accounts.
2. Set `META_APP_SECRET` in Railway Variables.
3. Generate a random, high-entropy webhook verification token (at least 24 characters), set it as `META_WEBHOOK_VERIFY_TOKEN` in Railway, and enter the same token in Meta webhook configuration.
4. Use `GET/POST https://<railway-api-host>/api/webhooks/meta` as the callback. Subscribe to the correct WhatsApp, Page, or Instagram messaging events supported by your app permissions and account eligibility.
5. Test valid and invalid signatures with a test account before enabling the channel.

Implemented: raw-body HMAC verification, event de-duplication and normalized inbound text ingestion. Media is not downloaded. Meta approval, business verification, message template rules and account eligibility remain provider-side requirements. Outbound replies are not implemented.

## Cloudflare Turnstile (public hotel website form)

1. Create a Turnstile widget and register the exact website/preview domains.
2. Set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` in Railway Variables.
3. Implement the Turnstile widget in the actual Vercel frontend and POST validated fields to `/api/public/inquiry`.
4. Verify submissions without CAPTCHA or affirmative privacy consent are rejected.

The endpoint fails closed when the secret is missing or verification is unavailable. Do not bypass CAPTCHA in production.

## Travel agents, corporate partners and integrations

An owner/admin can create a partner key with `POST /api/integrations/keys`. The backend creates a random `sp_live_…` secret, stores only a SHA-256 hash and displays the plaintext once. Store it only in the partner's server-side secret manager. Revoke it with `DELETE /api/integrations/keys/:id`.

Partner submissions use `POST /api/partner/inquiries`, `Authorization: Bearer sp_live_…`, and a unique `Idempotency-Key` header. Current scope is `inquiries:create`. CSV/JSON import is supported with preview and duplicate confirmation.

## Phone, Booking.com, Expedia and other OTAs

These require a specific telephony vendor or provider-approved OTA/channel-manager API access. Do not scrape extranets, automate browser logins, or assume that public APIs allow reservation data access. The current release does not yet ingest phone-system call events or sync Booking.com/Expedia reservations/messages. Until official access is available, phone calls should be logged manually and partner enquiries should use the StayPilot partner API or import flow.

## Not yet complete

- Outbound email, WhatsApp and social replies.
- Scheduled background sync, full mailbox pagination/delta checkpoints, and robust provider retry/backoff.
- Booking.com/Expedia/channel-manager adapters and telephony webhooks.
- Email delivery for team invitations.
- The frontend integration settings UI and end-to-end production verification.
- Full TypeScript/test/build validation in CI and a reproducible package lockfile.

Never mark a channel as connected or live until provider credentials, permissions, callback/webhook delivery and real test events have been verified.
