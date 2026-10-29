-- Persisted Action Centre tasks and idempotent generated suggestions.
CREATE TABLE IF NOT EXISTS sp_action_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('crm_rule','conversation_rule','manual')),
  category TEXT NOT NULL CHECK (category IN ('follow_up','ownership','missing_information','quotation','availability','callback','client_request','other')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 180),
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','dismissed')),
  assigned_to TEXT NOT NULL DEFAULT 'Unassigned',
  due_at TIMESTAMPTZ,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES sp_conversations(id) ON DELETE SET NULL,
  source_message_id UUID REFERENCES sp_channel_messages(id) ON DELETE SET NULL,
  evidence_text TEXT NOT NULL DEFAULT '',
  evidence_channel TEXT,
  confidence TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  created_by_user_id TEXT,
  completed_by_user_id TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, task_key)
);
ALTER TABLE sp_action_tasks ADD COLUMN IF NOT EXISTS completion_note TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS sp_action_tasks_queue_idx
  ON sp_action_tasks(workspace_id, status, due_at ASC NULLS LAST, created_at DESC);
CREATE INDEX IF NOT EXISTS sp_action_tasks_lead_idx
  ON sp_action_tasks(workspace_id, lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sp_action_tasks_conversation_idx
  ON sp_action_tasks(workspace_id, conversation_id) WHERE conversation_id IS NOT NULL;
