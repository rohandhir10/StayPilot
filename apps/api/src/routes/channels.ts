import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireWorkspaceMember } from '../auth.js';
import { fail, noStore } from '../http.js';

export async function registerChannelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/channels/status', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply);
    if (!member) return;
    try {
      const { rows } = await pool.query(
        `SELECT channel_key, provider, display_name, status, connection_mode, account_label,
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

  // Intentionally not a fake success: inbox sync stays off until each provider's OAuth,
  // refresh-token storage, permissions and retry semantics have been implemented and tested.
  app.post('/api/integrations/sync', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin', 'sales']);
    if (!member) return;
    return fail(reply, 501, 'Mailbox synchronization is not enabled yet. Connectors must be configured and tested before StayPilot imports external mail.', 'channel_sync_unimplemented');
  });
}
