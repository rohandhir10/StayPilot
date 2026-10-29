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
    if (channelKey !== undefined && channelKey !== 'email_gmail' && channelKey !== 'email_outlook') {
      return fail(reply, 400, 'Choose Gmail or Outlook by setting channel_key to email_gmail or email_outlook.', 'invalid_mail_channel');
    }
    try {
      if (channelKey === 'email_gmail' || channelKey === 'email_outlook') {
        const result = await syncMailboxForWorkspace(member, channelKey);
        noStore(reply);
        return reply.send(result);
      }
      const connected = await pool.query<{ channel_key: 'email_gmail' | 'email_outlook' }>(
        "SELECT channel_key FROM sp_channel_oauth_credentials WHERE workspace_id=$1 ORDER BY channel_key", [member.workspace_id]
      );
      if (!connected.rows.length) return fail(reply, 409, 'No email mailbox is connected to this workspace yet.', 'mail_not_connected');
      const results: Array<Record<string, unknown>> = [];
      for (const connection of connected.rows) {
        try {
          results.push({ ...(await syncMailboxForWorkspace(member, connection.channel_key)), ok: true });
        } catch (error) {
          const connector = error instanceof MailSyncError ? error : new MailSyncError('mail_sync_failed', 502);
          results.push({ channel_key: connection.channel_key, ok: false, code: connector.code, message: connector.message });
        }
      }
      const importedTotal = results.reduce((sum, result) => sum + (typeof result.imported_count === 'number' ? result.imported_count : 0), 0);
      noStore(reply);
      return reply.send({ ok: results.every(result => result.ok === true), imported_total: importedTotal, results });
    } catch (error) {
      const connector = error instanceof MailSyncError ? error : new MailSyncError('mail_sync_failed', 502);
      return fail(reply, connector.statusCode, connector.message, connector.code);
    }
  });
}
