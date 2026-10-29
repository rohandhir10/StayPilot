# Launch checklist, limitations, and operational rules

## Before real customer data

- [ ] Locate the actual StayPilot frontend repo and connect the integration settings UI to the API routes; never put backend secrets in frontend code.
- [ ] Generate and commit `apps/api/package-lock.json`, then use `npm ci` in CI/build.
- [ ] Pass TypeScript typecheck, unit tests and production build in CI.
- [ ] Provision Clerk, create the initial owner, set `OWNER_CLERK_USER_ID`, and confirm an uninvited account gets `403` while the owner gets access.
- [ ] Provision Railway PostgreSQL; set `DATABASE_SSL=true` and keep certificate validation enabled. Apply all migrations via Railway pre-deploy command.
- [ ] Set exact Vercel production origin in Railway `WEB_ORIGINS`; verify preview behavior explicitly.
- [ ] Set the verified Railway proxy hop count; test real client IP handling.
- [ ] Test PostgreSQL backup/restore and approve retention/deletion rules for leads, messages, audit history and backups.
- [ ] Configure Gmail/Outlook OAuth apps, exact callback URLs and the stable token encryption key; test PKCE, replay/expiry rejection, token refresh, mailbox sync, disconnect and reconnect.
- [ ] Confirm repeat mailbox syncs do not duplicate messages and errors do not falsely mark channels healthy.
- [ ] Enable a verified Meta test webhook only after account permissions are approved; confirm invalid signatures never write messages.
- [ ] Configure Cloudflare Turnstile for the public inquiry form; test invalid/expired CAPTCHA, consent rejection, rate limiting and success.
- [ ] Verify inquiry CRUD, activity history, conversation links, internal notes, import preview, duplicate confirmation and idempotent partner retries.
- [ ] Keep outbound sends disabled until provider permissions, audited sending, idempotency, delivery status and human confirmation are implemented and tested.
- [ ] Obtain official OTA/channel-manager and telephony access before promising those integrations.
- [ ] Define incident response and credential rotation owners; test partner-key revocation.

## Implemented in this starter

- Workspace-scoped lead CRUD and activities.
- Input schemas, explicit status/field allow-lists and database constraints.
- Clerk session validation, workspace roles and invitation checks.
- One-time partner API key generation, SHA-256 hash at rest, revocation and last-used timestamp.
- Server-to-server partner inquiry creation with request-size limit, per-key rate limiting and `Idempotency-Key` conflict detection.
- Atomic CSV/JSON row import in batches of up to 25; preview and possible duplicate confirmation are required before commit.
- Conversation/message tables, search, unread count, internal notes and human-confirmed inquiry links.
- Meta raw-body HMAC verification and idempotent inbound WhatsApp/Facebook/Instagram text ingestion.
- Public website inquiry intake protected by Turnstile, timing/honeypot, contact and IP rate limits, consent and audit metadata.
- Gmail/Outlook OAuth route foundation on branch `feat/provider-integrations-foundation`: PKCE state, encrypted token storage, token refresh, recent-inbox import and disconnect route.
- Safe request logging, no-store headers, exact-origin CORS, baseline rate limits, readiness checks and graceful shutdown.

## Deliberate limitations

- Provider credentials are not provisioned. The OAuth routes are not live until owner-managed Google/Microsoft credentials and a stable encryption key are configured.
- Email sync currently reads up to 50 recent inbox messages per manual sync. Full pagination/delta checkpoints and scheduled background sync are not implemented.
- Email OAuth code has not yet passed dependency installation, typecheck, tests or production build in this environment. Do not call it production-ready until CI passes.
- No external email/WhatsApp/social sending route is enabled. Internal notes are not external replies.
- No Booking.com, Expedia or channel-manager connector. Access requires approved provider/partner credentials and provider-specific adapters.
- No phone-system call-event integration; manual call logging remains the safe fallback.
- Meta requires app approval, business verification, correct subscriptions and channel permissions; webhook intake does not download media.
- Team invitations do not yet send email or automatically create a Clerk invitation.
- Single default workspace only. Multi-hotel tenant selection and cross-customer isolation are not complete or tested.
- No confirmed booking/PMS synchronization. An enquiry or conversation is not a reservation.
- No automated deletion of lead/message content. The cleanup job only removes expired rate-limit buckets and old webhook event metadata; retention policy and deletion workflow remain to be completed.
- Duplicate detection is advisory and does not guarantee detection of all duplicates.
- Provider/network-level DDoS protection is still required; the built-in per-IP limiter is per process/instance.

## Retention and privacy

Messages and lead contact details remain in PostgreSQL until deliberately deleted; a full customer-data deletion endpoint and retention scheduler for leads/messages are not included. Before production, approve retention and access policies, publish an appropriate privacy notice, restrict exports, and test backup restoration/deletion requirements. Do not claim a data-protection certification based only on this code.

## Incident-response minimum

1. Revoke a suspected leaked partner key in StayPilot; rotate the source-side secret and examine audit events.
2. Rotate Meta app/webhook secrets in the provider account and Railway Variables, then re-verify the webhook.
3. Rotate Clerk keys if a backend secret leaks; review sessions and environment history.
4. Rotate the OAuth token-encryption key only with a controlled mailbox reconnect/migration plan; losing the key makes stored provider tokens unreadable.
5. Preserve relevant logs without copying customer content or secrets into tickets.
6. Restore the database only from a verified backup and keep the affected service blocked until credentials and access checks are revalidated.
