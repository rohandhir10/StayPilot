import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { env } from '../config.js';
import { fail, noStore } from '../http.js';
import { createLeadRecord } from '../domain.js';
import { hitRateLimit, sha256 } from '../security.js';
import { partnerLeadSchema } from '../validation.js';

function bearerToken(header: string | undefined): string | null {
  if (!header || header.length > 200) return null;
  const match = /^Bearer\s+(sp_live_[a-f0-9]{64})$/i.exec(header);
  return match?.[1] || null;
}

export async function registerPartnerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/partner/inquiries', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return fail(reply, 401, 'A valid StayPilot partner key is required.', 'partner_key_required');
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) return fail(reply, 400, 'A JSON object is required.', 'invalid_request');
    if (JSON.stringify(request.body).length > 20_000) return fail(reply, 413, 'Partner inquiry request is too large.', 'request_too_large');
    try {
      const keyResult = await pool.query<{ id: string; workspace_id: string; scopes: string[]; is_active: boolean }>(
        'SELECT id, workspace_id, scopes, is_active FROM sp_partner_api_keys WHERE key_hash=$1 LIMIT 1', [sha256(token)]
      );
      const key = keyResult.rows[0];
      if (!key || !key.is_active || !Array.isArray(key.scopes) || !key.scopes.includes('inquiries:create')) {
        return fail(reply, 401, 'The partner key is invalid or revoked.', 'partner_key_invalid');
      }
      if (!(await hitRateLimit(`partner:${key.id}`, env.partnerRateLimitPerMinute, 60))) {
        reply.header('Retry-After', '60');
        return fail(reply, 429, 'Partner API rate limit exceeded. Retry shortly.', 'rate_limit_exceeded');
      }
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200 || /[\r\n\u0000]/.test(idempotencyKey)) {
        return fail(reply, 400, 'Supply an Idempotency-Key header between 8 and 200 characters.', 'idempotency_key_required');
      }
      const parsed = partnerLeadSchema.safeParse(request.body);
      if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message || 'Inquiry data is invalid.', 'invalid_inquiry');
      const leadInput = parsed.data;
      const requestHash = sha256(JSON.stringify(leadInput));
      const existing = await pool.query<{ request_hash: string; lead_id: string; status: string | null }>(
        `SELECT r.request_hash, r.lead_id, l.status FROM sp_partner_requests r
         LEFT JOIN leads l ON l.id=r.lead_id AND l.workspace_id=r.workspace_id
         WHERE r.api_key_id=$1 AND r.idempotency_key=$2 AND r.workspace_id=$3 LIMIT 1`,
        [key.id, idempotencyKey, key.workspace_id]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) return fail(reply, 409, 'This idempotency key has already been used with a different payload.', 'idempotency_conflict');
        await pool.query('UPDATE sp_partner_api_keys SET last_used_at=now() WHERE id=$1 AND is_active=true', [key.id]);
        noStore(reply);
        return reply.send({ ok: true, duplicate_request: true, lead_id: existing.rows[0].lead_id, status: existing.rows[0].status || 'received' });
      }
      try {
        const lead = await createLeadRecord({
          workspaceId: key.workspace_id, actor: null, lead: leadInput,
          activityDescription: 'Inquiry received through partner API',
          idempotency: { apiKeyId: key.id, key: idempotencyKey, requestHash }
        });
        await pool.query('UPDATE sp_partner_api_keys SET last_used_at=now() WHERE id=$1 AND is_active=true', [key.id]);
        noStore(reply);
        return reply.code(201).send({ ok: true, lead_id: lead.id, status: lead.status });
      } catch {
        const raced = await pool.query<{ request_hash: string; lead_id: string }>(
          'SELECT request_hash, lead_id FROM sp_partner_requests WHERE api_key_id=$1 AND idempotency_key=$2 LIMIT 1', [key.id, idempotencyKey]
        );
        if (raced.rows[0]) {
          if (raced.rows[0].request_hash !== requestHash) return fail(reply, 409, 'This idempotency key has already been used with a different payload.', 'idempotency_conflict');
          return reply.send({ ok: true, duplicate_request: true, lead_id: raced.rows[0].lead_id });
        }
        return fail(reply, 500, 'Partner inquiry could not be stored.', 'partner_inquiry_failed');
      }
    } catch {
      return fail(reply, 500, 'Partner inquiry could not be processed.', 'partner_request_failed');
    }
  });
}
