import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../config.js';
import { inTransaction } from '../db.js';
import { fail, noStore } from '../http.js';
import { sha256, verifyMetaSignature, constantTimeStringEqual } from '../security.js';
import { upsertExternalMessageWithClient } from '../domain.js';

interface RawRequest extends FastifyRequest { rawBody?: Buffer }
interface InboundMessage {
  channelKey: 'whatsapp' | 'instagram' | 'facebook';
  eventType: string;
  externalAccountId: string;
  externalThreadId: string;
  providerMessageId: string;
  title: string;
  participantDisplay: string;
  participantAddress: string;
  senderName: string;
  senderAddress: string;
  recipientAddress: string;
  bodyText: string;
  providerCreatedAt: string | null;
}

type AnyRecord = Record<string, any>;
function record(value: unknown): AnyRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {}; }
function array(value: unknown): AnyRecord[] { return Array.isArray(value) ? value.map(record) : []; }
function short(value: unknown, length = 500): string { return String(value ?? '').slice(0, length); }

function textForWhatsApp(message: AnyRecord): string {
  if (message.type === 'text') return short(record(message.text).body, 20_000);
  if (message.type === 'button') return short(record(message.button).text || '[Button reply]', 20_000);
  if (message.type === 'interactive') {
    const interactive = record(message.interactive);
    return short(record(interactive.button_reply).title || record(interactive.list_reply).title || '[Interactive reply]', 20_000);
  }
  // Media are not downloaded. Storing a marker avoids retaining media without an explicit policy.
  return `[Incoming ${short(message.type || 'message', 40)}; media content not downloaded]`;
}

function flattenInbound(payload: AnyRecord): InboundMessage[] {
  const results: InboundMessage[] = [];
  const objectType = short(payload.object, 40);
  for (const entry of array(payload.entry)) {
    if (objectType === 'whatsapp_business_account') {
      for (const change of array(entry.changes)) {
        const value = record(change.value);
        const metadata = record(value.metadata);
        const contacts = array(value.contacts);
        for (const message of array(value.messages)) {
          const messageId = short(message.id, 500);
          const from = short(message.from, 320);
          const phoneNumberId = short(metadata.phone_number_id || entry.id, 255);
          if (!messageId || !from || !phoneNumberId) continue;
          const contact = contacts.find(item => short(item.wa_id) === from) || {};
          const timestampRaw = Number(message.timestamp);
          const providerCreatedAt = Number.isFinite(timestampRaw) && timestampRaw > 0 && timestampRaw < 8_640_000_000_000 ? new Date(timestampRaw * 1000).toISOString() : null;
          const name = short(record(contact.profile).name || from, 160);
          results.push({
            channelKey: 'whatsapp', eventType: 'whatsapp.message', externalAccountId: phoneNumberId,
            externalThreadId: `${phoneNumberId}:${from}`, providerMessageId: messageId,
            title: 'WhatsApp conversation', participantDisplay: name, participantAddress: from,
            senderName: name, senderAddress: from, recipientAddress: short(metadata.display_phone_number, 320),
            bodyText: textForWhatsApp(message), providerCreatedAt
          });
        }
      }
      continue;
    }
    if (objectType === 'page' || objectType === 'instagram') {
      const channelKey = objectType === 'instagram' ? 'instagram' : 'facebook';
      for (const event of array(entry.messaging)) {
        const message = record(event.message);
        if (!message.mid || message.is_echo || event.read || event.delivery) continue;
        const sender = record(event.sender), recipient = record(event.recipient);
        const senderId = short(sender.id, 320), recipientId = short(recipient.id || entry.id, 320);
        const messageId = short(message.mid, 500);
        if (!senderId || !recipientId || !messageId) continue;
        const timestampRaw = Number(event.timestamp);
        const providerCreatedAt = Number.isFinite(timestampRaw) && timestampRaw > 0 && timestampRaw < 8_640_000_000_000_000 ? new Date(timestampRaw).toISOString() : null;
        const bodyText = typeof message.text === 'string' ? message.text.slice(0, 20_000)
          : (Array.isArray(message.attachments) && message.attachments.length ? '[Message with attachment; attachment not downloaded]' : '[Social message]');
        results.push({
          channelKey, eventType: `${channelKey}.message`, externalAccountId: short(entry.id || recipientId, 255),
          externalThreadId: `${recipientId}:${senderId}`, providerMessageId: messageId,
          title: channelKey === 'instagram' ? 'Instagram conversation' : 'Facebook conversation',
          participantDisplay: short(sender.name || senderId, 160), participantAddress: senderId,
          senderName: short(sender.name || senderId, 160), senderAddress: senderId, recipientAddress: recipientId,
          bodyText, providerCreatedAt
        });
      }
    }
  }
  return results;
}

function queryValue(query: Record<string, unknown>, key: string): string {
  const direct = query[key];
  return typeof direct === 'string' ? direct : '';
}

export async function registerMetaWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/webhooks/meta', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const mode = queryValue(query, 'hub.mode');
    const token = queryValue(query, 'hub.verify_token');
    const challenge = queryValue(query, 'hub.challenge');
    if (!env.metaWebhookVerifyToken) return fail(reply, 503, 'Meta webhook verification is not configured.', 'webhook_setup_required');
    if (mode !== 'subscribe' || !constantTimeStringEqual(token, env.metaWebhookVerifyToken) || !challenge || challenge.length > 500) {
      return fail(reply, 403, 'Webhook verification failed.', 'webhook_verification_failed');
    }
    reply.type('text/plain; charset=utf-8');
    return reply.send(challenge);
  });

  app.post('/api/webhooks/meta', async (request, reply) => {
    const raw = (request as RawRequest).rawBody;
    if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > env.webhookBodyLimitBytes) {
      return fail(reply, 413, 'Webhook payload is empty or exceeds the configured size limit.', 'invalid_webhook_payload');
    }
    if (!env.metaAppSecret) return fail(reply, 503, 'Meta webhook signature verification is not configured.', 'webhook_setup_required');
    const signatureHeader = request.headers['x-hub-signature-256'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!verifyMetaSignature(raw, signature, env.metaAppSecret)) {
      return fail(reply, 401, 'Webhook signature is invalid.', 'webhook_signature_invalid');
    }
    // Only inspect parsed data after the raw request signature has passed verification.
    const payload = record(request.body);
    const payloadHash = sha256(raw);
    const messages = flattenInbound(payload);
    if (messages.length > 100) return fail(reply, 413, 'The webhook contains too many message events for one request.', 'webhook_event_batch_too_large');
    const messageKey = messages.length
      ? `messages:${sha256(messages.map(message => `${message.channelKey}:${message.providerMessageId}`).sort().join('|'))}`
      : `payload:${payloadHash}`;
    try {
      const outcome = await inTransaction(async client => {
        const claim = await client.query<{ id: string }>(
          `INSERT INTO sp_webhook_events (provider,event_key,event_type,payload_hash,status)
           VALUES ('meta',$1,$2,$3,'processing') ON CONFLICT (provider,event_key) DO NOTHING RETURNING id`,
          [messageKey, messages.length ? 'meta.inbound_messages' : 'meta.non_message_event', payloadHash]
        );
        const eventId = claim.rows[0]?.id;
        if (!eventId) return { duplicate: true, imported: 0 };
        if (!messages.length) {
          await client.query("UPDATE sp_webhook_events SET status='ignored', processed_at=now() WHERE id=$1", [eventId]);
          return { duplicate: false, imported: 0 };
        }
        const workspaceResult = await client.query<{ id: string }>("SELECT id FROM workspaces WHERE slug='default' LIMIT 1");
        const workspaceId = workspaceResult.rows[0]?.id;
        if (!workspaceId) throw new Error('workspace_not_provisioned');
        let imported = 0;
        for (const message of messages) {
          const result = await upsertExternalMessageWithClient(client, {
            workspaceId,
            channelKey: message.channelKey,
            externalAccountId: message.externalAccountId,
            externalThreadId: message.externalThreadId,
            title: message.title,
            participantDisplay: message.participantDisplay,
            participantAddress: message.participantAddress,
            providerMessageId: message.providerMessageId,
            senderName: message.senderName,
            senderAddress: message.senderAddress,
            recipientAddress: message.recipientAddress,
            bodyText: message.bodyText,
            providerCreatedAt: message.providerCreatedAt,
            metadata: { provider: 'meta', event_type: message.eventType }
          });
          if (result.inserted) imported++;
          await client.query(
            `UPDATE sp_channel_connections SET status='inbound_active', last_webhook_at=now(), last_error_code=NULL, updated_at=now()
             WHERE workspace_id=$2 AND channel_key=$1`, [message.channelKey, workspaceId]
          );
        }
        await client.query("UPDATE sp_webhook_events SET status='processed',processed_at=now(),error_code=NULL WHERE id=$1", [eventId]);
        return { duplicate: false, imported };
      });
      noStore(reply);
      return reply.send({ received: true, imported: outcome.imported, duplicate_event: outcome.duplicate });
    } catch {
      // The transaction rolls back completely; Meta can retry the same signed delivery.
      return fail(reply, 500, 'The verified webhook could not be stored. It may be retried.', 'webhook_ingest_failed');
    }
  });
}
