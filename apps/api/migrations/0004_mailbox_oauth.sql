-- OAuth grant state is short-lived and one-use; provider tokens are encrypted by the application.
CREATE TABLE IF NOT EXISTS sp_channel_oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_key TEXT NOT NULL CHECK (channel_key IN ('email_gmail','email_outlook')),
  state_hash TEXT NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sp_channel_oauth_states_expiry_idx
  ON sp_channel_oauth_states(expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS sp_channel_oauth_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_key TEXT NOT NULL CHECK (channel_key IN ('email_gmail','email_outlook')),
  account_label TEXT NOT NULL DEFAULT '',
  external_account_id TEXT NOT NULL DEFAULT '',
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  sync_cursor TEXT,
  sync_started_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  connected_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, channel_key)
);
CREATE INDEX IF NOT EXISTS sp_channel_oauth_credentials_sync_idx
  ON sp_channel_oauth_credentials(channel_key, last_synced_at);
