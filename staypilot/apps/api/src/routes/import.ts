import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireWorkspaceMember } from '../auth.js';
import { fail, noStore } from '../http.js';
import { createLeadsBatch } from '../domain.js';
import { leadSchema } from '../validation.js';

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function findMatches(workspaceId: string, lead: ReturnType<typeof leadSchema.parse>) {
  const { rows } = await pool.query(
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
  return rows;
}

function findInFileDuplicates(entries: Array<{ rowNumber: number; lead: ReturnType<typeof leadSchema.parse> }>) {
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

    const entries: Array<{ rowNumber: number; lead: ReturnType<typeof leadSchema.parse> }> = [];
    const errors: Array<{ row: number; error: string }> = [];
    for (let i = 0; i < body.rows.length; i++) {
      const parsed = leadSchema.safeParse({ ...(body.rows[i] as Record<string, unknown>), source: 'Spreadsheet', status: 'New inquiry' });
      if (!parsed.success) errors.push({ row: i + 1, error: parsed.error.issues[0]?.message || 'Invalid row.' });
      else if (!parsed.data.company_name?.trim()) errors.push({ row: i + 1, error: 'Company or organisation is required for imported inquiries.' });
      else entries.push({ rowNumber: i + 1, lead: { ...parsed.data, source: 'Spreadsheet', status: 'New inquiry' } });
    }
    if (errors.length) {
      return reply.code(422).send({ ok: false, mode, errors, valid_rows: entries.length, invalid_rows: errors.length, message: 'No rows were imported. Fix invalid rows and preview again.' });
    }

    try {
      const duplicates = findInFileDuplicates(entries);
      for (const entry of entries) {
        const existing = await findMatches(member.workspace_id, entry.lead);
        for (const row of existing) {
          duplicates.push({ row: entry.rowNumber, matches_existing_lead_id: row.id, client_name: row.client_name, company_name: row.company_name, property_name: row.property_name, status: row.status, reason: 'possible existing inquiry' });
        }
      }
      if (mode === 'preview') {
        noStore(reply);
        return reply.send({ ok: true, mode, row_count: entries.length, invalid_rows: 0, potential_duplicates: duplicates, duplicate_count: duplicates.length, requires_duplicate_confirmation: duplicates.length > 0, message: duplicates.length ? 'Review the likely overlaps; StayPilot will not auto-merge them.' : 'Rows passed validation. Confirm commit to write the batch.' });
      }
      if (duplicates.length && body.confirm_duplicates !== true) {
        noStore(reply);
        return reply.code(409).send({ ok: false, code: 'duplicate_confirmation_required', potential_duplicates: duplicates, message: 'Review the matches and resubmit with confirm_duplicates=true only if the import is intentional.' });
      }
      const leads = await createLeadsBatch({ workspaceId: member.workspace_id, actor: member, entries });
      noStore(reply);
      return reply.code(201).send({ ok: true, mode: 'commit', created: leads.length, leads, duplicates_reviewed: duplicates.length });
    } catch {
      return fail(reply, 500, 'Spreadsheet import failed; the batch was not reported as successful.', 'lead_import_failed');
    }
  });
}
