-- Persist import idempotency decisions and resulting lead IDs in the same transaction as imports.
CREATE TABLE IF NOT EXISTS sp_import_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  lead_ids UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sp_import_requests_workspace_key_unique UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT sp_import_requests_key_safe CHECK (idempotency_key !~ E'[\\r\\n\\000]')
);
CREATE INDEX IF NOT EXISTS sp_import_requests_workspace_created_idx
  ON sp_import_requests (workspace_id, created_at DESC);
