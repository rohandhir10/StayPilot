import type { FastifyInstance } from 'fastify';
import { pool, inTransaction } from '../db.js';
import { requireWorkspaceMember } from '../auth.js';
import { fail, noStore } from '../http.js';
import { createLeadsBatchWithClient } from '../domain.js';
import { sha256 } from '../crypto.js';
import { leadSchema } from '../validation.js';

type LeadEntry = { rowNumber: number; lead: ReturnType<typeof leadSchema.parse> };
type DuplicateLeadRow = {
  id: string;
  client_name: string;
  company_name: string;
  property_name: string;
  check_in: string | null;
  check_out: string | null;
  status: string;
};
type QueryRows = (sql: string, values: unknown[]) => Promise<DuplicateLeadRow[]>;

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function findMatches(queryRows: QueryRows, workspaceId: string, lead: LeadEntry['lead']): Promise<DuplicateLeadRow[]> {
  return await queryRows(
    `SELECT id, client_name, company_name, property_name, check_in, check_out, status
     FROM leads WHERE workspace_id=$1 AND (
       ($2::text <> '' AND lower(client_email)=lower($2)) OR
       ($3::text <> '' AND client_phone=$3) OR
       ($4::text <> '' AND lower(company_name)=lower($4) AND
          ($5::date IS NULL OR check_in IS NULL OR
            (check_in <= COALESCE($6::date,$5::date) AND COALESCE(check_out,check_in) >= $5::date))) OR
       (lower(client_name)=lower($7) AND property_name=$8)
     ) ORDER BY created_at DESC LIMIT 5`,
    [workspaceId, lead.client_email || '', lead.client_phone || '', lead.company_name || '', lead.check_in, lead.check_out, lead.client_name, lead.property_name]
  );
}

function findInFileDuplicates(entries: LeadEntry[]) {
  const matches: Array<Record<string, unknown>> = [];
  for (let i = 0; i < entries.length; i++) {
    const current = entries[i]!;
    for (let j = 0; j < i; j++) {
      const previous = entries[j]!;
      const sameEmail = normalize(current.lead.client_email) && normalize(current.lead.client_email) === normalize(previous.lead.client_email);
      const samePhone = normalize(current.lead.client_phone) && normalize(current.lead.client_phone) === normalize(previous.lead.client_phone);
      const sameClientProperty = normalize(current.lead.client_name) && normalize(current.lead.client_name) === normalize(previous.lead.client_name) && current.lead.property_name === previous.lead.property_name;
      const sameCompanyAndDates = normalize(current.lead.company_name) && normalize(current.lead.company_name) === normalize(previous.lead.company_name) &&
        current.lead.check_in && previous.lead.check_in &&
        current.lead.check_in <= (previous.lead.check_out || previous.lead.check_in) &&
        previous.lead.check_in <= (current.lead.check_out || current.lead.check_in);
      if (sameEmail || samePhone || sameClientProperty || sameCompanyAndDates) {
        matches.push({ row: current.rowNumber, matches_import_row: previous.rowNumber, reason: 'possible duplicate within this file' });
        break;
      }
    }
  }
  return matches;
}

async function findDuplicateCandidates(queryRows: QueryRows, workspaceId: string, entries: LeadEntry[]) {
  const duplicates: Array<Record<string, unknown>> = findInFileDuplicates(entries);
  for (const entry of entries) {
    const existing = await findMatches(queryRows, workspaceId, entry.lead);
    for (const row of existing) {
      duplicates.push({
        row: entry.rowNumber,
        matches_existing_lead_id: row.id,
        client_name: row.client_name,
        company_name: row.company_name,
        property_name: row.property_name,
        status: row.status,
        reason: 'possible existing inquiry'
      });
    }
  }
  return duplicates;
}

async function readDuplicateCandidates(workspaceId: string, entries: LeadEntry[]) {
  const queryRows: QueryRows = async (sql, values) =>
    (await pool.query<DuplicateLeadRow>(sql, values as any[])).rows;
  return await findDuplicateCandidates(queryRows, workspaceId, entries);
}

function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 200 &&
    !/[\\r\\n\\u0000]/.test(value);
}

function leadProjectionSql() {
  return `SELECT l.id, l.workspace_id, l.client_name, l.company_name, l.client_email, l.client_phone,
    l.agent_name, l.agent_email, l.property_name, l.inquiry_type, l.check_in, l.check_out, l.guests,
    l.estimated_value, l.source, l.status, l.assigned_to, l.last_contact_at, l.next_follow_up,
    l.notes, l.created_at, l.updated_at
    FROM unnest($2::uuid[]) WITH ORDINALITY AS item(id, ord)
    JOIN leads l ON l.id=item.id AND l.workspace_id=$1
    ORDER BY item.ord`;
}

export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/leads/import', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner','admin','sales']);
    if (!member) return;
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(reply, 400, 'A JSON object is required.', 'invalid_import');
    const mode = body.mode ?? 'preview';
    if (mode !== 'preview' && mode !== 'commit') return fail(reply, 400, 'Mode must be preview or commit.', 'invalid_import_mode');
    if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > 25) return fail(reply, 400, 'Import 1 to 25 rows per batch.', 'invalid_import_size');
    if (JSON.stringify(body.rows).length > 150_000) return fail(reply, 413, 'Import request is too large.', 'import_too_large');

    let idempotencyKey: string | null = null;
    if (mode === 'commit') {
      const header = request.headers['idempotency-key'];
      if (!isValidIdempotencyKey(header)) return fail(reply, 400, 'Supply an Idempotency-Key header between 8 and 200 characters for every import commit.', 'idempotency_key_required');
      idempotencyKey = header;
    }

    const entries: LeadEntry[] = [];
    const errors: Array<{ row: number; error: string }> = [];
    for (let i = 0; i < body.rows.length; i++) {
      const rawRow = body.rows[i];
      if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
        errors.push({ row: i + 1, error: 'Each row must be a JSON object.' });
        continue;
      }
      const parsed = leadSchema.safeParse({ ...(rawRow as Record<string, unknown>), source: 'Spreadsheet', status: 'New inquiry' });
      if (!parsed.success) errors.push({ row: i + 1, error: parsed.error.issues[0]?.message || 'Invalid row.' });
      else if (!parsed.data.company_name?.trim()) errors.push({ row: i + 1, error: 'Company or organisation is required for imported inquiries.' });
      else entries.push({ rowNumber: i + 1, lead: { ...parsed.data, source: 'Spreadsheet', status: 'New inquiry' } });
    }
    if (errors.length) {
      return reply.code(422).send({ ok: false, mode, errors, valid_rows: entries.length, invalid_rows: errors.length, message: 'No rows were imported. Fix invalid rows and preview again.' });
    }

    try {
      if (mode === 'preview') {
        const duplicates = await readDuplicateCandidates(member.workspace_id, entries);
        noStore(reply);
        return reply.send({
          ok: true, mode, row_count: entries.length, invalid_rows: 0,
          potential_duplicates: duplicates, duplicate_count: duplicates.length,
          requires_duplicate_confirmation: duplicates.length > 0,
          message: duplicates.length ? 'Review the likely overlaps; StayPilot will not auto-merge them.' : 'Rows passed validation. Confirm commit to write the batch.'
        });
      }

      const requestHash = sha256(JSON.stringify(entries.map(entry => ({ rowNumber: entry.rowNumber, lead: entry.lead }))));
      const outcome = await inTransaction(async client => {
        // Serializes commits within the workspace so two simultaneous retries cannot both create the batch.
        const workspace = await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [member.workspace_id]);
        if (!workspace.rows[0]) throw new Error('workspace_not_provisioned');

        const existing = await client.query<{ request_hash: string; lead_ids: string[] }>(
          'SELECT request_hash, lead_ids FROM sp_import_requests WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE',
          [member.workspace_id, idempotencyKey]
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) return { kind: 'conflict' as const };
          const ids = existing.rows[0].lead_ids || [];
          const saved = await client.query(leadProjectionSql(), [member.workspace_id, ids]);
          if (saved.rows.length !== ids.length) return { kind: 'result_missing' as const };
          return { kind: 'replay' as const, leads: saved.rows };
        }

        const queryRows: QueryRows = async (sql, values) =>
          (await client.query<DuplicateLeadRow>(sql, values as any[])).rows;
        const duplicates = await findDuplicateCandidates(queryRows, member.workspace_id, entries);
        if (duplicates.length && body.confirm_duplicates !== true) {
          return { kind: 'confirmation_required' as const, duplicates };
        }

        // Claim and results are in the same transaction as lead/activity/audit writes.
        // A failure at any step rolls back the idempotency row as well as the batch.
        await client.query(
          'INSERT INTO sp_import_requests (workspace_id,idempotency_key,request_hash,lead_ids) VALUES ($1,$2,$3,ARRAY[]::uuid[])',
          [member.workspace_id, idempotencyKey, requestHash]
        );
        const leads = await createLeadsBatchWithClient(client, { workspaceId: member.workspace_id, actor: member, entries });
        const leadIds = leads.map((lead: { id: string }) => lead.id);
        await client.query(
          'UPDATE sp_import_requests SET lead_ids=$3::uuid[] WHERE workspace_id=$1 AND idempotency_key=$2',
          [member.workspace_id, idempotencyKey, leadIds]
        );
        return { kind: 'created' as const, leads, duplicatesReviewed: duplicates.length };
      });

      if (outcome.kind === 'conflict') return fail(reply, 409, 'This idempotency key has already been used with a different import payload.', 'idempotency_conflict');
      if (outcome.kind === 'result_missing') return fail(reply, 409, 'The previous import completed, but one or more resulting inquiries are no longer available. Verify the current inquiry list before starting a new import with a new key.', 'import_result_unavailable');
      if (outcome.kind === 'confirmation_required') {
        noStore(reply);
        return reply.code(409).send({
          ok: false, code: 'duplicate_confirmation_required',
          potential_duplicates: outcome.duplicates,
          message: 'Review the matches and resubmit with confirm_duplicates=true only if the import is intentional. This response does not reserve the idempotency key.'
        });
      }
      if (outcome.kind === 'replay') {
        noStore(reply);
        return reply.send({ ok: true, mode: 'commit', created: 0, leads: outcome.leads, duplicates_reviewed: 0, duplicate_request: true });
      }
      noStore(reply);
      return reply.code(201).send({ ok: true, mode: 'commit', created: outcome.leads.length, leads: outcome.leads, duplicates_reviewed: outcome.duplicatesReviewed, duplicate_request: false });
    } catch {
      return fail(reply, 500, 'Spreadsheet import failed; the batch was not reported as successful.', 'lead_import_failed');
    }
  });
}
