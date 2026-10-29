-- Enforce same-workspace relationships in PostgreSQL itself.
-- Application checks remain useful, but they are not the sole tenant boundary.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM lead_activities a
    JOIN leads l ON l.id = a.lead_id
    WHERE a.workspace_id <> l.workspace_id
  ) THEN
    RAISE EXCEPTION 'Cannot apply 0002: lead_activities contains cross-workspace lead references; reconcile them first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM sp_conversations c
    JOIN leads l ON l.id = c.linked_lead_id
    WHERE c.linked_lead_id IS NOT NULL AND c.workspace_id <> l.workspace_id
  ) THEN
    RAISE EXCEPTION 'Cannot apply 0002: conversations contain cross-workspace linked leads; reconcile them first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM sp_channel_messages m
    JOIN sp_conversations c ON c.id = m.conversation_id
    WHERE m.workspace_id <> c.workspace_id
  ) THEN
    RAISE EXCEPTION 'Cannot apply 0002: messages contain cross-workspace conversation references; reconcile them first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM sp_partner_requests r
    JOIN sp_partner_api_keys k ON k.id = r.api_key_id
    JOIN leads l ON l.id = r.lead_id
    WHERE r.workspace_id <> k.workspace_id OR r.workspace_id <> l.workspace_id
  ) THEN
    RAISE EXCEPTION 'Cannot apply 0002: partner idempotency records contain cross-workspace references; reconcile them first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM sp_outbound_requests r
    JOIN sp_conversations c ON c.id = r.conversation_id
    WHERE r.workspace_id <> c.workspace_id
  ) THEN
    RAISE EXCEPTION 'Cannot apply 0002: outbound request records contain cross-workspace conversation references; reconcile them first.';
  END IF;
END $$;

ALTER TABLE leads
  ADD CONSTRAINT leads_workspace_id_id_unique UNIQUE (workspace_id, id);

ALTER TABLE sp_conversations
  ADD CONSTRAINT sp_conversations_workspace_id_id_unique UNIQUE (workspace_id, id);

ALTER TABLE sp_partner_api_keys
  ADD CONSTRAINT sp_partner_api_keys_workspace_id_id_unique UNIQUE (workspace_id, id);

ALTER TABLE lead_activities
  ADD CONSTRAINT lead_activities_workspace_lead_fk
  FOREIGN KEY (workspace_id, lead_id)
  REFERENCES leads (workspace_id, id)
  ON DELETE CASCADE;

ALTER TABLE sp_conversations
  ADD CONSTRAINT sp_conversations_workspace_linked_lead_fk
  FOREIGN KEY (workspace_id, linked_lead_id)
  REFERENCES leads (workspace_id, id);

ALTER TABLE sp_channel_messages
  ADD CONSTRAINT sp_channel_messages_workspace_conversation_fk
  FOREIGN KEY (workspace_id, conversation_id)
  REFERENCES sp_conversations (workspace_id, id)
  ON DELETE CASCADE;

ALTER TABLE sp_partner_requests
  ADD CONSTRAINT sp_partner_requests_workspace_key_fk
  FOREIGN KEY (workspace_id, api_key_id)
  REFERENCES sp_partner_api_keys (workspace_id, id)
  ON DELETE RESTRICT;

ALTER TABLE sp_partner_requests
  ADD CONSTRAINT sp_partner_requests_workspace_lead_fk
  FOREIGN KEY (workspace_id, lead_id)
  REFERENCES leads (workspace_id, id)
  ON DELETE RESTRICT;

ALTER TABLE sp_outbound_requests
  ADD CONSTRAINT sp_outbound_requests_workspace_conversation_fk
  FOREIGN KEY (workspace_id, conversation_id)
  REFERENCES sp_conversations (workspace_id, id)
  ON DELETE CASCADE;
