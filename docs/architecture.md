# Architecture and trust boundaries

## Deployment topology

```text
Browser
  └─ Vercel Next.js app (Auth.js session cookie; no provider secrets in browser JS)
       ├─ Google OAuth / restricted test Credentials provider
       ├─ short-lived signed API token (5-minute expiry)
       └─ same-origin API proxy (forwards only bearer token + approved headers)
            ↓ private server-to-server HTTPS
Railway Fastify API (verifies JWT signature, issuer, audience, expiry and email verification; resolves workspace role)
  ├─ Railway PostgreSQL (private networking; TLS verification enabled)
  ├─ Cloudflare Turnstile Siteverify (public inquiry form anti-abuse)
  └─ Meta webhook endpoint (HMAC verified against raw bytes)
```

GitHub is the only code source of truth. Railway and Vercel should be connected to the correct existing repository after it is located; don't maintain an independent copy of routes or validation logic in a hosting dashboard.

## Responsibility boundaries

- **Frontend:** presentation, user interactions, field hints, signed-in token retrieval. It must never decide permissions by itself.
- **API:** authenticated user identity, verified-email check when claiming an invite, workspace membership and role, schema validation, source attribution, duplicate hints, rate limits, business transactions, webhook verification, idempotency, audit/activity entries.
- **Proxy trust:** forwarded client-IP headers are trusted only when the direct peer matches the explicit `TRUSTED_PROXY_CIDRS` allowlist. Production must use narrow, provider-confirmed ingress ranges; never use a universal CIDR.
- **PostgreSQL:** foreign keys, unique constraints, status constraints, transactional persistence, persisted idempotency/rate-limit state.
- **Auth.js:** Google OAuth, encrypted HTTP-only session cookies, CSRF protection and restricted test-only credentials. The Next.js server signs 5-minute HS256 API tokens using a separate shared secret.
- **Cutover compatibility:** the Fastify API temporarily accepts both Auth.js API tokens and existing Clerk sessions so the currently deployed Vite client is not broken before the Next.js project, secrets and Google callback are configured. Remove the Clerk fallback only after the Next.js deployment is live and verified.
- **API token:** Fastify accepts only HS256 tokens with the configured issuer, `staypilot-api` audience, verified-email claim and valid time bounds. The API secret is never exposed to browser JavaScript.
- **Provider accounts:** Meta/Turnstile credentials are configured by the owner in the secret store; integration eligibility and permissions must be approved at the provider.

## Data model overview

- `workspaces`, `workspace_members`, `workspace_invites`: single default workspace with active-member role checks and verified-email invitation acceptance.
- `leads`, `lead_activities`: canonical hotel inquiry data and append-only activity history.
- `sp_conversations`, `sp_channel_messages`: normalized channel threads/messages, associated to an inquiry only after a human confirms the link.
- `sp_channel_connections`: channel status and sync health (not provider secrets).
- `sp_webhook_events`: event idempotency/status; raw webhook payloads are not persisted.
- `sp_partner_api_keys`, `sp_partner_requests`: hashed partner keys, scopes and idempotency for server-to-server lead submission.
- `sp_rate_limit_buckets`: shared rate-limit counters for high-risk unauthenticated endpoints.
- `sp_audit_events`: significant access and mutation events. Audit rows are not auto-deleted by the included cleanup job; the owner must approve a retention policy.
- `sp_outbound_requests`: schema reserved for future audited sending/idempotency, but no external-message sending route is enabled.

## Authorization model

The API verifies the Auth.js-issued token and resolves the active `workspace_members` row by stable subject or verified email. During the staged migration it also accepts the current Clerk identity path for the old Vite deployment; this fallback is temporary and must be removed after the frontend cutover. A signed-in account without an active membership is denied. Initial owner bootstrap is restricted to the configured `OWNER_EMAIL`. Other members are added only by an invitation matching the verified email and an unexpired, unrevoked invite. Test credentials are accepted only when the API-side feature flag and exact test email match; that identity is provisioned only into the isolated `test` workspace. User IDs, role names, workspace IDs or owner claims supplied in request bodies are ignored.

Hotel workspace selection is supported in the API: `GET /api/workspaces` lists active memberships plus unexpired invitations for the verified identity, and `POST /api/workspaces` creates a workspace, owner membership, default channel connections and audit event in one transaction. Protected routes accept `X-StayPilot-Workspace-ID` only as a selector; the server still resolves an active membership for the signed-in identity in that exact workspace. If an identity has multiple active memberships and sends no selector, the API returns `409 workspace_selection_required` rather than choosing a tenant. A pending invitation is accepted only after the user explicitly selects that workspace. The dashboard stores the selected ID per browser tab. This is application-layer tenant isolation; before selling multi-tenant service, add and test database-level tenant isolation, cross-tenant negative tests for every route, tenant-specific property settings, billing/quotas and backup/restore controls.

## Transactions and idempotency

Inquiry creation inserts the lead, activity record, audit event and optional partner idempotency record in one transaction. Batch import is atomic (1–25 rows). The Meta webhook validates the signature before parsing/processing, claims a unique provider event, imports messages and marks the event processed in one transaction; a failure rolls the transaction back so the provider can retry. Partner submissions must include an `Idempotency-Key` and reuse it only for retries of the same payload.

## Failure behavior

- No valid session → `401`.
- Signed in, no active invitation/membership or role not allowed → `403`.
- Invalid/oversize fields → `400`/`413`/`422`.
- Invalid webhook signature → `401`; missing provider setup → `503`.
- Email sync route → deliberate `501` until a real connector and its retry/permissions are implemented. It does not fake success.
- Unexpected API errors return a generic message and request ID. Server logs exclude body contents and secrets.
