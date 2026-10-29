import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { pool, inTransaction } from '../db.js';
import { requireWorkspaceMember, type MemberRole, type WorkspaceMember } from '../auth.js';
import { auditEvent } from '../domain.js';
import { fail, noStore, safeText, isUuid } from '../http.js';

const writerRoles: MemberRole[] = ['owner', 'admin', 'sales'];
type Category = 'follow_up' | 'ownership' | 'missing_information' | 'quotation' | 'availability' | 'callback' | 'client_request' | 'other';
type Priority = 'low' | 'normal' | 'high' | 'urgent';
type Confidence = 'high' | 'medium' | 'low';
type Candidate = {
  taskKey: string; sourceType: 'crm_rule' | 'conversation_rule'; category: Category;
  title: string; description: string; priority: Priority; assignedTo: string; dueAt: string | null;
  leadId: string | null; conversationId: string | null; sourceMessageId: string | null;
  evidenceText: string; evidenceChannel: string | null; confidence: Confidence;
};
type LeadRow = {
  id: string; client_name: string; company_name: string; client_email: string; client_phone: string;
  property_name: string; inquiry_type: string; status: string; assigned_to: string;
  check_in: string | null; check_out: string | null; next_follow_up: string | Date | null;
  created_at: string | Date; updated_at: string | Date;
};
type MessageRow = {
  conversation_id: string; linked_lead_id: string | null; message_id: string; channel_key: string;
  title: string; participant_display: string; body_text: string; subject: string;
  message_at: string | Date; assigned_to: string | null; company_name: string | null;
};

function classifyInboundMessage(body: string, subject = ''): Pick<Candidate, 'category' | 'title' | 'description' | 'priority' | 'confidence'> | null {
  const text = (subject + ' ' + body).slice(0, 20000);
  if (/\b(quote|quotation|proposal|rate card|pricing|price estimate|estimate|cost breakdown)\b/i.test(text)) {
    return { category: 'quotation', title: 'Review and prepare a quotation', description: 'The latest inbound message appears to request pricing or a proposal. Verify rates and terms against the hotel source of truth before responding.', priority: 'high', confidence: 'medium' };
  }
  if (/\b(availability|available|room block|rooms? for|check (the )?dates|do you have rooms|confirm (the )?dates)\b/i.test(text)) {
    return { category: 'availability', title: 'Verify availability with reservations', description: 'The latest inbound message appears to ask about dates or room availability. Check the reservations system before making any commitment.', priority: 'high', confidence: 'medium' };
  }
  if (/\b(call me|please call|give me a call|call back|callback|phone me)\b/i.test(text)) {
    return { category: 'callback', title: 'Return the client’s call', description: 'The latest inbound message appears to request a call. Confirm the right contact and log the outcome after speaking.', priority: 'normal', confidence: 'medium' };
  }
  if (/\b(please confirm|follow[ -]?up|let me know|revert (back )?to me|send (me )?(the )?(details|information)|share (the )?details|waiting for (an )?update|update me|respond|response)\b/i.test(text)) {
    return { category: 'client_request', title: 'Review and respond to the client request', description: 'The latest inbound message appears to ask for a response or update. Open the source conversation to verify the request and next step.', priority: 'normal', confidence: 'low' };
  }
  return null;
}

async function buildCandidates(member: WorkspaceMember): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const leadResult = await pool.query<LeadRow>(
    `SELECT id, client_name, company_name, client_email, client_phone, property_name, inquiry_type,
            status, assigned_to, check_in, check_out, next_follow_up, created_at, updated_at
     FROM leads WHERE workspace_id=$1 AND status NOT IN ('Confirmed','Lost')
     ORDER BY COALESCE(next_follow_up, updated_at) ASC LIMIT 500`,
    [member.workspace_id]
  );
  const now = Date.now();
  for (const lead of leadResult.rows) {
    const label = lead.company_name || lead.client_name || 'this inquiry';
    const owner = lead.assigned_to?.trim() || 'Unassigned';
    const next = lead.next_follow_up ? (lead.next_follow_up instanceof Date ? lead.next_follow_up : new Date(lead.next_follow_up)) : null;
    if (next && !Number.isNaN(next.getTime()) && next.getTime() <= now + 24 * 60 * 60 * 1000) {
      const overdue = next.getTime() < now;
      candidates.push({
        taskKey: `lead:${lead.id}:follow-up:${next.toISOString()}`, sourceType: 'crm_rule', category: 'follow_up',
        title: (overdue ? 'Overdue follow-up · ' : 'Follow up · ') + label,
        description: 'A follow-up is scheduled in the inquiry record. Review the latest conversation and record the outcome; this task does not mean a message was sent.',
        priority: overdue ? 'urgent' : 'high', assignedTo: owner,
        dueAt: next.toISOString(), leadId: lead.id, conversationId: null, sourceMessageId: null,
        evidenceText: 'CRM next follow-up: ' + next.toISOString(), evidenceChannel: 'crm', confidence: 'high'
      });
    }
    if (!owner || owner.toLowerCase() === 'unassigned') {
      candidates.push({
        taskKey: `lead:${lead.id}:assign-owner`, sourceType: 'crm_rule', category: 'ownership',
        title: 'Assign an owner · ' + label,
        description: 'This active inquiry has no named owner in the CRM. Assign one person to own the next step.',
        priority: 'high', assignedTo: 'Unassigned', dueAt: null, leadId: lead.id,
        conversationId: null, sourceMessageId: null, evidenceText: 'CRM assigned_to is empty or Unassigned.',
        evidenceChannel: 'crm', confidence: 'high'
      });
    }
    if (!lead.client_email?.trim() && !lead.client_phone?.trim()) {
      candidates.push({
        taskKey: `lead:${lead.id}:client-contact`, sourceType: 'crm_rule', category: 'missing_information',
        title: 'Add client contact details · ' + label,
        description: 'The inquiry has neither a client email nor a client phone number. Confirm the correct contact details before attempting outreach.',
        priority: 'normal', assignedTo: owner, dueAt: null, leadId: lead.id, conversationId: null,
        sourceMessageId: null, evidenceText: 'CRM contact fields are empty.', evidenceChannel: 'crm', confidence: 'high'
      });
    }
    if (!lead.check_in && !lead.check_out) {
      candidates.push({
        taskKey: `lead:${lead.id}:event-dates`, sourceType: 'crm_rule', category: 'missing_information',
        title: 'Confirm dates · ' + label,
        description: 'No start or end date is recorded for this active inquiry. Confirm the dates before checking inventory or pricing.',
        priority: 'normal', assignedTo: owner, dueAt: null, leadId: lead.id, conversationId: null,
        sourceMessageId: null, evidenceText: 'CRM check-in and check-out dates are blank.', evidenceChannel: 'crm', confidence: 'high'
      });
    }
    const lastUpdated = lead.updated_at instanceof Date ? lead.updated_at : new Date(lead.updated_at);
    if (lead.status === 'Proposal sent' && !next && now - lastUpdated.getTime() >= 3 * 86400000) {
      candidates.push({
        taskKey: `lead:${lead.id}:proposal-stale`, sourceType: 'crm_rule', category: 'follow_up',
        title: 'Check on the outstanding proposal · ' + label,
        description: 'The inquiry is marked Proposal sent, has no scheduled follow-up, and has not been updated for at least three days. Verify the proposal was actually sent and decide whether to follow up.',
        priority: 'normal', assignedTo: owner, dueAt: null, leadId: lead.id, conversationId: null,
        sourceMessageId: null, evidenceText: 'CRM status is Proposal sent; no next follow-up is scheduled.', evidenceChannel: 'crm', confidence: 'medium'
      });
    }
  }

  // Only analyse the latest inbound message per open conversation. Tasks are suggestions, not extracted facts.
  const messages = await pool.query<MessageRow>(
    `SELECT c.id AS conversation_id, c.linked_lead_id, m.id AS message_id, c.channel_key,
            c.title, c.participant_display, m.body_text, m.subject,
            COALESCE(m.provider_created_at, m.created_at) AS message_at,
            l.assigned_to, l.company_name
     FROM sp_conversations c
     JOIN LATERAL (
       SELECT id, direction, body_text, subject, provider_created_at, created_at
       FROM sp_channel_messages
       WHERE workspace_id=c.workspace_id AND conversation_id=c.id
       ORDER BY COALESCE(provider_created_at, created_at) DESC, id DESC LIMIT 1
     ) m ON m.direction='inbound'
     LEFT JOIN leads l ON l.id=c.linked_lead_id AND l.workspace_id=c.workspace_id
     WHERE c.workspace_id=$1 AND c.status IN ('open','pending')
       AND c.channel_key IN ('whatsapp','email_gmail','email_outlook','instagram','facebook')
       AND COALESCE(m.provider_created_at, m.created_at) >= now() - interval '30 days'
     ORDER BY COALESCE(m.provider_created_at, m.created_at) DESC LIMIT 200`,
    [member.workspace_id]
  );
  for (const message of messages.rows) {
    const classified = classifyInboundMessage(message.body_text || '', message.subject || '');
    if (!classified) continue;
    const channelLabel = message.channel_key === 'whatsapp' ? 'WhatsApp' : message.channel_key === 'email_gmail' ? 'Gmail' : message.channel_key === 'email_outlook' ? 'Outlook' : message.channel_key === 'instagram' ? 'Instagram' : 'Messenger';
    const excerpt = (message.subject ? message.subject + ' — ' : '') + String(message.body_text || '').replace(/\s+/g, ' ').slice(0, 280);
    candidates.push({
      taskKey: `message:${message.message_id}:${classified.category}`, sourceType: 'conversation_rule',
      category: classified.category, title: classified.title + ' · ' + (message.company_name || message.participant_display || message.title || 'Unlinked conversation'),
      description: classified.description, priority: classified.priority,
      assignedTo: message.assigned_to?.trim() || 'Unassigned', dueAt: null,
      leadId: message.linked_lead_id, conversationId: message.conversation_id, sourceMessageId: message.message_id,
      evidenceText: excerpt, evidenceChannel: channelLabel, confidence: classified.confidence
    });
  }
  return candidates;
}

async function refreshCandidates(member: WorkspaceMember): Promise<number> {
  const candidates = await buildCandidates(member);
  return await inTransaction(async client => {
    if (!candidates.length) {
      await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'action_centre.refreshed', entityType: 'action_task', metadata: { candidate_count: 0, touched_count: 0 } });
      return 0;
    }
    // Bulk upsert keeps a scan of hundreds of inquiries bounded to one database round trip.
    const records = candidates.map(task => ({
      task_key: task.taskKey, source_type: task.sourceType, category: task.category,
      title: task.title, description: task.description, priority: task.priority,
      assigned_to: task.assignedTo, due_at: task.dueAt, lead_id: task.leadId,
      conversation_id: task.conversationId, source_message_id: task.sourceMessageId,
      evidence_text: task.evidenceText, evidence_channel: task.evidenceChannel, confidence: task.confidence
    }));
    const result = await client.query(
      `INSERT INTO sp_action_tasks (
        workspace_id, task_key, source_type, category, title, description, priority, status,
        assigned_to, due_at, lead_id, conversation_id, source_message_id, evidence_text,
        evidence_channel, confidence, created_by_user_id
      )
      SELECT $1, x.task_key, x.source_type, x.category, x.title, x.description, x.priority, 'open',
             COALESCE(NULLIF(x.assigned_to, ''), 'Unassigned'), x.due_at, x.lead_id, x.conversation_id,
             x.source_message_id, COALESCE(x.evidence_text, ''), x.evidence_channel, x.confidence, $3
      FROM jsonb_to_recordset($2::jsonb) AS x(
        task_key text, source_type text, category text, title text, description text, priority text,
        assigned_to text, due_at timestamptz, lead_id uuid, conversation_id uuid, source_message_id uuid,
        evidence_text text, evidence_channel text, confidence text
      )
      ON CONFLICT (workspace_id, task_key) DO UPDATE SET
        title=EXCLUDED.title, description=EXCLUDED.description, priority=EXCLUDED.priority,
        assigned_to=CASE WHEN sp_action_tasks.assigned_to='Unassigned' THEN EXCLUDED.assigned_to ELSE sp_action_tasks.assigned_to END,
        due_at=COALESCE(sp_action_tasks.due_at, EXCLUDED.due_at),
        lead_id=COALESCE(sp_action_tasks.lead_id, EXCLUDED.lead_id),
        conversation_id=COALESCE(sp_action_tasks.conversation_id, EXCLUDED.conversation_id),
        source_message_id=COALESCE(sp_action_tasks.source_message_id, EXCLUDED.source_message_id),
        evidence_text=EXCLUDED.evidence_text, evidence_channel=EXCLUDED.evidence_channel,
        confidence=EXCLUDED.confidence, updated_at=now()
      WHERE sp_action_tasks.status='open'
      RETURNING id`,
      [member.workspace_id, JSON.stringify(records), member.user_id]
    );
    const touched = result.rowCount ?? result.rows.length;
    await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'action_centre.refreshed', entityType: 'action_task', metadata: { candidate_count: candidates.length, touched_count: touched } });
    return touched;
  });
}

export async function registerActionCentreRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/action-centre/tasks', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply);
    if (!member) return;
    const query = request.query && typeof request.query === 'object' ? request.query as Record<string, unknown> : {};
    const status = typeof query.status === 'string' ? query.status : 'open';
    if (!['open', 'completed', 'dismissed', 'all'].includes(status)) return fail(reply, 400, 'Unsupported task status filter.', 'invalid_task_filter');
    try {
      const whereStatus = status === 'all' ? '' : 'AND t.status=$2';
      const params = status === 'all' ? [member.workspace_id] : [member.workspace_id, status];
      const tasks = await pool.query(
        `SELECT t.id, t.task_key, t.source_type, t.category, t.title, t.description, t.priority, t.status,
                t.assigned_to, t.due_at, t.lead_id, t.conversation_id, t.source_message_id,
                t.evidence_text, t.evidence_channel, t.confidence, t.completion_note, t.created_at, t.updated_at, t.completed_at,
                l.client_name, l.company_name, l.property_name, l.status AS lead_status,
                c.title AS conversation_title, c.participant_display, c.channel_key AS conversation_channel
         FROM sp_action_tasks t
         LEFT JOIN leads l ON l.id=t.lead_id AND l.workspace_id=t.workspace_id
         LEFT JOIN sp_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
         WHERE t.workspace_id=$1 ${whereStatus}
         ORDER BY CASE WHEN t.status='open' AND t.due_at < now() THEN 0
                       WHEN t.status='open' AND t.priority='urgent' THEN 1
                       WHEN t.status='open' AND t.priority='high' THEN 2
                       ELSE 3 END,
                  t.due_at ASC NULLS LAST, t.created_at DESC LIMIT 250`,
        params
      );
      const channels = await pool.query(
        `SELECT channel_key, display_name, status, account_label, last_synced_at, last_webhook_at, last_error_code
         FROM sp_channel_connections WHERE workspace_id=$1 AND channel_key IN ('whatsapp','email_gmail','email_outlook')
         ORDER BY CASE channel_key WHEN 'whatsapp' THEN 1 WHEN 'email_gmail' THEN 2 ELSE 3 END`,
        [member.workspace_id]
      );
      const openRows = tasks.rows.filter((task: { status: string }) => task.status === 'open');
      noStore(reply);
      return reply.send({
        tasks: tasks.rows,
        channels: channels.rows,
        summary: {
          open: openRows.length,
          overdue: openRows.filter((task: { due_at: string | null }) => task.due_at && new Date(task.due_at).getTime() < Date.now()).length,
          unassigned: openRows.filter((task: { assigned_to: string }) => !task.assigned_to || task.assigned_to.toLowerCase() === 'unassigned').length,
          conversation: openRows.filter((task: { source_type: string }) => task.source_type === 'conversation_rule').length
        }
      });
    } catch {
      return fail(reply, 500, 'Could not load Action Centre tasks.', 'action_tasks_list_failed');
    }
  });

  app.post('/api/action-centre/refresh', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, writerRoles);
    if (!member) return;
    try {
      const count = await refreshCandidates(member);
      noStore(reply);
      return reply.send({ ok: true, candidates_updated: count, message: 'Records scanned. Review each suggested action and its evidence before acting.' });
    } catch {
      return fail(reply, 500, 'Could not scan records for action candidates.', 'action_tasks_refresh_failed');
    }
  });

  app.post('/api/action-centre/tasks', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, writerRoles);
    if (!member) return;
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    const title = safeText(body.title, 180);
    const description = safeText(body.description ?? '', 1000) || '';
    const assignedTo = safeText(body.assigned_to ?? 'Unassigned', 120) || 'Unassigned';
    const leadId = body.lead_id === undefined || body.lead_id === null || body.lead_id === '' ? null : body.lead_id;
    if (!title || title.trim().length < 3) return fail(reply, 400, 'Task title must be at least three characters.', 'invalid_task_title');
    if (leadId !== null && (typeof leadId !== 'string' || !isUuid(leadId))) return fail(reply, 400, 'A valid inquiry ID is required.', 'invalid_task_lead');
    let dueAt: string | null = null;
    if (body.due_at !== undefined && body.due_at !== null && body.due_at !== '') {
      if (typeof body.due_at !== 'string' || Number.isNaN(Date.parse(body.due_at))) return fail(reply, 400, 'Due date must be a valid date.', 'invalid_task_due_date');
      dueAt = new Date(body.due_at).toISOString();
    }
    try {
      if (leadId) {
        const linked = await pool.query('SELECT id FROM leads WHERE id=$1 AND workspace_id=$2 LIMIT 1', [leadId, member.workspace_id]);
        if (!linked.rows.length) return fail(reply, 404, 'Linked inquiry not found.', 'task_lead_not_found');
      }
      const id = randomUUID();
      await inTransaction(async client => {
        await client.query(
          `INSERT INTO sp_action_tasks (id, workspace_id, task_key, source_type, category, title, description,
            priority, status, assigned_to, due_at, lead_id, evidence_text, evidence_channel, confidence, created_by_user_id)
           VALUES ($1,$2,$3,'manual','other',$4,$5,'normal','open',$6,$7,$8,'Created manually by a workspace member.','manual','high',$9)`,
          [id, member.workspace_id, 'manual:' + id, title.trim(), description, assignedTo, dueAt, leadId, member.user_id]
        );
        await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'action_task.created', entityType: 'action_task', entityId: id, metadata: { linked_lead: Boolean(leadId) } });
      });
      noStore(reply);
      return reply.code(201).send({ ok: true, id });
    } catch {
      return fail(reply, 500, 'Could not create task.', 'action_task_create_failed');
    }
  });

  app.post('/api/action-centre/tasks/:id/status', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, writerRoles);
    if (!member) return;
    const id = (request.params as { id?: string }).id || '';
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    const status = body.status;
    const completionNote = safeText(body.completion_note ?? '', 500) || '';
    if (!isUuid(id)) return fail(reply, 400, 'A valid task ID is required.', 'invalid_task_id');
    if (!['open', 'completed', 'dismissed'].includes(String(status))) return fail(reply, 400, 'Task status must be open, completed or dismissed.', 'invalid_task_status');
    if (status === 'completed' && completionNote.trim().length < 5) return fail(reply, 400, 'Record what verifies completion before marking this action done.', 'completion_evidence_required');
    try {
      const updated = await inTransaction(async client => {
        const existing = await client.query('SELECT id, status FROM sp_action_tasks WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [id, member.workspace_id]);
        if (!existing.rows.length) return false;
        await client.query(
          `UPDATE sp_action_tasks SET status=$1, completed_at=CASE WHEN $1='completed' THEN now() ELSE NULL END,
             completed_by_user_id=CASE WHEN $1='completed' THEN $2 ELSE NULL END,
             completion_note=CASE WHEN $1='completed' THEN $3 WHEN $1='open' THEN '' ELSE completion_note END,
             updated_at=now()
           WHERE id=$4 AND workspace_id=$5`,
          [status, member.user_id, completionNote.trim(), id, member.workspace_id]
        );
        await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'action_task.status_changed', entityType: 'action_task', entityId: id, metadata: { from: existing.rows[0].status, to: status, completion_evidence_provided: status === 'completed' } });
        return true;
      });
      if (!updated) return fail(reply, 404, 'Task not found.', 'action_task_not_found');
      noStore(reply);
      return reply.send({ ok: true, id, status });
    } catch {
      return fail(reply, 500, 'Could not update task status.', 'action_task_update_failed');
    }
  });
}
