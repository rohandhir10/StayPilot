import type { FastifyInstance } from 'fastify';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { pool, inTransaction } from '../db.js';
import { requireWorkspaceMember } from '../auth.js';
import { env } from '../config.js';
import { fail, noStore } from '../http.js';
import { auditEvent } from '../domain.js';

type Provider = 'google' | 'microsoft';
type OAuthTokenResponse = { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string };
type ProviderCredential = {
  id: string; workspace_id: string; provider: Provider; channel_key: string; account_email: string;
  external_account_id: string; access_token_ciphertext: string; refresh_token_ciphertext: string;
  token_expires_at: Date; scopes: string[]; sync_cursor: string | null; connected_by_user_id: string;
};
const providerConfig = {
  google: {
    channelKey: 'email_gmail',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
    clientId: () => env.googleOAuthClientId,
    clientSecret: () => env.googleOAuthClientSecret
  },
  microsoft: {
    channelKey: 'email_outlook',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'openid', 'profile', 'email', 'User.Read', 'Mail.Read'],
    clientId: () => env.microsoftOAuthClientId,
    clientSecret: () => env.microsoftOAuthClientSecret
  }
} as const;

function redirectUri(provider: Provider): string {
  if (!env.publicApiUrl) throw new Error('public_api_url_missing');
  return `${env.publicApiUrl}/api/integrations/oauth/${provider}/callback`;
}
function encryptionKey(): Buffer {
  const encoded = env.integrationTokenEncryptionKey;
  if (!encoded) throw new Error('integration_token_encryption_key_missing');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('integration_token_encryption_key_invalid');
  return key;
}
function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
function decrypt(value: string): string {
  const [ivText, tagText, dataText] = value.split('.');
  if (!ivText || !tagText || !dataText) throw new Error('encrypted_token_invalid');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
}
function providerFrom(value: unknown): Provider | null {
  return value === 'google' || value === 'microsoft' ? value : null;
}
function safeProviderError(value: unknown): string {
  if (typeof value !== 'string') return 'provider_request_failed';
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'provider_request_failed';
}
async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`provider_http_${response.status}`);
  return response.json();
}
function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function stripHtml(value: string): string {
  return value.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/\s+/g, ' ').trim().slice(0, 20000);
}
function headerValue(headers: Array<{name?: string; value?: string}>, name: string): string {
  return headers.find(item => item.name?.toLowerCase() === name.toLowerCase())?.value?.slice(0, 1000) || '';
}
function gmailBody(payload: any): string {
  if (payload?.body?.data && payload?.mimeType?.startsWith('text/plain')) return decodeBase64Url(payload.body.data);
  for (const part of payload?.parts || []) {
    const nested = gmailBody(part);
    if (nested) return nested;
  }
  if (payload?.body?.data) return stripHtml(decodeBase64Url(payload.body.data));
  return '';
}
async function exchangeCode(provider: Provider, code: string, verifier: string): Promise<OAuthTokenResponse> {
  const config = providerConfig[provider];
  const clientId = config.clientId();
  const clientSecret = config.clientSecret();
  if (!clientId || !clientSecret) throw new Error('provider_oauth_not_configured');
  const body = new URLSearchParams({
    client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier,
    redirect_uri: redirectUri(provider), grant_type: 'authorization_code'
  });
  return fetchJson(config.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
}
async function refreshAccessToken(credential: ProviderCredential): Promise<string> {
  const config = providerConfig[credential.provider];
  const clientId = config.clientId();
  const clientSecret = config.clientSecret();
  if (!clientId || !clientSecret) throw new Error('provider_oauth_not_configured');
  const refreshToken = decrypt(credential.refresh_token_ciphertext);
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
  const token = await fetchJson(config.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }) as OAuthTokenResponse;
  const expiresAt = new Date(Date.now() + Math.max(60, token.expires_in || 3600) * 1000);
  await pool.query(
    'UPDATE sp_provider_credentials SET access_token_ciphertext=$1, token_expires_at=$2, updated_at=now(), last_error_code=NULL WHERE id=$3',
    [encrypt(token.access_token), expiresAt, credential.id]
  );
  return token.access_token;
}
async function accessToken(credential: ProviderCredential): Promise<string> {
  if (new Date(credential.token_expires_at).getTime() > Date.now() + 60_000) return decrypt(credential.access_token_ciphertext);
  return refreshAccessToken(credential);
}
async function saveMessage(input: {
  workspaceId: string; channelKey: string; externalAccountId: string; threadId: string; messageId: string;
  senderName: string; senderAddress: string; subject: string; body: string; sentAt: string | null;
}) {
  await inTransaction(async client => {
    const conversation = await client.query<{id:string}>(
      `INSERT INTO sp_conversations (workspace_id, channel_key, external_account_id, external_thread_id, title, participant_display, participant_address, last_message_at, unread_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,now()),1)
       ON CONFLICT (workspace_id, channel_key, external_account_id, external_thread_id)
       DO UPDATE SET title=CASE WHEN sp_conversations.title='' THEN EXCLUDED.title ELSE sp_conversations.title END,
         participant_display=CASE WHEN sp_conversations.participant_display='' THEN EXCLUDED.participant_display ELSE sp_conversations.participant_display END,
         participant_address=CASE WHEN sp_conversations.participant_address='' THEN EXCLUDED.participant_address ELSE sp_conversations.participant_address END,
         last_message_at=GREATEST(COALESCE(sp_conversations.last_message_at,EXCLUDED.last_message_at),EXCLUDED.last_message_at), updated_at=now()
       RETURNING id`,
      [input.workspaceId, input.channelKey, input.externalAccountId, input.threadId, input.subject || '(no subject)', input.senderName, input.senderAddress, input.sentAt]
    );
    await client.query(
      `INSERT INTO sp_channel_messages (workspace_id, conversation_id, channel_key, provider_message_id, direction, sender_name, sender_address, subject, body_text, provider_created_at, delivery_status, metadata)
       VALUES ($1,$2,$3,$4,'inbound',$5,$6,$7,$8,$9::timestamptz,'received','{}'::jsonb)
       ON CONFLICT (workspace_id, channel_key, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING`,
      [input.workspaceId, conversation.rows[0]!.id, input.channelKey, input.messageId, input.senderName, input.senderAddress, input.subject, input.body.slice(0, 20000), input.sentAt]
    );
  });
}
async function syncGoogle(credential: ProviderCredential, token: string): Promise<number> {
  const list = await fetchJson('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&labelIds=INBOX', { headers: { authorization: `Bearer ${token}` } });
  let imported = 0;
  for (const item of (list.messages || []).slice(0, 50)) {
    try {
      const message = await fetchJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`, { headers: { authorization: `Bearer ${token}` } });
      const headers = message.payload?.headers || [];
      const from = headerValue(headers, 'from');
      const match = from.match(/^(.*?)\s*<([^>]+)>$/);
      await saveMessage({
        workspaceId: credential.workspace_id, channelKey: credential.channel_key,
        externalAccountId: credential.external_account_id, threadId: String(message.threadId || message.id),
        messageId: String(message.id), senderName: (match?.[1] || from).replace(/^"|"$/g, '').slice(0, 200),
        senderAddress: match?.[2] || from, subject: headerValue(headers, 'subject'),
        body: gmailBody(message.payload || {}), sentAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null
      });
      imported++;
    } catch { /* Keep sync moving; provider IDs make retries idempotent. */ }
  }
  return imported;
}
async function syncMicrosoft(credential: ProviderCredential, token: string): Promise<number> {
  const url = credential.sync_cursor || 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime%20desc&$select=id,conversationId,subject,from,receivedDateTime,body';
  const data = await fetchJson(url, { headers: { authorization: `Bearer ${token}`, prefer: 'outlook.body-content-type="text"' } });
  let imported = 0;
  for (const message of (data.value || []).slice(0, 50)) {
    const sender = message.from?.emailAddress || {};
    await saveMessage({
      workspaceId: credential.workspace_id, channelKey: credential.channel_key,
      externalAccountId: credential.external_account_id, threadId: String(message.conversationId || message.id),
      messageId: String(message.id), senderName: String(sender.name || sender.address || '').slice(0, 200),
      senderAddress: String(sender.address || ''), subject: String(message.subject || ''),
      body: stripHtml(String(message.body?.content || '')),
      sentAt: message.receivedDateTime ? new Date(message.receivedDateTime).toISOString() : null
    });
    imported++;
  }
  // Do not persist a provider-supplied nextLink as a durable delta cursor; the next run intentionally re-reads
  // recent inbox messages and relies on the provider message unique index for safe de-duplication.
  return imported;
}

export async function registerEmailOAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/integrations/email/:provider/connect', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
    if (!member) return;
    const provider = providerFrom((request.params as {provider?: string}).provider);
    if (!provider) return fail(reply, 400, 'Choose Google or Microsoft.', 'unsupported_oauth_provider');
    const config = providerConfig[provider];
    if (!config.clientId() || !config.clientSecret() || !env.integrationTokenEncryptionKey || !env.publicApiUrl) {
      return fail(reply, 503, 'This email provider is not configured by the StayPilot operator yet.', 'provider_not_configured');
    }
    try {
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const stateHash = createHash('sha256').update(state).digest('hex');
      await pool.query(
        `INSERT INTO sp_oauth_states (state_hash, workspace_id, provider, channel_key, initiated_by_user_id, code_verifier_ciphertext)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [stateHash, member.workspace_id, provider, config.channelKey, member.user_id, encrypt(verifier)]
      );
      const url = new URL(config.authUrl);
      url.searchParams.set('client_id', config.clientId()!);
      url.searchParams.set('redirect_uri', redirectUri(provider));
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('response_mode', 'query');
      url.searchParams.set('scope', config.scopes.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      if (provider === 'google') {
        url.searchParams.set('access_type', 'offline');
        url.searchParams.set('prompt', 'consent');
      }
      noStore(reply);
      return reply.send({ authorization_url: url.toString(), provider, expires_in_seconds: 600 });
    } catch {
      return fail(reply, 500, 'Could not start the provider connection.', 'oauth_start_failed');
    }
  });

  app.get('/api/integrations/oauth/:provider/callback', async (request, reply) => {
    const provider = providerFrom((request.params as {provider?: string}).provider);
    const query = request.query as { state?: string; code?: string; error?: string };
    const frontend = env.webOrigins[0];
    if (!provider || !frontend) return fail(reply, 400, 'OAuth callback configuration is invalid.', 'oauth_callback_invalid');
    if (query.error || !query.code || !query.state || query.state.length > 200) {
      return reply.redirect(`${frontend}/settings/integrations?oauth=failed`);
    }
    try {
      const stateHash = createHash('sha256').update(query.state).digest('hex');
      const claimed = await inTransaction(async client => {
        const result = await client.query<any>(
          `SELECT state_hash, workspace_id, provider, channel_key, initiated_by_user_id, code_verifier_ciphertext
           FROM sp_oauth_states WHERE state_hash=$1 AND provider=$2 AND expires_at>now() AND consumed_at IS NULL FOR UPDATE`,
          [stateHash, provider]
        );
        if (!result.rows[0]) return null;
        await client.query('UPDATE sp_oauth_states SET consumed_at=now() WHERE state_hash=$1', [stateHash]);
        return result.rows[0];
      });
      if (!claimed) return reply.redirect(`${frontend}/settings/integrations?oauth=expired`);
      const token = await exchangeCode(provider, query.code, decrypt(claimed.code_verifier_ciphertext)) as OAuthTokenResponse;
      if (!token.access_token || !token.refresh_token) throw new Error('provider_refresh_token_missing');
      const accessTokenValue = token.access_token;
      const refreshTokenValue = token.refresh_token;
      let profile: any;
      if (provider === 'google') {
        profile = await fetchJson('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: `Bearer ${token.access_token}` } });
      } else {
        profile = await fetchJson('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', { headers: { authorization: `Bearer ${token.access_token}` } });
      }
      const email = String(provider === 'google' ? profile.email : (profile.mail || profile.userPrincipalName) || '').trim().toLowerCase();
      const externalId = String(provider === 'google' ? profile.id : profile.id || '');
      if (!email || !externalId) throw new Error('provider_profile_missing');
      const config = providerConfig[provider];
      await inTransaction(async client => {
        await client.query(
          `INSERT INTO sp_provider_credentials
             (workspace_id, provider, channel_key, account_email, external_account_id, access_token_ciphertext, refresh_token_ciphertext, token_expires_at, scopes, connected_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (workspace_id, channel_key) DO UPDATE SET
             provider=EXCLUDED.provider, account_email=EXCLUDED.account_email, external_account_id=EXCLUDED.external_account_id,
             access_token_ciphertext=EXCLUDED.access_token_ciphertext, refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,
             token_expires_at=EXCLUDED.token_expires_at, scopes=EXCLUDED.scopes, connected_by_user_id=EXCLUDED.connected_by_user_id,
             sync_cursor=NULL, last_error_code=NULL, updated_at=now()`,
          [claimed.workspace_id, provider, config.channelKey, email, externalId, encrypt(accessTokenValue), encrypt(refreshTokenValue),
           new Date(Date.now() + Math.max(60, token.expires_in || 3600) * 1000), String(token.scope || '').split(' ').filter(Boolean), claimed.initiated_by_user_id]
        );
        await client.query(
          `UPDATE sp_channel_connections SET status='connected', connection_mode='oauth', account_label=$1, external_account_id=$2, last_error_code=NULL, updated_at=now()
           WHERE workspace_id=$3 AND channel_key=$4`,
          [email, externalId, claimed.workspace_id, config.channelKey]
        );
        await auditEvent(client, { workspaceId: claimed.workspace_id, actor: { user_id: claimed.initiated_by_user_id, email }, action: 'integration.email_connected', entityType: 'channel_connection', entityId: config.channelKey, metadata: { provider, account_email: email } });
      });
      return reply.redirect(`${frontend}/settings/integrations?oauth=connected&provider=${provider}`);
    } catch (error) {
      const code = safeProviderError(error instanceof Error ? error.message : undefined);
      request.log.warn({ event: 'email_oauth_callback_failed', provider, code }, 'Email OAuth callback failed');
      return reply.redirect(`${frontend}/settings/integrations?oauth=failed`);
    }
  });

  app.post('/api/integrations/email/:provider/sync', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin', 'sales']);
    if (!member) return;
    const provider = providerFrom((request.params as {provider?: string}).provider);
    if (!provider) return fail(reply, 400, 'Choose Google or Microsoft.', 'unsupported_oauth_provider');
    const channelKey = providerConfig[provider].channelKey;
    try {
      const result = await pool.query<ProviderCredential>(
        `SELECT id, workspace_id, provider, channel_key, account_email, external_account_id, access_token_ciphertext,
                refresh_token_ciphertext, token_expires_at, scopes, sync_cursor, connected_by_user_id
         FROM sp_provider_credentials WHERE workspace_id=$1 AND channel_key=$2 LIMIT 1`,
        [member.workspace_id, channelKey]
      );
      const credential = result.rows[0];
      if (!credential) return fail(reply, 409, 'Connect this mailbox before syncing.', 'provider_not_connected');
      const token = await accessToken(credential);
      const imported = provider === 'google' ? await syncGoogle(credential, token) : await syncMicrosoft(credential, token);
      await pool.query(
        `UPDATE sp_provider_credentials SET last_synced_at=now(), last_error_code=NULL WHERE id=$1`, [credential.id]
      );
      await pool.query(
        `UPDATE sp_channel_connections SET last_synced_at=now(), last_error_code=NULL, status='connected', updated_at=now()
         WHERE workspace_id=$1 AND channel_key=$2`, [member.workspace_id, channelKey]
      );
      noStore(reply);
      return reply.send({ ok: true, provider, imported, synced_at: new Date().toISOString() });
    } catch (error) {
      const code = safeProviderError(error instanceof Error ? error.message : undefined);
      await pool.query('UPDATE sp_channel_connections SET last_error_code=$1, status=CASE WHEN status=\'connected\' THEN \'error\' ELSE status END, updated_at=now() WHERE workspace_id=$2 AND channel_key=$3',
        [code, member.workspace_id, channelKey]).catch(() => undefined);
      return fail(reply, 502, 'Mailbox sync failed. Reconnect the account if the provider revoked access.', 'provider_sync_failed');
    }
  });

  app.delete('/api/integrations/email/:provider', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
    if (!member) return;
    const provider = providerFrom((request.params as {provider?: string}).provider);
    if (!provider) return fail(reply, 400, 'Choose Google or Microsoft.', 'unsupported_oauth_provider');
    const channelKey = providerConfig[provider].channelKey;
    try {
      await inTransaction(async client => {
        await client.query('DELETE FROM sp_provider_credentials WHERE workspace_id=$1 AND channel_key=$2', [member.workspace_id, channelKey]);
        await client.query(
          `UPDATE sp_channel_connections SET status='not_connected', account_label=NULL, external_account_id=NULL, last_synced_at=NULL, last_error_code=NULL, updated_at=now()
           WHERE workspace_id=$1 AND channel_key=$2`, [member.workspace_id, channelKey]
        );
        await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'integration.email_disconnected', entityType: 'channel_connection', entityId: channelKey, metadata: { provider } });
      });
      noStore(reply);
      return reply.send({ ok: true, disconnected: true });
    } catch {
      return fail(reply, 500, 'Could not disconnect this mailbox.', 'provider_disconnect_failed');
    }
  });
}
