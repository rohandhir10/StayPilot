import type { FastifyInstance } from 'fastify';
import { pool, inTransaction } from '../db.js';
import { requireWorkspaceMember, type MemberRole } from '../auth.js';
import { fail, noStore } from '../http.js';
import { createLeadRecord, auditEvent } from '../domain.js';
import { leadListQuerySchema, leadSchema, leadUpdateSchema } from '../validation.js';
import { decodePageCursor, encodePageCursor } from '../pagination.js';

const writerRoles: MemberRole[] = ['owner', 'admin', 'sales'];

function norm(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '');
}
function overlaps(a: { check_in: string | null; check_out: string | null }, b: { check_in: string | null; check_out: string | null }): boolean {
  if (!a.check_in || !b.check_in) return false;
  return a.check_in <= (b.check_out || b.check_in) && b.check_in <= (a.check_out || a.check_in);
}

export async function registerLeadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/leads/list', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply);
    if (!member) return;
    const parsedQuery = leadListQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return fail(reply, 400, 'Inquiry list filters are invalid.', 'invalid_lead_query');
    const { limit } = parsedQuery.data;
    const cursor = parsedQuery.data.cursor ? decodePageCursor(parsedQuery.data.cursor) : null;
    if (parsedQuery.data.cursor && !cursor) return fail(reply, 400, 'Inquiry list cursor is invalid or expired.', 'invalid_page_cursor');
    try {
      const result = await pool.query(
        `SELECT id, workspace_id, client_name, company_name, client_email, client_phone, agent_name, agent_email,
                property_name, inquiry_type, check_in, check_out, guests, estimated_value, source, status,
                assigned_to, last_contact_at, next_follow_up, notes, created_at, updated_at,
                created_at::text AS cursor_created_at
         FROM leads
         WHERE workspace_id=$1
           AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [member.workspace_id, cursor?.sortAt ?? null, cursor?.id ?? null, limit + 1]
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const lastRow = rows[rows.length - 1];
      const nextCursor = hasMore && lastRow ? encodePageCursor({ sortAt: lastRow.cursor_created_at, id: lastRow.id }) : null;
      const resultLeads = rows.map(lead => {
        const { cursor_created_at: _cursorCreatedAt, ...visibleLead } = lead;
        // Duplicate hints are bounded to the current page rather than scanning the whole workspace.
        const candidates = rows.filter(other => other.id !== lead.id && (
          (norm(lead.client_email) && norm(lead.client_email) === norm(other.client_email)) ||
          (norm(lead.client_phone) && norm(lead.client_phone) === norm(other.client_phone)) ||
          (norm(lead.company_name) && norm(lead.company_name) === norm(other.company_name) && overlaps(lead, other)) ||
          (norm(lead.client_name) && norm(lead.client_name) === norm(other.client_name) && lead.property_name === other.property_name)
        )).slice(0, 5).map(other => ({
          id: other.id, client_name: other.client_name, company_name: other.company_name,
          agent_name: other.agent_name, property_name: other.property_name, check_in: other.check_in,
          check_out: other.check_out, status: other.status, estimated_value: other.estimated_value
        }));
        return { ...visibleLead, duplicate_candidates: candidates };
      });
      noStore(reply);
      return reply.send({ leads: resultLeads, count: resultLeads.length, limit, has_more: hasMore, next_cursor: nextCursor, truncated: hasMore });
    } catch {
      return fail(reply, 500, 'Could not load inquiries.', 'leads_list_failed');
    }
  });

  app.post('/api/leads/create', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, writerRoles);
    if (!member) return;
    const parsed = leadSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message || 'Inquiry data is invalid.', 'invalid_lead');
    if (!parsed.data.company_name?.trim()) return fail(reply, 400, 'Company or organisation is required for staff-entered inquiries.', 'company_required');
    try {
      const lead = await createLeadRecord({
        workspaceId: member.workspace_id, actor: member, lead: parsed.data,
        activityDescription: 'Inquiry added to pipeline'
      });
      noStore(reply);
      return reply.code(201).send({ lead });
    } catch {
      return fail(reply, 500, 'Could not save the inquiry.', 'lead_create_failed');
    }
  });

  app.post('/api/leads/update', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, writerRoles);
    if (!member) return;
    const parsed = leadUpdateSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message || 'Update data is invalid.', 'invalid_update');
    const input = parsed.data;
    const changedFields = ['status', 'assigned_to', 'next_follow_up', 'notes'].filter(key => Object.hasOwn(input, key));
    try {
      // Lock the workspace-scoped row before applying a partial update so concurrent
      // status/assignment/note changes cannot silently overwrite one another.
      const lead = await inTransaction(async client => {
        const existing = await client.query(
          `SELECT id, status, assigned_to, next_follow_up, notes
           FROM leads WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
          [input.id, member.workspace_id]
        );
        const current = existing.rows[0];
        if (!current) return null;
        const status = input.status ?? current.status;
        const assignedTo = input.assigned_to === undefined ? current.assigned_to : (input.assigned_to || 'Unassigned');
        const nextFollowUp = input.next_follow_up === undefined ? current.next_follow_up : input.next_follow_up;
        const notes = input.notes === undefined ? current.notes : input.notes;
        const result = await client.query(
          `UPDATE leads SET status=$1, assigned_to=$2, next_follow_up=$3, notes=$4,
             last_contact_at=CASE WHEN $5 THEN now() ELSE last_contact_at END, updated_at=now()
           WHERE id=$6 AND workspace_id=$7
           RETURNING id, workspace_id, client_name, company_name, client_email, client_phone, agent_name, agent_email,
             property_name, inquiry_type, check_in, check_out, guests, estimated_value, source, status,
             assigned_to, last_contact_at, next_follow_up, notes, created_at, updated_at`,
          [status, assignedTo, nextFollowUp, notes, input.status === 'Contacted', input.id, member.workspace_id]
        );
        if (!result.rows[0]) return null;
        await client.query(
          `INSERT INTO lead_activities (workspace_id, lead_id, activity_type, description, actor_user_id, actor_email, actor)
           VALUES ($1,$2,'updated',$3,$4,$5,$6)`,
          [member.workspace_id, input.id, `Inquiry updated · ${changedFields.join(', ')}`.slice(0, 500), member.user_id, member.email, member.display_name]
        );
        await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'lead.updated', entityType: 'lead', entityId: input.id, metadata: { changed_fields: changedFields } });
        return result.rows[0];
      });
      if (!lead) return fail(reply, 404, 'Inquiry not found.', 'lead_not_found');
      noStore(reply);
      return reply.send({ lead });
    } catch {
      return fail(reply, 500, 'Could not update the inquiry.', 'lead_update_failed');
    }
  });

  app.get('/api/leads/activities', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply);
    if (!member) return;
    const id = (request.query as Record<string, unknown>)?.id;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return fail(reply, 400, 'A valid inquiry ID is required.', 'invalid_lead_id');
    try {
      const lead = await pool.query('SELECT id FROM leads WHERE id=$1 AND workspace_id=$2 LIMIT 1', [id, member.workspace_id]);
      if (!lead.rows.length) return fail(reply, 404, 'Inquiry not found.', 'lead_not_found');
      const { rows } = await pool.query(
        `SELECT id, activity_type, description, actor, actor_email, created_at FROM lead_activities
         WHERE lead_id=$1 AND workspace_id=$2 ORDER BY created_at DESC LIMIT 100`, [id, member.workspace_id]
      );
      noStore(reply);
      return reply.send({ activities: rows });
    } catch {
      return fail(reply, 500, 'Could not load inquiry activity.', 'activity_list_failed');
    }
  });
}
