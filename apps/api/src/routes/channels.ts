import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireWorkspaceMember } from '../auth.js';
import { fail, noStore } from '../http.js';
import { MailSyncError, syncMailboxForWorkspace } from './mail-sync.js';

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

  app.post('/api/integrations/sync', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin', 'sales']);
    if (!member) return;
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, unknown> : {};
    const channelKey = body.channel_key;
    if (channelKey !== 'email_gmail' && channelKey !== 'email_outlook') {
      return fail(reply, 400, 'Choose Gmail or Outlook by setting channel_key to email_gmail or email_outlook.', 'invalid_mail_channel');
    }
    try {
      const result = await syncMailboxForWorkspace(member, channelKey);
      noStore(reply);
      return reply.send(result);
    } catch (error) {
      const connector = error instanceof MailSyncError ? error : new MailSyncError('mail_sync_failed', 502);
      return fail(reply, connector.statusCode, connector.message, connector.code);
    }
  });
}
