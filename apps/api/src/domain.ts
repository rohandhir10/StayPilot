import type pg from 'pg';
import { inTransaction } from './db.js';
import type { WorkspaceMember } from './auth.js';
import { safeText } from './http.js';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { leadSchema } from './validation.js';

export type LeadInput = z.infer<typeof leadSchema>;
type Actor = Pick<WorkspaceMember, 'user_id' | 'email' | 'display_name'>;

type LeadInsertInput = {
  workspaceId: string;
  actor: Actor | null;
  lead: LeadInput;
  activityDescription: string;
  auditMetadata?: Record<string, unknown>;
};

type ExternalMessageInput = {
  workspaceId: string; channelKey: string; externalAccountId?: string; externalThreadId: string;
  title?: string; participantDisplay?: string; participantAddress?: string; providerMessageId?: string | null;
  senderName?: string; senderAddress?: string; recipientAddress?: string; subject?: string; bodyText: string;
  providerCreatedAt?: string | null; metadata?: Record<string, unknown>;
};

export async function auditEvent(
  client: pg.PoolClient,
  input: { workspaceId: string; actor?: Pick<WorkspaceMember, 'user_id' | 'email'> | null; action: string; entityType: string; entityId?: string | null; metadata?: Record<string, unknown> }
): Promise<void> {
  await client.query(
    `INSERT INTO sp_audit_events (workspace_id, actor_user_id, actor_email, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [input.workspaceId, input.actor?.user_id ?? null, input.actor?.email ?? null,
      input.action, input.entityType, input.entityId ?? null,
      JSON.stringify(input.metadata && typeof input.metadata === 'object' ? input.metadata : {})]
  );
}

async function insertLeadAndActivity(client: pg.PoolClient, input: LeadInsertInput, leadId = randomUUID()) {
  const leadResult = await client.query(
    `INSERT INTO leads (
      id, workspace_id, client_name, company_name, client_email, client_phone,
      agent_name, agent_email, property_name, inquiry_type, check_in, check_out,
      guests, estimated_value, source, status, assigned_to, next_follow_up, notes
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING id, workspace_id, client_name, company_name, client_email, client_phone,
      agent_name, agent_email, property_name, inquiry_type, check_in, check_out, guests,
      estimated_value, source, status, assigned_to, last_contact_at, next_follow_up, notes,
      created_at, updated_at`,
    [leadId, input.workspaceId, input.lead.client_name, input.lead.company_name || '', input.lead.client_email || '', input.lead.client_phone || '',
      input.lead.agent_name || '', input.lead.agent_email || '', input.lead.property_name, input.lead.inquiry_type,
      input.lead.check_in, input.lead.check_out, input.lead.guests, input.lead.estimated_value,
      input.lead.source, input.lead.status, input.lead.assigned_to || 'Unassigned', input.lead.next_follow_up, input.lead.notes]
  );
  await client.query(
    `INSERT INTO lead_activities (workspace_id, lead_id, activity_type, description, actor_user_id, actor_email, actor)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [input.workspaceId, leadId, input.actor ? 'created' : 'received', safeText(input.activityDescription, 500) || 'Inquiry added', input.actor?.user_id ?? null, input.actor?.email ?? null, input.actor?.display_name ?? 'System']
  );
  await auditEvent(client, {
    workspaceId: input.workspaceId, actor: input.actor,
    action: 'lead.created', entityType: 'lead', entityId: leadId,
    metadata: { source: input.lead.source, inquiry_type: input.lead.inquiry_type, ...(input.auditMetadata || {}) }
  });
  return leadResult.rows[0];
}

export async function createLeadRecord(input: LeadInsertInput & {
  idempotency?: { apiKeyId: string; key: string; requestHash: string };
}) {
  return await inTransaction(async client => {
    const lead = await insertLeadAndActivity(client, input);
    if (input.idempotency) {
      await client.query(
        `INSERT INTO sp_partner_requests (workspace_id, api_key_id, idempotency_key, request_hash, lead_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.workspaceId, input.idempotency.apiKeyId, input.idempotency.key, input.idempotency.requestHash, lead.id]
      );
    }
    return lead;
  });
}

export type LeadBatchInput = {
  workspaceId: string; actor: WorkspaceMember;
  entries: Array<{ lead: LeadInput; rowNumber: number }>;
};

export async function createLeadsBatchWithClient(client: pg.PoolClient, input: LeadBatchInput) {
  if (!input.entries.length || input.entries.length > 25) throw new Error('batch_size_invalid');
  const result = [];
  for (const entry of input.entries) {
    result.push(await insertLeadAndActivity(client, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      lead: entry.lead,
      activityDescription: `Spreadsheet import · row ${entry.rowNumber}`
    }));
  }
  return result;
}

export async function createLeadsBatch(input: LeadBatchInput) {
  return await inTransaction(client => createLeadsBatchWithClient(client, input));
}

export async function appendActivity(input: {
  workspaceId: string; leadId: string; actor: WorkspaceMember; type: string; description: string;
}): Promise<void> {
  await inTransaction(async client => {
    await client.query(
      `INSERT INTO lead_activities (workspace_id, lead_id, activity_type, description, actor_user_id, actor_email, actor)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.workspaceId, input.leadId, input.type, safeText(input.description, 500) || input.type, input.actor.user_id, input.actor.email, input.actor.display_name]
    );
    await auditEvent(client, { workspaceId: input.workspaceId, actor: input.actor, action: 'lead.activity_added', entityType: 'lead', entityId: input.leadId, metadata: { activity_type: input.type } });
  });
}

export async function upsertExternalMessageWithClient(client: pg.PoolClient, input: ExternalMessageInput) {
  const body = safeText(input.bodyText, 20000);
  if (body === null) throw new Error('message_too_large');
  const externalAccountId = (input.externalAccountId || '').slice(0, 255);
  const externalThreadId = input.externalThreadId.slice(0, 500);
  const timestamp = input.providerCreatedAt && !Number.isNaN(Date.parse(input.providerCreatedAt))
    ? new Date(input.providerCreatedAt) : new Date();
  const conversation = await client.query<{ id: string; linked_lead_id: string | null }>(
    `INSERT INTO sp_conversations (workspace_id, channel_key, external_account_id, external_thread_id, title, participant_display, participant_address, last_message_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT (workspace_id, channel_key, external_account_id, external_thread_id) DO UPDATE SET
       title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE sp_conversations.title END,
       participant_display = CASE WHEN EXCLUDED.participant_display <> '' THEN EXCLUDED.participant_display ELSE sp_conversations.participant_display END,
       participant_address = CASE WHEN EXCLUDED.participant_address <> '' THEN EXCLUDED.participant_address ELSE sp_conversations.participant_address END,
       last_message_at = GREATEST(COALESCE(sp_conversations.last_message_at, 'epoch'::timestamptz), EXCLUDED.last_message_at), updated_at = now()
     RETURNING id, linked_lead_id`,
    [input.workspaceId, input.channelKey, externalAccountId, externalThreadId, safeText(input.title || '', 300) || '', safeText(input.participantDisplay || '', 160) || '', safeText(input.participantAddress || '', 320) || '', timestamp]
  );
  const conversationId = conversation.rows[0]!.id;
  const msg = await client.query<{ id: string }>(
    `INSERT INTO sp_channel_messages (workspace_id, conversation_id, channel_key, provider_message_id, direction, sender_name, sender_address, recipient_address, subject, body_text, provider_created_at, delivery_status, metadata)
     VALUES ($1,$2,$3,$4,'inbound',$5,$6,$7,$8,$9,$10,'received',$11::jsonb)
     ON CONFLICT (workspace_id, channel_key, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [input.workspaceId, conversationId, input.channelKey, input.providerMessageId ? input.providerMessageId.slice(0, 500) : null,
      safeText(input.senderName || '', 160) || '', safeText(input.senderAddress || '', 320) || '', safeText(input.recipientAddress || '', 320) || '',
      safeText(input.subject || '', 500) || '', body, timestamp, JSON.stringify(input.metadata && typeof input.metadata === 'object' ? input.metadata : {})]
  );
  if (msg.rows.length) {
    await client.query('UPDATE sp_conversations SET unread_count=unread_count+1, updated_at=now() WHERE id=$1 AND workspace_id=$2', [conversationId, input.workspaceId]);
    const linkedLeadId = conversation.rows[0]?.linked_lead_id;
    if (linkedLeadId) {
      // A newly ingested customer reply pauses internal follow-up tasks for that lead.
      // It never sends a message or changes the lead's commercial status.
      const paused = await client.query(
        `UPDATE sp_sales_workflow_enrollments
         SET status='paused', pause_reason='customer_reply', next_action_at=NULL, updated_at=now()
         WHERE workspace_id=$1 AND lead_id=$2 AND status='active' AND started_at < $3
         RETURNING id`,
        [input.workspaceId, linkedLeadId, timestamp]
      );
      if (paused.rows.length) {
        await client.query(
          'UPDATE leads SET next_follow_up=NULL, updated_at=now() WHERE workspace_id=$1 AND id=$2',
          [input.workspaceId, linkedLeadId]
        );
        await client.query(
          `INSERT INTO lead_activities (workspace_id, lead_id, activity_type, description, actor)
           VALUES ($1,$2,'workflow_paused_on_reply','Sales workflow paused because a new inbound customer message arrived.','StayPilot')`,
          [input.workspaceId, linkedLeadId]
        );
        for (const enrollment of paused.rows) {
          await auditEvent(client, {
            workspaceId: input.workspaceId,
            action: 'workflow.paused_on_reply',
            entityType: 'workflow_enrollment',
            entityId: enrollment.id,
            metadata: { lead_id: linkedLeadId, channel_key: input.channelKey }
          });
        }
      }
    }
  }
  return { conversationId, inserted: msg.rows.length > 0 };
}
