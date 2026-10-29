import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config.js';
import { pool, inTransaction } from '../db.js';
import { requireWorkspaceMember } from '../auth.js';
import type { WorkspaceMember } from '../auth.js';
import { auditEvent } from '../domain.js';
import { encryptOAuthSecret } from '../oauth-crypto.js';
import { fail, noStore } from '../http.js';

type Provider = 'google' | 'microsoft';
type ChannelKey = 'email_gmail' | 'email_outlook';
type JsonRecord = Record<string, any>;
type ProviderConfig = {
  provider: Provider; channelKey: ChannelKey; clientId?: string; clientSecret?: string;
  authorizationEndpoint: string; tokenEndpoint: string; scopes: string[];
};

class OAuthError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 502, message = 'Mailbox authorization failed.') {
    super(message); this.name = 'OAuthError';
  }
}
function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
function asString(value: unknown): string { return typeof value === 'string' ? value : ''; }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function getProvider(value: unknown): Provider | null {
  return value === 'google' || value === 'microsoft' ? value : null;
}
function configFor(provider: Provider): ProviderConfig {
  if (provider === 'google') return {
    provider, channelKey: 'email_gmail', clientId: env.googleOAuthClientId, clientSecret: env.googleOAuthClientSecret,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly']
  };
  return {
    provider, channelKey: 'email_outlook', clientId: env.microsoftOAuthClientId, clientSecret: env.microsoftOAuthClientSecret,
    authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Mail.Read']
  };
}
function requireReady(config: ProviderConfig): ProviderConfig {
  if (!env.apiPublicOrigin || !env.oauthTokenEncryptionKey || !config.clientId || !config.clientSecret) {
    throw new OAuthError('mail_oauth_not_configured', 503,
      'This mailbox connector is not configured yet. Add the provider OAuth credentials, API public origin and token encryption key in Railway.');
  }
  return config;
}
function redirectUri(config: ProviderConfig): string {
  if (!env.apiPublicOrigin) throw new OAuthError('mail_oauth_not_configured', 503);
  return env.apiPublicOrigin + '/api/channels/oauth/' + config.provider + '/callback';
}
function page(reply: FastifyReply, success: boolean, message: string, statusCode = 200) {
  reply.header('Cache-Control', 'no-store, private').header('Pragma', 'no-cache')
    .header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  const title = success ? 'Mailbox connected' : 'Mailbox connection not completed';
  const colour = success ? '#286d4d' : '#9b413c';
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    title + ' · StayPilot</title><style>body{font:15px/1.65 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f5f7fb;color:#24364b;margin:0;padding:36px}.card{max-width:520px;margin:9vh auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px}h1{font-size:22px;color:' +
    colour + '}p{color:#6e7e91}small{color:#8b97a8}</style></head><body><main class="card"><h1>' + title + '</h1><p>' +
    message + '</p><small>StayPilot has read-only mailbox access. It does not send email. Close this window and return to the Action Centre.</small></main></body></html>';
  return reply.code(statusCode).type('text/html; charset=utf-8').send(html);
}
async function providerJson(url: string, init: RequestInit): Promise<JsonRecord> {
  const response = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(15000) });
  const data = asRecord(await response.json().catch(() => ({})));
  if (!response.ok) {
    const raw = asString(data.error);
    const code = raw === 'access_denied' ? 'provider_access_denied' : raw === 'invalid_grant' ? 'reauthorization_required' :
      response.status === 429 ? 'mail_provider_rate_limited' : response.status >= 500 ? 'mail_provider_unavailable' : 'oauth_exchange_failed';
    throw new OAuthError(code, response.status === 429 ? 429 : 502,
      code === 'provider_access_denied' ? 'Access was declined. No mailbox was connected.' : 'The provider authorization request failed (' + code + ').');
  }
  return data;
}
async function accountProfile(provider: Provider, accessToken: string): Promise<{ id: string; label: string }> {
  const url = provider === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo'
    : 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName';
  const profile = await providerJson(url, { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } });
  if (provider === 'google') {
    const id = asString(profile.sub), email = asString(profile.email);
    if (!id || !email || profile.email_verified === false) throw new OAuthError('mail_profile_unverified', 403, 'The provider did not return a verified account email.');
    return { id, label: email.slice(0, 320) };
  }
  const id = asString(profile.id), email = asString(profile.mail) || asString(profile.userPrincipalName);
  if (!id || !email) throw new OAuthError('mail_profile_missing', 502, 'The provider did not return an account identity.');
  return { id, label: email.slice(0, 320) };
}
async function beginOAuth(provider: Provider, member: WorkspaceMember) {
  const config = requireReady(configFor(provider));
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const uri = redirectUri(config);
  await inTransaction(async client => {
    await client.query("DELETE FROM sp_channel_oauth_states WHERE expires_at < now() OR (used_at IS NOT NULL AND created_at < now() - interval '1 day')");
    await client.query(
      'INSERT INTO sp_channel_oauth_states (workspace_id, channel_key, state_hash, code_verifier, redirect_uri, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [member.workspace_id, config.channelKey, sha256(state), verifier, uri, member.user_id]
    );
    await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'mail_oauth.started', entityType: 'channel_connection', metadata: { channel_key: config.channelKey } });
  });
  const authorization = new URL(config.authorizationEndpoint);
  authorization.searchParams.set('client_id', config.clientId!);
  authorization.searchParams.set('response_type', 'code');
  authorization.searchParams.set('redirect_uri', uri);
  authorization.searchParams.set('scope', config.scopes.join(' '));
  authorization.searchParams.set('state', state);
  authorization.searchParams.set('code_challenge', challenge);
  authorization.searchParams.set('code_challenge_method', 'S256');
  if (provider === 'google') {
    authorization.searchParams.set('access_type', 'offline');
    authorization.searchParams.set('prompt', 'consent');
    authorization.searchParams.set('include_granted_scopes', 'true');
  } else {
    authorization.searchParams.set('response_mode', 'query');
    authorization.searchParams.set('prompt', 'select_account');
  }
  return { authorization_url: authorization.toString(), channel_key: config.channelKey, expires_in_seconds: 600 };
}
async function finishOAuth(provider: Provider, stateValue: string, code: string) {
  const config = requireReady(configFor(provider));
  const found = await pool.query<{
    id: string; workspace_id: string; channel_key: ChannelKey; code_verifier: string;
    redirect_uri: string; created_by_user_id: string;
  }>(
    'SELECT id, workspace_id, channel_key, code_verifier, redirect_uri, created_by_user_id FROM sp_channel_oauth_states WHERE state_hash=$1 AND channel_key=$2 AND used_at IS NULL AND expires_at > now() LIMIT 1',
    [sha256(stateValue), config.channelKey]
  );
  const state = found.rows[0];
  if (!state) throw new OAuthError('mail_oauth_state_invalid', 400, 'This authorization link has expired or has already been used. Start the connection again.');
  const body = new URLSearchParams({
    client_id: config.clientId!, client_secret: config.clientSecret!, code, code_verifier: state.code_verifier,
    grant_type: 'authorization_code', redirect_uri: state.redirect_uri
  });
  if (provider === 'microsoft') body.set('scope', config.scopes.join(' '));
  const tokens = await providerJson(config.tokenEndpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body
  });
  const accessToken = asString(tokens.access_token), refreshToken = asString(tokens.refresh_token), expiresIn = Number(tokens.expires_in);
  if (!accessToken || !refreshToken) throw new OAuthError('mail_refresh_token_missing', 502, 'The provider did not issue a refresh token. Reconnect with offline access enabled.');
  if (!Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 86400) throw new OAuthError('mail_token_expiry_invalid', 502);
  const profile = await accountProfile(provider, accessToken);
  await inTransaction(async client => {
    const claimed = await client.query(
      'UPDATE sp_channel_oauth_states SET used_at=now() WHERE id=$1 AND used_at IS NULL AND expires_at > now() RETURNING id',
      [state.id]
    );
    if (!claimed.rows.length) throw new OAuthError('mail_oauth_state_replayed', 409, 'This authorization response has already been used. Start the connection again.');
    await client.query(
      'INSERT INTO sp_channel_oauth_credentials (workspace_id, channel_key, account_label, external_account_id, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, scope, connected_by_user_id, sync_cursor, sync_started_at, last_synced_at, sync_lock_until, updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,NULL,NULL,now()) ' +
      'ON CONFLICT (workspace_id, channel_key) DO UPDATE SET account_label=EXCLUDED.account_label, external_account_id=EXCLUDED.external_account_id, ' +
      'encrypted_access_token=EXCLUDED.encrypted_access_token, encrypted_refresh_token=EXCLUDED.encrypted_refresh_token, access_token_expires_at=EXCLUDED.access_token_expires_at, scope=EXCLUDED.scope, ' +
      'connected_by_user_id=EXCLUDED.connected_by_user_id, sync_cursor=NULL, sync_started_at=NULL, last_synced_at=NULL, sync_lock_until=NULL, updated_at=now()',
      [state.workspace_id, config.channelKey, profile.label, profile.id,
        encryptOAuthSecret(accessToken, env.oauthTokenEncryptionKey),
        encryptOAuthSecret(refreshToken, env.oauthTokenEncryptionKey),
        new Date(Date.now() + expiresIn * 1000), asString(tokens.scope) || config.scopes.join(' '), state.created_by_user_id]
    );
    await client.query(
      "UPDATE sp_channel_connections SET status='connected', connection_mode='oauth', account_label=$1, external_account_id=$2, last_synced_at=NULL, last_error_code=NULL, updated_at=now() WHERE workspace_id=$3 AND channel_key=$4",
      [profile.label, profile.id, state.workspace_id, config.channelKey]
    );
    await auditEvent(client, {
      workspaceId: state.workspace_id, actor: { user_id: state.created_by_user_id, email: profile.label },
      action: 'mail_oauth.connected', entityType: 'channel_connection',
      metadata: { channel_key: config.channelKey, account_label: profile.label }
    });
  });
  return config.channelKey;
}
async function markFailed(workspaceId: string, channelKey: ChannelKey, code: string) {
  await pool.query(
    "UPDATE sp_channel_connections SET status=CASE WHEN status IN ('connected','inbound_active') THEN status ELSE 'error' END, last_error_code=$1, updated_at=now() WHERE workspace_id=$2 AND channel_key=$3",
    [code.slice(0, 80), workspaceId, channelKey]
  ).catch(() => undefined);
}
export async function registerMailOAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/channels/oauth/:provider/start', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
    if (!member) return;
    const provider = getProvider((request.params as { provider?: unknown }).provider);
    if (!provider) return fail(reply, 404, 'Supported mailbox providers are Google and Microsoft.', 'mail_provider_not_supported');
    try {
      const result = await beginOAuth(provider, member);
      noStore(reply);
      return reply.send(result);
    } catch (error) {
      if (error instanceof OAuthError) return fail(reply, error.statusCode, error.message, error.code);
      return fail(reply, 500, 'Could not start mailbox authorization.', 'mail_oauth_start_failed');
    }
  });

  app.get('/api/channels/oauth/:provider/callback', async (request, reply) => {
    const provider = getProvider((request.params as { provider?: unknown }).provider);
    if (!provider) return page(reply, false, 'Unsupported mailbox provider.', 404);
    const query = request.query && typeof request.query === 'object' ? request.query as Record<string, unknown> : {};
    if (query.error) return page(reply, false,
      asString(query.error) === 'access_denied' ? 'Access was declined. No mailbox was connected.' : 'The provider did not authorize this connection. No mailbox was connected.', 400);
    const state = asString(query.state), code = asString(query.code);
    if (!state || !code || state.length > 200 || code.length > 4096) return page(reply, false, 'The provider response was incomplete. Start the connection again.', 400);
    const channelKey = configFor(provider).channelKey;
    const lookup = await pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM sp_channel_oauth_states WHERE state_hash=$1 AND channel_key=$2 AND used_at IS NULL AND expires_at > now() LIMIT 1',
      [sha256(state), channelKey]
    ).catch(() => ({ rows: [] as Array<{ workspace_id: string }> }));
    try {
      const connectedChannel = await finishOAuth(provider, state, code);
      return page(reply, true, connectedChannel === 'email_gmail' ? 'Gmail was connected with read-only mailbox permissions.' : 'Outlook was connected with read-only mailbox permissions.');
    } catch (error) {
      const workspaceId = lookup.rows[0]?.workspace_id;
      if (workspaceId) await markFailed(workspaceId, channelKey, error instanceof OAuthError ? error.code : 'oauth_exchange_failed');
      const message = error instanceof OAuthError ? error.message : 'Mailbox authorization did not complete. Check provider setup and try again.';
      const status = error instanceof OAuthError ? error.statusCode : 502;
      return page(reply, false, message, status);
    }
  });
}
