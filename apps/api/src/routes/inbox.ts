import type { FastifyInstance } from 'fastify';
import { pool, inTransaction } from '../db.js';
import { randomUUID } from 'node:crypto';
import { requireWorkspaceMember, type MemberRole } from '../auth.js';
import { fail, noStore } from '../http.js';
import { auditEvent } from '../domain.js';
import { conversationQuerySchema, linkSchema, noteSchema } from '../validation.js';

const channelKeys = new Set(['whatsapp','email_gmail','email_outlook','phone','partner','website','instagram','facebook','booking_com','expedia','other_otas','spreadsheet','other']);
const writers: MemberRole[] = ['owner','admin','sales'];

export async function registerInboxRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/inbox/conversations', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply);
    if (!member) return;
    const query = conversationQuerySchema.safeParse(request.query);
    if (!query.success) return fail(reply, 400, query.error.issues[0]?.message || 'Inbox filters are invalid.', 'invalid_inbox_query');
    if (query.data.channel && !channelKeys.has(query.data.channel)) return fail(reply, 400, 'Unsupported channel filter.', 'invalid_channel');
    try {
      const { rows } = await pool.query(
        `SELECT c.id, c.channel_key, c.external_account_id, c.title, c.participant_display, c.participant_address,
                c.linked_lead_id, c.status, c.unread_count, c.last_message_at, c.created_at, c.updated_at,
                m.body_text AS last_message_preview, m.direction AS last_message_direction
         FROM sp_conversations c
         LEFT JOIN LATERAL (
           SELECT body_text, direction FROM sp_channel_messages
           WHERE conversation_id=c.id AND workspace_id=c.workspace_id
           ORDER BY COALESCE(provider_created_at, created_at) DESC, id DESC LIMIT 1
         ) m ON true
         WHERE c.workspace_id=$1
           AND ($2::text IS NULL OR c.channel_key=$2)
           AND ($3::text IS NULL OR c.status=$3)
           AND ($4::text IS NULL OR (
             c.participant_display ILIKE '%' || $4 || '%' OR c.participant_address ILIKE '%' || $4 || '%'
             OR c.title ILIKE '%' || $4 || '%' OR COALESCE(m.body_text,'') ILIKE '%' || $4 || '%'
           ))
         ORDER BY c.last_message_at DESC NULLS LAST, c.updated_at DESC LIMIT $5`,
        [member.workspace_id, query.data.channel || null, query.data.status || null, query.data.q || null, query.data.limit]
      );
      noStore(reply);
      return reply.send({ conversations: rows, count: rows.length, limit: query.data.limit });
    } catch {
      return fail(reply, 500, 'Could not load the unified inbox.', 'inbox_list_failed');
    }
  });

  app.get('/api/inbox/messages', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply);
    if (!member) return;
    const conversationId = (request.query as Record<string, unknown>)?.conversation_id;
    if (typeof conversationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(conversationId)) return fail(reply, 400, 'A valid conversation ID is required.', 'invalid_conversation_id');
    try {
      const exists = await pool.query('SELECT id FROM sp_conversations WHERE id=$1 AND workspace_id=$2 LIMIT 1', [conversationId, member.workspace_id]);
      if (!exists.rows.length) return fail(reply, 404, 'Conversation not found.', 'conversation_not_found');
      const { rows } = await pool.query(
        `SELECT id, channel_key, provider_message_id, direction, sender_name, sender_address, recipient_address,
                subject, body_text, provider_created_at, delivery_status, created_by_user_id, created_at
         FROM sp_channel_messages WHERE workspace_id=$1 AND conversation_id=$2
         ORDER BY COALESCE(provider_created_at, created_at) DESC, id DESC LIMIT 200`, [member.workspace_id, conversationId]
      );
      await pool.query('UPDATE sp_conversations SET unread_count=0 WHERE id=$1 AND workspace_id=$2', [conversationId, member.workspace_id]);
      noStore(reply);
      return reply.send({ messages: rows.reverse() });
    } catch {
      return fail(reply, 500, 'Could not load conversation history.', 'inbox_messages_failed');
    }
  });

  app.post('/api/inbox/messages', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, writers);
    if (!member) return;
    const parsed = noteSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message || 'Internal note is invalid.', 'invalid_note');
    try {
      const created = await inTransaction(async client => {
        const conversation = await client.query<{ id: string; channel_key: string }>(
          'SELECT id, channel_key FROM sp_conversations WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
          [parsed.data.conversation_id, member.workspace_id]
        );
        if (!conversation.rows[0]) return null;
        const id = randomUUID();
        const message = await client.query(
          `INSERT INTO sp_channel_messages (id, workspace_id, conversation_id, channel_key, direction, sender_name, sender_address, body_text, delivery_status, metadata, created_by_user_id)
           VALUES ($1,$2,$3,$4,'note',$5,$6,$7,'received','{}'::jsonb,$8)
           RETURNING id, channel_key, direction, sender_name, body_text, created_at, delivery_status`,
          [id, member.workspace_id, parsed.data.conversation_id, conversation.rows[0].channel_key, member.display_name, member.email, parsed.data.body_text, member.user_id]
        );
        await client.query('UPDATE sp_conversations SET last_message_at=now(), updated_at=now() WHERE id=$1 AND workspace_id=$2', [parsed.data.conversation_id, member.workspace_id]);
        await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'inbox.note_added', entityType: 'conversation', entityId: parsed.data.conversation_id, metadata: { message_id: id } });
        return message.rows[0];
      });
      if (!created) return fail(reply, 404, 'Conversation not found.', 'conversation_not_found');
      noStore(reply);
      return reply.code(201).send({ message: created });
    } catch {
      return fail(reply, 500, 'Could not save the internal note.', 'note_create_failed');
    }
  });

  app.post('/api/inbox/link', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, writers);
    if (!member) return;
    const parsed = linkSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message || 'Link details are invalid.', 'invalid_conversation_link');
    try {
      const outcome = await inTransaction(async client => {
        const conversation = await client.query('SELECT id FROM sp_conversations WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [parsed.data.conversation_id, member.workspace_id]);
        if (!conversation.rows.length) return 'conversation_missing' as const;
        if (parsed.data.lead_id) {
          const lead = await client.query('SELECT id FROM leads WHERE id=$1 AND workspace_id=$2 LIMIT 1', [parsed.data.lead_id, member.workspace_id]);
          if (!lead.rows.length) return 'lead_missing' as const;
        }
        await client.query('UPDATE sp_conversations SET linked_lead_id=$1, updated_at=now() WHERE id=$2 AND workspace_id=$3', [parsed.data.lead_id, parsed.data.conversation_id, member.workspace_id]);
        await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'inbox.conversation_linked', entityType: 'conversation', entityId: parsed.data.conversation_id, metadata: { linked_lead_id: parsed.data.lead_id } });
        return 'ok' as const;
      });
      if (outcome === 'conversation_missing') return fail(reply, 404, 'Conversation not found.', 'conversation_not_found');
      if (outcome === 'lead_missing') return fail(reply, 404, 'Inquiry not found in this workspace.', 'lead_not_found');
      return reply.send({ ok: true, conversation_id: parsed.data.conversation_id, linked_lead_id: parsed.data.lead_id });
    } catch {
      return fail(reply, 500, 'Could not link the conversation.', 'conversation_link_failed');
    }
  });
}
