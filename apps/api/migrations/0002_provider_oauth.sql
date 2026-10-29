-- Provider OAuth state and encrypted credentials. Tokens are encrypted at rest with a dedicated 32-byte key.
CREATE TABLE IF NOT EXISTS sp_oauth_states (
  state_hash TEXT PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  channel_key TEXT NOT NULL CHECK (channel_key IN ('email_gmail','email_outlook')),
  initiated_by_user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sp_oauth_states_expiry_idx ON sp_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS sp_provider_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  channel_key TEXT NOT NULL CHECK (channel_key IN ('email_gmail','email_outlook')),
  account_email TEXT NOT NULL,
  external_account_id TEXT NOT NULL DEFAULT '',
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  sync_cursor TEXT,
  last_synced_at TIMESTAMPTZ,
  last_error_code TEXT,
  connected_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, channel_key)
);
CREATE INDEX IF NOT EXISTS sp_provider_credentials_expiry_idx ON sp_provider_credentials(token_expires_at);
