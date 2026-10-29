-- Completion evidence is separated from the task definition so deployed installations can upgrade safely.
ALTER TABLE sp_action_tasks ADD COLUMN IF NOT EXISTS completion_note TEXT NOT NULL DEFAULT '';
