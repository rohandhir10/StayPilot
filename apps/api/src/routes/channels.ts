import type { FastifyInstance } from 'fastify';
import { pool, inTransaction } from '../db.js';
import { requireWorkspaceMember } from '../auth.js';
import { fail, noStore, safeText } from '../http.js';
import { auditEvent } from '../domain.js';
import { metaAccountMappingSchema } from '../validation.js';

export async function registerChannelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/channels/status', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply);
    if (!member) return;
    try {
      const { rows } = await pool.query(
        `SELECT channel_key, provider, display_name, status, connection_mode, account_label, external_account_id,
                last_synced_at, last_webhook_at, last_error_code, updated_at
         FROM sp_channel_connections WHERE workspace_id=$1 ORDER BY display_name`, [member.workspace_id]
      );
      noStore(reply);
      return reply.send({
        connections: rows.map(row => ({
          ...row,
          connected: ['connected', 'inbound_active'].includes(row.status),
          liveDataConfirmed: ['connected', 'inbound_active'].includes(row.status),
          credentialsReturned: false
        })),
        total: rows.length,
        live: rows.filter(row => ['connected', 'inbound_active'].includes(row.status)).length
      });
    } catch {
      return fail(reply, 500, 'Could not load channel status.', 'channel_status_failed');
    }
  });

  app.put('/api/channels/:channelKey/meta-account', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
    if (!member) return;
    const channelKey = (request.params as { channelKey?: string }).channelKey || '';
    if (!['whatsapp', 'instagram', 'facebook'].includes(channelKey)) {
      return fail(reply, 400, 'Choose a supported Meta channel: whatsapp, instagram, or facebook.', 'invalid_meta_channel');
    }
    const parsed = metaAccountMappingSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message || 'Meta account mapping is invalid.', 'invalid_meta_account_mapping');
    try {
      const outcome = await inTransaction(async client => {
        const current = await client.query<{ id: string; status: string }>(
          'SELECT id, status FROM sp_channel_connections WHERE workspace_id=$1 AND channel_key=$2 AND provider=\'meta\' FOR UPDATE',
          [member.workspace_id, channelKey]
        );
        if (!current.rows[0]) return { kind: 'missing' as const };
        const updated = await client.query(
          `UPDATE sp_channel_connections
           SET external_account_id=$1, account_label=COALESCE($2,account_label), connection_mode='webhook',
               status='pending', last_error_code=NULL, updated_at=now()
           WHERE workspace_id=$3 AND channel_key=$4 AND provider='meta'
           RETURNING id, channel_key, provider, display_name, status, connection_mode, account_label, external_account_id,
                     last_synced_at, last_webhook_at, last_error_code, updated_at`,
          [parsed.data.external_account_id, parsed.data.account_label ?? null, member.workspace_id, channelKey]
        );
        await auditEvent(client, {
          workspaceId: member.workspace_id, actor: member, action: 'channel.meta_account_configured',
          entityType: 'channel_connection', entityId: current.rows[0].id,
          metadata: { channel_key: channelKey, account_label: safeText(parsed.data.account_label, 160) || '' }
        });
        return { kind: 'ok' as const, connection: updated.rows[0] };
      });
      if (outcome.kind === 'missing') return fail(reply, 404, 'The selected Meta channel is not configured for this workspace.', 'channel_not_found');
      noStore(reply);
      return reply.send({ ok: true, connection: { ...outcome.connection, connected: false, liveDataConfirmed: false, credentialsReturned: false } });
    } catch {
      return fail(reply, 500, 'Could not configure the Meta account mapping.', 'meta_account_configuration_failed');
    }
  });
  // Intentionally not a fake success: inbox sync stays off until each provider's OAuth,
  // refresh-token storage, permissions and retry semantics have been implemented and tested.
  app.post('/api/integrations/sync', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin', 'sales']);
    if (!member) return;
    return fail(reply, 501, 'Mailbox synchronization is not enabled yet. Connectors must be configured and tested before StayPilot imports external mail.', 'channel_sync_unimplemented');
  });
}
