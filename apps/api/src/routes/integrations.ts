import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { pool, inTransaction } from '../db.js';
import { requireWorkspaceMember } from '../auth.js';
import { fail, noStore, safeText, isUuid } from '../http.js';
import { auditEvent } from '../domain.js';
import { randomPartnerSecret, sha256 } from '../security.js';

async function listKeys(request: FastifyRequest, reply: FastifyReply) {
  const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
  if (!member) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, key_prefix, scopes, is_active, created_by_user_id, last_used_at, created_at, revoked_at
       FROM sp_partner_api_keys WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100`, [member.workspace_id]
    );
    noStore(reply);
    return reply.send({ keys: rows });
  } catch {
    return fail(reply, 500, 'Could not load partner API keys.', 'partner_keys_list_failed');
  }
}

async function createKey(request: FastifyRequest, reply: FastifyReply) {
  const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
  if (!member) return;
  const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body as Record<string, unknown> : {};
  const name = safeText(body.name, 100);
  if (!name || name.length < 2) return fail(reply, 400, 'Give the key a descriptive name of at least two characters.', 'invalid_key_name');
  try {
    const result = await inTransaction(async client => {
      // Lock the workspace row to serialize key creation and enforce the active-key cap under concurrency.
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [member.workspace_id]);
      const count = await client.query('SELECT count(*)::int AS active_count FROM sp_partner_api_keys WHERE workspace_id=$1 AND is_active=true', [member.workspace_id]);
      if (Number(count.rows[0]?.active_count || 0) >= 25) return { limitReached: true as const };
      const secret = randomPartnerSecret();
      const id = randomUUID();
      const prefix = secret.slice(0, 16);
      await client.query(
        `INSERT INTO sp_partner_api_keys (id, workspace_id, name, key_prefix, key_hash, scopes, is_active, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,'["inquiries:create"]'::jsonb,true,$6)`,
        [id, member.workspace_id, name, prefix, sha256(secret), member.user_id]
      );
      await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'partner_key.created', entityType: 'partner_api_key', entityId: id, metadata: { name, key_prefix: prefix, scopes: ['inquiries:create'] } });
      return { limitReached: false as const, id, prefix, secret };
    });
    if (result.limitReached) return fail(reply, 409, 'The workspace has reached the 25-active-key limit. Revoke an unused key first.', 'partner_key_limit_reached');
    noStore(reply);
    return reply.code(201).send({
      key: { id: result.id, name, key_prefix: result.prefix, scopes: ['inquiries:create'], created_at: new Date().toISOString() },
      secret: result.secret,
      warning: 'Copy this secret now. It is stored as a hash and cannot be retrieved later. Keep it only in the partner server secret manager.'
    });
  } catch {
    return fail(reply, 500, 'Could not create the partner API key.', 'partner_key_create_failed');
  }
}

async function revokeKey(request: FastifyRequest, reply: FastifyReply, rawId: unknown) {
  const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
  if (!member) return;
  const id = typeof rawId === 'string' ? rawId : '';
  if (!isUuid(id)) return fail(reply, 400, 'A valid key ID is required.', 'invalid_key_id');
  try {
    const outcome = await inTransaction(async client => {
      const key = await client.query<{ key_prefix: string; is_active: boolean }>(
        'SELECT key_prefix, is_active FROM sp_partner_api_keys WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [id, member.workspace_id]
      );
      if (!key.rows[0]) return 'missing' as const;
      if (!key.rows[0].is_active) return 'already_revoked' as const;
      await client.query('UPDATE sp_partner_api_keys SET is_active=false, revoked_at=now() WHERE id=$1 AND workspace_id=$2', [id, member.workspace_id]);
      await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'partner_key.revoked', entityType: 'partner_api_key', entityId: id, metadata: { key_prefix: key.rows[0].key_prefix } });
      return 'revoked' as const;
    });
    if (outcome === 'missing') return fail(reply, 404, 'Partner API key not found.', 'partner_key_not_found');
    noStore(reply);
    return reply.send({ ok: true, revoked: outcome !== 'already_revoked', already_revoked: outcome === 'already_revoked' });
  } catch {
    return fail(reply, 500, 'Could not revoke the partner API key.', 'partner_key_revoke_failed');
  }
}

export async function registerIntegrationRoutes(app: FastifyInstance): Promise<void> {
  // The two URL shapes share handlers. `/api/integrations/api-keys` preserves the existing UI contract.
  app.get('/api/integrations/keys', listKeys);
  app.get('/api/integrations/api-keys', listKeys);
  app.post('/api/integrations/keys', createKey);
  app.post('/api/integrations/api-keys', createKey);
  app.delete('/api/integrations/keys/:id', async (request, reply) => {
    const id = (request.params as { id?: string }).id;
    return revokeKey(request, reply, id);
  });
  app.delete('/api/integrations/api-keys', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, unknown> : {};
    return revokeKey(request, reply, body.id);
  });
}
