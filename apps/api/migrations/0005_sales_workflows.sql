-- Persisted hotel-sales workflow enrolments and internal next-action tasks.
-- This migration never sends messages or makes commercial commitments.
CREATE TABLE IF NOT EXISTS sp_sales_workflow_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL,
  sequence_key TEXT NOT NULL CHECK (sequence_key IN ('corporate', 'wedding', 'mice', 'general')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed', 'cancelled', 'stopped')),
  current_step INTEGER NOT NULL DEFAULT 1 CHECK (current_step >= 1),
  next_action_at TIMESTAMPTZ,
  pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN ('manual', 'customer_reply')),
  stop_reason TEXT CHECK (stop_reason IS NULL OR stop_reason IN ('manual_cancel', 'lead_confirmed', 'lead_lost')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  created_by_user_id TEXT,
  created_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sp_sales_workflow_enrollments_workspace_id_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT sp_sales_workflow_enrollments_workspace_lead_fk
    FOREIGN KEY (workspace_id, lead_id) REFERENCES leads (workspace_id, id) ON DELETE CASCADE
);

-- A lead can have at most one active or paused sales sequence at a time.
CREATE UNIQUE INDEX IF NOT EXISTS sp_sales_workflow_one_open_per_lead_idx
  ON sp_sales_workflow_enrollments (workspace_id, lead_id)
  WHERE status IN ('active', 'paused');
CREATE INDEX IF NOT EXISTS sp_sales_workflow_queue_idx
  ON sp_sales_workflow_enrollments (workspace_id, status, next_action_at);

CREATE TABLE IF NOT EXISTS sp_sales_workflow_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enrollment_id UUID NOT NULL,
  lead_id UUID NOT NULL,
  step_number INTEGER NOT NULL CHECK (step_number >= 1),
  step_key TEXT NOT NULL CHECK (char_length(step_key) BETWEEN 1 AND 80),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  instructions TEXT NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 3000),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'skipped', 'cancelled')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  completed_by_user_id TEXT,
  completion_note TEXT NOT NULL DEFAULT '' CHECK (char_length(completion_note) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sp_sales_workflow_tasks_workspace_id_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT sp_sales_workflow_tasks_workspace_enrollment_fk
    FOREIGN KEY (workspace_id, enrollment_id)
    REFERENCES sp_sales_workflow_enrollments (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT sp_sales_workflow_tasks_workspace_lead_fk
    FOREIGN KEY (workspace_id, lead_id) REFERENCES leads (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT sp_sales_workflow_task_step_unique UNIQUE (workspace_id, enrollment_id, step_number)
);
CREATE INDEX IF NOT EXISTS sp_sales_workflow_tasks_due_idx
  ON sp_sales_workflow_tasks (workspace_id, status, scheduled_at)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS sp_sales_workflow_tasks_enrollment_idx
  ON sp_sales_workflow_tasks (workspace_id, enrollment_id, step_number);
