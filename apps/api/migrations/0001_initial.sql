-- StayPilot database baseline. All customer-owned records are workspace-scoped.
-- Apply through `npm run migrate`; migration files are immutable after deployment.

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO workspaces (slug, name) VALUES ('default', 'StayPilot workspace') ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('owner','admin','sales','viewer')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, user_id),
  UNIQUE (workspace_id, email),
  CONSTRAINT workspace_members_email_lower CHECK (email = lower(email))
);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id, is_active);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','sales','viewer')),
  invited_by_user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at TIMESTAMPTZ,
  accepted_user_id TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email),
  CONSTRAINT workspace_invites_email_lower CHECK (email = lower(email))
);
CREATE INDEX IF NOT EXISTS workspace_invites_active_idx ON workspace_invites(workspace_id, email, expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  client_name TEXT NOT NULL,
  company_name TEXT NOT NULL DEFAULT '',
  client_email TEXT NOT NULL DEFAULT '',
  client_phone TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '',
  agent_email TEXT NOT NULL DEFAULT '',
  property_name TEXT NOT NULL,
  inquiry_type TEXT NOT NULL,
  check_in DATE,
  check_out DATE,
  guests INTEGER NOT NULL DEFAULT 1 CHECK (guests BETWEEN 1 AND 10000),
  estimated_value NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (estimated_value >= 0),
  source TEXT NOT NULL DEFAULT 'Other',
  status TEXT NOT NULL DEFAULT 'New inquiry'
    CHECK (status IN ('New inquiry','Contacted','Proposal sent','Negotiation','Confirmed','Lost')),
  assigned_to TEXT NOT NULL DEFAULT 'Unassigned',
  last_contact_at TIMESTAMPTZ,
  next_follow_up TIMESTAMPTZ,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT leads_dates_order CHECK (check_in IS NULL OR check_out IS NULL OR check_out >= check_in)
);
CREATE INDEX IF NOT EXISTS leads_workspace_created_idx ON leads(workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS leads_workspace_status_idx ON leads(workspace_id, status);
CREATE INDEX IF NOT EXISTS leads_workspace_followup_idx ON leads(workspace_id, next_follow_up) WHERE next_follow_up IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_workspace_client_email_idx ON leads(workspace_id, lower(client_email)) WHERE client_email <> '';
CREATE INDEX IF NOT EXISTS leads_workspace_client_phone_idx ON leads(workspace_id, client_phone) WHERE client_phone <> '';
CREATE INDEX IF NOT EXISTS leads_workspace_company_date_idx ON leads(workspace_id, lower(company_name), check_in, check_out);

CREATE TABLE IF NOT EXISTS lead_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL,
  description TEXT NOT NULL,
  actor_user_id TEXT,
  actor_email TEXT,
  actor TEXT NOT NULL DEFAULT 'System',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_activities_workspace_lead_idx ON lead_activities(workspace_id, lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sp_channel_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_connected'
    CHECK (status IN ('not_connected','pending','inbound_active','connected','error','disabled')),
  connection_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK (connection_mode IN ('oauth','webhook','api_key','manual','import')),
  account_label TEXT,
  external_account_id TEXT,
  last_synced_at TIMESTAMPTZ,
  last_webhook_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, channel_key)
);
CREATE INDEX IF NOT EXISTS sp_channel_connections_status_idx ON sp_channel_connections(workspace_id, status);
INSERT INTO sp_channel_connections (workspace_id, channel_key, provider, display_name, connection_mode)
SELECT w.id, v.channel_key, v.provider, v.display_name, v.connection_mode
FROM workspaces w
CROSS JOIN (VALUES
  ('whatsapp','meta','WhatsApp Business','webhook'),
  ('email_gmail','google','Gmail','oauth'),
  ('email_outlook','microsoft','Outlook / Microsoft 365','oauth'),
  ('phone','manual','Phone calls','manual'),
  ('partner','staypilot','Travel agents / corporate partners','api_key'),
  ('website','staypilot','Hotel website form','manual'),
  ('instagram','meta','Instagram messages','webhook'),
  ('facebook','meta','Facebook Messenger','webhook'),
  ('booking_com','ota','Booking.com','manual'),
  ('expedia','ota','Expedia','manual'),
  ('other_otas','ota','Other OTAs / channel manager','manual'),
  ('spreadsheet','staypilot','Spreadsheet import','import'),
  ('other','manual','Other messages','manual')
) AS v(channel_key, provider, display_name, connection_mode)
WHERE w.slug = 'default'
ON CONFLICT (workspace_id, channel_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS sp_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_key TEXT NOT NULL,
  external_account_id TEXT NOT NULL DEFAULT '',
  external_thread_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  participant_display TEXT NOT NULL DEFAULT '',
  participant_address TEXT NOT NULL DEFAULT '',
  linked_lead_id UUID,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','closed')),
  unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, channel_key, external_account_id, external_thread_id),
  CONSTRAINT sp_conversations_linked_lead_fk FOREIGN KEY (linked_lead_id) REFERENCES leads(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS sp_conversations_workspace_recent_idx ON sp_conversations(workspace_id, last_message_at DESC NULLS LAST, updated_at DESC);
CREATE INDEX IF NOT EXISTS sp_conversations_workspace_channel_idx ON sp_conversations(workspace_id, channel_key, status);
CREATE INDEX IF NOT EXISTS sp_conversations_linked_lead_idx ON sp_conversations(workspace_id, linked_lead_id) WHERE linked_lead_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sp_channel_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES sp_conversations(id) ON DELETE CASCADE,
  channel_key TEXT NOT NULL,
  provider_message_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound','note','system')),
  sender_name TEXT NOT NULL DEFAULT '',
  sender_address TEXT NOT NULL DEFAULT '',
  recipient_address TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  provider_created_at TIMESTAMPTZ,
  delivery_status TEXT NOT NULL DEFAULT 'received'
    CHECK (delivery_status IN ('received','queued','sent','delivered','failed','unknown')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sp_channel_messages_body_length CHECK (length(body_text) <= 20000)
);
CREATE UNIQUE INDEX IF NOT EXISTS sp_channel_messages_external_unique
  ON sp_channel_messages(workspace_id, channel_key, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sp_channel_messages_conversation_recent_idx ON sp_channel_messages(workspace_id, conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sp_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'unknown',
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','processed','failed','ignored')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  error_code TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, event_key)
);
CREATE INDEX IF NOT EXISTS sp_webhook_events_received_idx ON sp_webhook_events(received_at DESC);
CREATE INDEX IF NOT EXISTS sp_webhook_events_failed_idx ON sp_webhook_events(provider, received_at) WHERE status = 'failed';

CREATE TABLE IF NOT EXISTS sp_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sp_audit_events_workspace_recent_idx ON sp_audit_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sp_audit_events_entity_idx ON sp_audit_events(workspace_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS sp_partner_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '["inquiries:create"]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sp_partner_api_keys_workspace_idx ON sp_partner_api_keys(workspace_id, is_active);

CREATE TABLE IF NOT EXISTS sp_partner_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  api_key_id UUID NOT NULL REFERENCES sp_partner_api_keys(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash TEXT NOT NULL,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (api_key_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS sp_partner_requests_workspace_created_idx ON sp_partner_requests(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sp_rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 1 CHECK (hits >= 1),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sp_rate_limit_buckets_expiry_idx ON sp_rate_limit_buckets(expires_at);

-- Reserved now for audited sending workflows later; no outbound channel sender is enabled in this release.
CREATE TABLE IF NOT EXISTS sp_outbound_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES sp_conversations(id) ON DELETE CASCADE,
  requested_by_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash TEXT NOT NULL,
  channel_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','failed','unknown')),
  provider_message_id TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, conversation_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS sp_outbound_requests_unresolved_idx ON sp_outbound_requests(workspace_id, status, created_at DESC) WHERE status IN ('sending','unknown');
