# API reference

All paths include `/api`. Private endpoints require `Authorization: Bearer <Clerk session token>`, except the partner endpoint which uses its own `sp_live_…` key. Private responses use `Cache-Control: no-store`. Collection endpoints use keyset pagination: pass `next_cursor` back as `cursor` until `has_more` is false. Cursors are opaque, validated seek positions and do not replace workspace authorization.

## Health

| Method | Route | Access | Purpose |
|---|---|---|---|
| GET | `/api/health` | Public | Process liveness |
| GET | `/api/health/ready` | Public | PostgreSQL and migration readiness |

## Workspace and team

| Method | Route | Access | Purpose |
|---|---|---|---|
| GET | `/api/session` | Clerk + active member | Compatibility route; user, workspace, role and UI permissions |
| GET | `/api/me` | Clerk + active member | Alias for current user/workspace |
| GET | `/api/team/invites` | Owner/admin | List workspace invites |
| POST | `/api/team/invites` | Owner/admin | Create a 7-day verified-email access grant; no email is sent |
| POST | `/api/team/invites/:id/revoke` | Owner/admin | Revoke a pending invite |
| GET | `/api/team/members` | Owner/admin | List active/inactive members |
| POST | `/api/team/members/:userId/deactivate` | Owner/admin | Deactivate access (owner cannot be deactivated; admin can only be deactivated by owner) |
| POST | `/api/team/members/:userId/reactivate` | Owner/admin | Restore inactive access (only owner may reactivate an owner/admin) |

## Inquiries

| Method | Route | Access | Purpose |
|---|---|---|---|
| GET | `/api/leads/list?limit=100&cursor=…` | Clerk + active member | Workspace-scoped list and human-review duplicate candidates |
| POST | `/api/leads/create` | Owner/admin/sales | Validate and create an inquiry + activity + audit in one transaction |
| POST | `/api/leads/update` | Owner/admin/sales | Update allowed fields and log activity/audit |
| GET | `/api/leads/activities?id=<uuid>` | Clerk + active member | Read recent activity after checking workspace membership |
| POST | `/api/leads/import` | Owner/admin/sales | Preview 1–25 JSON rows; every `mode: commit` requires `Idempotency-Key`. If matches exist, send `confirm_duplicates: true` with the same key. Replays return the original lead IDs without creating extra inquiries. |

## Unified inbox

| Method | Route | Access | Purpose |
|---|---|---|---|
| GET | `/api/inbox/conversations?limit=50&channel=whatsapp&q=search&cursor=…` | Clerk + active member | Search and filter conversations |
| PATCH | `/api/inbox/conversations/:id/status` | Owner/admin/sales | Change conversation status to open, pending, or closed; records an audit event |
| GET | `/api/inbox/messages?conversation_id=<uuid>&limit=200&cursor=…` | Clerk + active member | Return latest 200 messages in chronological order |
| POST | `/api/inbox/messages` | Owner/admin/sales | Create an internal note; never sends an external message |
| POST | `/api/inbox/link` | Owner/admin/sales | Link/unlink a conversation and workspace inquiry; human action is required |
| GET | `/api/channels/status` | Clerk + active member | Channel state, last sync/webhook, stable error codes only |
| PUT | `/api/channels/:channelKey/meta-account` | Owner/admin | Configure a Meta account ID for inbound webhook mapping; does not store provider credentials or prove provider-side verification |
| POST | `/api/integrations/sync` | Owner/admin/sales | Intentionally returns `501` until actual mailbox connectors exist |

## Integrations / public intake

| Method | Route | Access | Purpose |
|---|---|---|---|
| GET | `/api/integrations/keys` | Owner/admin | List partner key metadata; raw secrets never returned |
| POST | `/api/integrations/keys` | Owner/admin | Mint one-time partner key |
| DELETE | `/api/integrations/keys/:id` | Owner/admin | Revoke a key |
| GET | `/api/integrations/api-keys` | Owner/admin | Compatibility alias for existing UI |
| POST | `/api/integrations/api-keys` | Owner/admin | Compatibility alias for existing UI |
| DELETE | `/api/integrations/api-keys` | Owner/admin | Compatibility delete path; JSON `{ "id": "<uuid>" }` |
| POST | `/api/partner/inquiries` | Partner key | Server-to-server inquiry intake; `Authorization: Bearer sp_live_…` and `Idempotency-Key` are required |
| GET | `/api/public/form-config` | Public | Public Turnstile site key or setup error |
| POST | `/api/public/inquiry` | Public + Turnstile + consent | Direct website inquiry intake; does not confirm a reservation |
| GET | `/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` | Public with secret-token challenge | Meta subscription handshake |
| POST | `/api/webhooks/meta` | Public with HMAC-SHA256 verification | Ingest supported inbound WhatsApp/Instagram/Facebook message events |

## Important response conventions

Errors have `{ "error": "human-readable message", "code": "stable_machine_code" }`. The API does not include SQL errors, stack traces, tokens or provider secrets. `X-Request-Id` is returned for troubleshooting. For a `401`, re-authenticate; for a `403`, ask the workspace owner to grant access; for `429`, honor `Retry-After`; for `501`, the workflow is intentionally not implemented yet.
