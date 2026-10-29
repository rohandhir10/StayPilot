import type { FastifyInstance } from 'fastify';
import { pool, inTransaction } from '../db.js';
import { randomUUID } from 'node:crypto';
import { requireWorkspaceMember, type MemberRole } from '../auth.js';
import { fail, noStore, isUuid } from '../http.js';
import { auditEvent } from '../domain.js';
import { conversationQuerySchema, conversationStatusUpdateSchema, linkSchema, messageQuerySchema, noteSchema } from '../validation.js';
import { decodePageCursor, encodePageCursor } from '../pagination.js';

const channelKeys = new Set(['whatsapp','email_gmail','email_outlook','phone','partner','website','instagram','facebook','booking_com','expedia','other_otas','spreadsheet','other']);
const writers: MemberRole[] = ['owner','admin','sales'];

export async function registerInboxRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/inbox/conversations', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply);
    if (!member) return;
    const query = conversationQuerySchema.safeParse(request.query);
    if (!query.success) return fail(reply, 400, query.error.issues[0]?.message || 'Inbox filters are invalid.', 'invalid_inbox_query');
    if (query.data.channel && !channelKeys.has(query.data.channel)) return fail(reply, 400, 'Unsupported channel filter.', 'invalid_channel');
    const cursor = query.data.cursor ? decodePageCursor(query.data.cursor) : null;
    if (query.data.cursor && (!cursor || !cursor.secondaryAt)) return fail(reply, 400, 'Inbox cursor is invalid or expired.', 'invalid_page_cursor');
    try {
      const result = await pool.query(
        `SELECT c.id, c.channel_key, c.external_account_id, c.title, c.participant_display, c.participant_address,
                c.linked_lead_id, c.status, c.unread_count, c.last_message_at, c.created_at, c.updated_at,
                m.body_text AS last_message_preview, m.direction AS last_message_direction,
                COALESCE(c.last_message_at, c.updated_at)::text AS cursor_sort_at,
                c.updated_at::text AS cursor_secondary_at
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
             OR c.title ILIKE '%' || $4 || '%'
             OR EXISTS (SELECT 1 FROM sp_channel_messages sm
                        WHERE sm.workspace_id=c.workspace_id AND sm.conversation_id=c.id
                          AND sm.body_text ILIKE '%' || $4 || '%')
           ))
           AND ($5::timestamptz IS NULL OR
                (COALESCE(c.last_message_at, c.updated_at), c.updated_at, c.id)
                  < ($5::timestamptz, $6::timestamptz, $7::uuid))
         ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC, c.updated_at DESC, c.id DESC
         LIMIT $8`,
        [member.workspace_id, query.data.channel || null, query.data.status || null, query.data.q || null,
         cursor?.sortAt ?? null, cursor?.secondaryAt ?? null, cursor?.id ?? null, query.data.limit + 1]
      );
      const hasMore = result.rows.length > query.data.limit;
      const rows = result.rows.slice(0, query.data.limit);
      const lastRow = rows[rows.length - 1];
      const nextCursor = hasMore && lastRow
        ? encodePageCursor({ sortAt: lastRow.cursor_sort_at, secondaryAt: lastRow.cursor_secondary_at, id: lastRow.id })
        : null;
      const conversations = rows.map(row => {
        const { cursor_sort_at: _cursorSortAt, cursor_secondary_at: _cursorSecondaryAt, ...visible } = row;
        return visible;
      });
      noStore(reply);
      return reply.send({ conversations, count: conversations.length, limit: query.data.limit, has_more: hasMore, next_cursor: nextCursor });
    } catch {
      return fail(reply, 500, 'Could not load the unified inbox.', 'inbox_list_failed');
    }
  });

  app.patch('/api/inbox/conversations/:id/status', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, writers);
    if (!member) return;
    const id = (request.params as { id?: string }).id || '';
    if (!isUuid(id)) return fail(reply, 400, 'A valid conversation ID is required.', 'invalid_conversation_id');
    const parsed = conversationStatusUpdateSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message || 'Conversation status is invalid.', 'invalid_conversation_status');
    try {
      const result = await inTransaction(async client => {
        const current = await client.query<{ id: string; status: string }>(
          'SELECT id,status FROM sp_conversations WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
          [id, member.workspace_id]
        );
        if (!current.rows[0]) return { kind: 'missing' as const };
        const previousStatus = current.rows[0].status;
        if (previousStatus === parsed.data.status) return { kind: 'unchanged' as const, status: previousStatus };
        const updated = await client.query<{ status: string }>(
          'UPDATE sp_conversations SET status=$1,updated_at=now() WHERE id=$2 AND workspace_id=$3 RETURNING status',
          [parsed.data.status, id, member.workspace_id]
        );
        await auditEvent(client, {
          workspaceId: member.workspace_id, actor: member, action: 'inbox.conversation_status_changed',
          entityType: 'conversation', entityId: id, metadata: { from: previousStatus, to: parsed.data.status }
        });
        return { kind: 'updated' as const, status: updated.rows[0]!.status };
      });
      if (result.kind === 'missing') return fail(reply, 404, 'Conversation not found.', 'conversation_not_found');
      noStore(reply);
      return reply.send({ ok: true, conversation_id: id, status: result.status, changed: result.kind === 'updated' });
    } catch {
      return fail(reply, 500, 'Could not update conversation status.', 'conversation_status_update_failed');
    }
  });
  app.get('/api/inbox/messages', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply);
    if (!member) return;
    const query = messageQuerySchema.safeParse(request.query);
    if (!query.success) return fail(reply, 400, 'Message history filters are invalid.', 'invalid_message_query');
    const cursor = query.data.cursor ? decodePageCursor(query.data.cursor) : null;
    if (query.data.cursor && !cursor) return fail(reply, 400, 'Message history cursor is invalid or expired.', 'invalid_page_cursor');
    try {
      const result = await inTransaction(async client => {
        // Lock the conversation so reads cannot race a webhook unread-count increment.
        const exists = await client.query(
          'SELECT id FROM sp_conversations WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
          [query.data.conversation_id, member.workspace_id]
        );
        if (!exists.rows.length) return null;
        const messagesResult = await client.query(
          `SELECT id, channel_key, provider_message_id, direction, sender_name, sender_address, recipient_address,
                  subject, body_text, provider_created_at, delivery_status, created_by_user_id, created_at,
                  COALESCE(provider_created_at, created_at)::text AS cursor_sort_at
           FROM sp_channel_messages
           WHERE workspace_id=$1 AND conversation_id=$2
             AND ($3::timestamptz IS NULL OR (COALESCE(provider_created_at, created_at), id) < ($3::timestamptz, $4::uuid))
           ORDER BY COALESCE(provider_created_at, created_at) DESC, id DESC LIMIT $5`,
          [member.workspace_id, query.data.conversation_id, cursor?.sortAt ?? null, cursor?.id ?? null, query.data.limit + 1]
        );
        if (!cursor) await client.query('UPDATE sp_conversations SET unread_count=0 WHERE id=$1 AND workspace_id=$2', [query.data.conversation_id, member.workspace_id]);
        return messagesResult.rows;
      });
      if (!result) return fail(reply, 404, 'Conversation not found.', 'conversation_not_found');
      const hasMore = result.length > query.data.limit;
      const pageRows = result.slice(0, query.data.limit);
      const oldest = pageRows[pageRows.length - 1];
      const nextCursor = hasMore && oldest ? encodePageCursor({ sortAt: oldest.cursor_sort_at, id: oldest.id }) : null;
      const messages = pageRows.reverse().map(row => {
        const { cursor_sort_at: _cursorSortAt, ...visible } = row;
        return visible;
      });
      noStore(reply);
      return reply.send({ messages, count: messages.length, limit: query.data.limit, has_more: hasMore, next_cursor: nextCursor });
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
        if (parsed.data.lead_id) {
          const paused = await client.query(
            `UPDATE sp_sales_workflow_enrollments e
             SET status='paused', pause_reason='customer_reply', next_action_at=NULL, updated_at=now()
             WHERE e.workspace_id=$1 AND e.lead_id=$2 AND e.status='active'
               AND EXISTS (
                 SELECT 1 FROM sp_channel_messages m
                 WHERE m.workspace_id=e.workspace_id AND m.conversation_id=$3 AND m.direction='inbound'
                   AND m.created_at > e.started_at
               )
             RETURNING e.id`,
            [member.workspace_id, parsed.data.lead_id, parsed.data.conversation_id]
          );
          if (paused.rows.length) {
            await client.query(
              'UPDATE leads SET next_follow_up=NULL, updated_at=now() WHERE workspace_id=$1 AND id=$2',
              [member.workspace_id, parsed.data.lead_id]
            );
            await client.query(
              `INSERT INTO lead_activities (workspace_id, lead_id, activity_type, description, actor)
               VALUES ($1,$2,'workflow_paused_on_reply','Sales workflow paused because the linked conversation already contains a newer inbound customer message.','StayPilot')`,
              [member.workspace_id, parsed.data.lead_id]
            );
            for (const enrollment of paused.rows) {
              await auditEvent(client, {
                workspaceId: member.workspace_id,
                actor: member,
                action: 'workflow.paused_on_reply',
                entityType: 'workflow_enrollment',
                entityId: enrollment.id,
                metadata: { lead_id: parsed.data.lead_id, conversation_id: parsed.data.conversation_id }
              });
            }
          }
        }
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
