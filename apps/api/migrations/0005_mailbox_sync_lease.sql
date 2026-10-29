-- Lease one mailbox sync at a time per workspace/channel.
ALTER TABLE sp_channel_oauth_credentials
  ADD COLUMN IF NOT EXISTS sync_lock_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS sp_channel_oauth_credentials_lock_idx
  ON sp_channel_oauth_credentials(sync_lock_until)
  WHERE sync_lock_until IS NOT NULL;
