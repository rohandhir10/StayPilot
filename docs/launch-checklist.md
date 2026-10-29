# Launch checklist, limitations, and operational rules

## Before real customer data

- [ ] Locate the actual StayPilot frontend repo and integrate the shared API client; never put backend secrets in frontend code.
- [ ] Generate and commit `apps/api/package-lock.json`, then use `npm ci` in CI/build.
- [ ] Pass TypeScript typecheck, unit tests and build in GitHub Actions against the real dependency versions.
- [ ] Provision Clerk, create the initial owner, set `OWNER_CLERK_USER_ID`, and confirm an uninvited account gets `403` while the owner gets access.
- [ ] Provision Railway PostgreSQL; set `DATABASE_SSL=true` and keep certificate validation enabled. Apply migrations via Railway pre-deploy command.
- [ ] Set exact Vercel production origin in Railway `WEB_ORIGINS`; verify expected Vercel preview behavior explicitly.
- [ ] Keep Fastify `trustProxy` disabled. Verify public ingress overwrites `X-Real-IP`, rate limits bucket by that validated header, and no untrusted workload can reach the API through Railway private networking.
- [ ] Test backup/restore for PostgreSQL and decide retention/deletion for leads, messages, audit history and backups.
- [ ] Enable a verified Meta test webhook only after the app's account permissions are approved; confirm invalid signatures never write messages.
- [ ] Configure Cloudflare Turnstile for every approved `WEB_ORIGINS` hostname and test hostname mismatch, invalid/expired CAPTCHA, consent rejection, pre-verification IP limiting and success.
- [ ] Verify real business flows with test customers: create/update inquiries, view activity, link/unlink a conversation, add an internal note, preview import, duplicate confirmation, and idempotent partner retries.
- [ ] Confirm external message send actions are unavailable in UI/API while sending remains unimplemented.
- [ ] Define incident response and credential rotation owners; test partner key revocation.

## Implemented in this starter

- Workspace-scoped lead CRUD and activities.
- Input schemas, explicit status/field allow-lists and database constraints.
- Email/passwordless/session validation delegated to Clerk; workspace role check on every private route.
- Owner/admin/sales/viewer roles and invitation grants; admins cannot invite another admin unless they are the owner.
- One-time partner API key generation, SHA-256 hash at rest, revoke and last-used timestamp.
- Server-to-server partner inquiry creation with request-size limit, per-key database rate limiting and `Idempotency-Key` conflict detection.
- Atomic CSV/JSON row import in batches of up to 25; preview and possible duplicate confirmation are required before commit.
- Conversation/message tables, search, unread count, internal notes, human-confirmed inquiry links.
- Meta raw-body HMAC verification, idempotent inbound WhatsApp/Facebook/Instagram text ingestion and message deduplication.
- Public direct inquiry intake protected by Turnstile, basic form timing/honeypot, contact and IP rate limits, consent flag and audit metadata.
- Safe request logging, no-store headers, exact-origin CORS, baseline rate limit, readiness checks and graceful shutdown.

## Deliberate limitations — not enabled yet

- **No provider secrets are provisioned.** Owner-created credentials are required; this bundle doesn't contain live keys.
- **No mailbox sync yet.** Gmail and Microsoft Graph OAuth scopes/token workflow, pagination/checkpoints, reconnect handling and tests are not implemented. `/api/integrations/sync` returns 501.
- **No external replies yet.** The inbox can save internal notes only. The existence of `sp_outbound_requests` is not a sender; no WhatsApp/email/social sending endpoint is enabled.
- **No OTA connector yet.** Booking.com, Expedia and channel-manager access needs approved partner/account access plus provider-specific adapters.
- **Meta requires approval and configuration.** Webhook intake handles selected inbound message payloads; it ignores status/delivery events and does not download media/attachments. Business verification, app permissions and subscribed topics remain provider-side work.
- **No email invite delivery.** Team invites create workspace grants, but email delivery/Clerk invitation creation is not implemented.
- **Single default workspace.** Schema records carry `workspace_id`, but multi-workspace account switching, per-hotel tenancy and operator-facing workspace selection are not implemented/tested.
- **No confirmed booking/PMS synchronization.** An inquiry or conversation is not a reservation. Hotel inventory/pricing and live availability are outside this backend.
- **No automated data deletion for lead/message content.** Audit events are retained until the owner approves a retention policy. The scheduled cleanup removes only expired rate-limit buckets and old webhook event metadata (processed/ignored after 90 days; failed after 30 days). This is not a compliance certification.
- **Rate limiting is layered, not a DDoS provider.** The Fastify per-IP limiter is per process/instance; public email/IP and partner-key limits are database-backed. Production proxy trust must be configured correctly, and provider-level/network rate protection may still be needed.
- **Duplicate detection is advisory.** The import/inquiry overlap logic does not auto-merge or guarantee detection of all duplicates; concurrent submissions can still become separate inquiries.
- **Dependency/test caveat for this handoff.** npm package installation was unavailable due DNS failure, so dependency installation, a generated lockfile, full typecheck, tests, and production build remain pending. Do not call this production-verified until CI passes.

## Retention and privacy

Messages and lead contact details are retained in PostgreSQL until deliberately deleted; the endpoint to delete customer data and a retention scheduler for leads/messages are not included. Before production, decide the business retention period and data access policy, provide an applicable privacy notice, restrict CSV export access, and test backup restoration/deletion requirements. Don't claim a data-protection certification based only on this code.

## Incident-response minimum

1. Revoke a suspected leaked partner key in StayPilot; rotate the source-side secret and examine audit events.
2. Rotate Meta app/webhook secrets in the provider account and Railway Variables, then re-verify the webhook.
3. Rotate Clerk keys if a backend secret leaks; review active sessions and environment history.
4. Preserve relevant logs without copying customer content or secrets into tickets.
5. Restore the database only from a verified backup and keep the affected service blocked until credentials and access checks are revalidated.
