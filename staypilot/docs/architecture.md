# Architecture and trust boundaries

## Deployment topology

```text
Browser
  ├─ Vercel frontend (public JS; only publishable keys and API origin)
  └─ HTTPS fetch with Clerk session bearer token
       ↓ exact-origin CORS
Railway Fastify API (private application secrets; validates identity and role)
  ├─ Railway PostgreSQL (private networking; TLS verification enabled)
  ├─ Clerk Backend API (verified user email + identity lookup)
  ├─ Cloudflare Turnstile Siteverify (public inquiry form anti-abuse)
  └─ Meta webhook endpoint (HMAC verified against raw bytes)
```

GitHub is the only code source of truth. Railway and Vercel should be connected to the correct existing repository after it is located; don't maintain an independent copy of routes or validation logic in a hosting dashboard.

## Responsibility boundaries

- **Frontend:** presentation, user interactions, field hints, signed-in token retrieval. It must never decide permissions by itself.
- **API:** authenticated user identity, verified-email check when claiming an invite, workspace membership and role, schema validation, source attribution, duplicate hints, rate limits, business transactions, webhook verification, idempotency, audit/activity entries.
- **PostgreSQL:** foreign keys, unique constraints, status constraints, transactional persistence, persisted idempotency/rate-limit state.
- **Clerk:** session creation, verification, recovery, session token validation, Backend API for account profile lookup.
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

The API resolves the logged-in Clerk user server-side. It then finds the active `workspace_members` row for that user. A signed-in account without an active membership is denied. The only exception is initial owner bootstrap when the authenticated Clerk user ID matches `OWNER_CLERK_USER_ID`. Other members are added only by an invitation that matches a verified email address and has not expired or been revoked. User IDs, role names, workspace IDs or owner claims supplied in request bodies are ignored.

Current scope is one default StayPilot workspace, appropriate for one hotel sales operation. Multi-workspace tenant selection and cross-portfolio isolation are not yet implemented; do not market this starter as a multi-customer SaaS without extending the membership resolver and tests.

## Transactions and idempotency

Inquiry creation inserts the lead, activity record, audit event and optional partner idempotency record in one transaction. Batch import is atomic (1–25 rows). The Meta webhook validates the signature before parsing/processing, claims a unique provider event, imports messages and marks the event processed in one transaction; a failure rolls the transaction back so the provider can retry. Partner submissions must include an `Idempotency-Key` and reuse it only for retries of the same payload.

## Failure behavior

- No valid session → `401`.
- Signed in, no active invitation/membership or role not allowed → `403`.
- Invalid/oversize fields → `400`/`413`/`422`.
- Invalid webhook signature → `401`; missing provider setup → `503`.
- Email sync route → deliberate `501` until a real connector and its retry/permissions are implemented. It does not fake success.
- Unexpected API errors return a generic message and request ID. Server logs exclude body contents and secrets.
