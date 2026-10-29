-- Bounded keyset pagination and indexes matching inbox sort/search predicates.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS sp_conversations_workspace_activity_idx
  ON sp_conversations (workspace_id, (COALESCE(last_message_at, updated_at)) DESC, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS sp_conversations_workspace_channel_activity_idx
  ON sp_conversations (workspace_id, channel_key, status, (COALESCE(last_message_at, updated_at)) DESC, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS sp_channel_messages_workspace_conversation_activity_idx
  ON sp_channel_messages (workspace_id, conversation_id, (COALESCE(provider_created_at, created_at)) DESC, id DESC);
CREATE INDEX IF NOT EXISTS sp_conversations_participant_display_trgm_idx
  ON sp_conversations USING GIN (participant_display gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sp_conversations_participant_address_trgm_idx
  ON sp_conversations USING GIN (participant_address gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sp_conversations_title_trgm_idx
  ON sp_conversations USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sp_channel_messages_body_trgm_idx
  ON sp_channel_messages USING GIN (body_text gin_trgm_ops) WHERE body_text <> '';
