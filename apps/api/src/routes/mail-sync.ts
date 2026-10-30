import { type FastifyInstance } from 'fastify';
import { pool, inTransaction } from '../db.js';
import { requireWorkspaceMember, type WorkspaceMember } from '../auth.js';
import { auditEvent, upsertExternalMessageWithClient } from '../domain.js';
import { env } from '../config.js';
import { decryptOAuthSecret, encryptOAuthSecret } from '../oauth-crypto.js';
import { fail, noStore } from '../http.js';

type ChannelKey = 'email_gmail' | 'email_outlook';
type Provider = 'google' | 'microsoft';
type JsonRecord = Record<string, any>;
type MailCredential = {
  workspace_id: string;
  channel_key: ChannelKey;
  account_label: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  access_token_expires_at: string | Date;
  sync_cursor: string | null;
  sync_started_at: string | Date | null;
  last_synced_at: string | Date | null;
  sync_lock_until: string | Date | null;
};
type NormalizedMessage = {
  externalThreadId: string; providerMessageId: string; title: string;
  participantDisplay: string; participantAddress: string; senderName: string;
  senderAddress: string; recipientAddress: string; subject: string;
  bodyText: string; providerCreatedAt: string | null; metadata: Record<string, unknown>;
};

export class MailSyncError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 502, message = 'Mailbox sync failed.') {
    super(message); this.name = 'MailSyncError';
  }
}
function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
function asString(value: unknown): string { return typeof value === 'string' ? value : ''; }
function validDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function providerFor(channelKey: ChannelKey): Provider {
  return channelKey === 'email_gmail' ? 'google' : 'microsoft';
}
function providerConfig(provider: Provider) {
  return provider === 'google'
    ? { clientId: env.googleOAuthClientId, clientSecret: env.googleOAuthClientSecret, tokenEndpoint: 'https://oauth2.googleapis.com/token', scopes: ['openid','email','profile','https://www.googleapis.com/auth/gmail.readonly'] }
    : { clientId: env.microsoftOAuthClientId, clientSecret: env.microsoftOAuthClientSecret, tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scopes: ['openid','profile','email','offline_access','User.Read','Mail.Read'] };
}
async function readJsonResponse(response: Response): Promise<JsonRecord> {
  const payload = asRecord(await response.json().catch(() => ({})));
  if (!response.ok) {
    const providerError = asString(payload.error);
    const code = providerError === 'invalid_grant' ? 'reauthorization_required' :
      response.status === 429 ? 'mail_provider_rate_limited' :
      response.status === 401 || response.status === 403 ? 'mail_provider_permission_denied' :
      response.status >= 500 ? 'mail_provider_unavailable' : 'mail_provider_request_failed';
    throw new MailSyncError(code, response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? 409 : 502,
      'The mailbox provider request failed (' + code + ').');
  }
  return payload;
}
async function accessTokenFor(credential: MailCredential, provider: Provider): Promise<string> {
  const config = providerConfig(provider);
  const expiry = validDate(credential.access_token_expires_at);
  if (expiry && expiry.getTime() > Date.now() + 120000) return decryptOAuthSecret(credential.encrypted_access_token, env.oauthTokenEncryptionKey);
  if (!env.oauthTokenEncryptionKey || !config.clientId || !config.clientSecret) throw new MailSyncError('mail_oauth_not_configured', 503);
  const refreshToken = decryptOAuthSecret(credential.encrypted_refresh_token, env.oauthTokenEncryptionKey);
  const body = new URLSearchParams({
    client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken
  });
  if (provider === 'microsoft') body.set('scope', config.scopes.join(' '));
  const token = await readJsonResponse(await fetch(config.tokenEndpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body, signal: AbortSignal.timeout(15000)
  }));
  const access = asString(token.access_token), expiresIn = Number(token.expires_in);
  if (!access || !Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 86400) throw new MailSyncError('mail_token_refresh_invalid', 502);
  const updatedRefresh = asString(token.refresh_token) || refreshToken;
  await pool.query(
    'UPDATE sp_channel_oauth_credentials SET encrypted_access_token=$1, encrypted_refresh_token=$2, access_token_expires_at=$3, updated_at=now() WHERE workspace_id=$4 AND channel_key=$5',
    [encryptOAuthSecret(access, env.oauthTokenEncryptionKey), encryptOAuthSecret(updatedRefresh, env.oauthTokenEncryptionKey),
      new Date(Date.now() + expiresIn * 1000), credential.workspace_id, credential.channel_key]
  );
  return access;
}
function startAt(credential: MailCredential): Date {
  const prior = validDate(credential.last_synced_at);
  return new Date((prior ? prior.getTime() : Date.now()) - (prior ? 60000 : 30 * 86400000));
}
async function ensureStartAt(credential: MailCredential): Promise<Date> {
  const prior = validDate(credential.sync_started_at);
  if (prior) return prior;
  const value = startAt(credential);
  await pool.query(
    'UPDATE sp_channel_oauth_credentials SET sync_started_at=$1, sync_cursor=NULL, updated_at=now() WHERE workspace_id=$2 AND channel_key=$3 AND sync_lock_until > now()',
    [value, credential.workspace_id, credential.channel_key]
  );
  return value;
}
function parseAddress(value: string) {
  const match = value.trim().match(/^(.*?)\s*<([^<>]+)>$/);
  if (match) return { name: (match[1] ?? '').trim().replace(/^["']|["']$/g, '').slice(0,160), address: (match[2] ?? '').trim().slice(0,320) };
  return { name: '', address: value.trim().slice(0,320) };
}
function htmlToText(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, number: string) => {
      const code = Number(number);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\s{2,}/g, ' ').trim().slice(0,20000);
}
function headerValue(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) return '';
  const item = headers.find(value => asString(asRecord(value).name).toLowerCase() === name.toLowerCase());
  return asString(asRecord(item).value).slice(0,2000);
}
function decodeBase64Url(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100000) return '';
  return Buffer.from(value, 'base64url').toString('utf8').slice(0,20000);
}
function gmailBody(payloadValue: unknown): string {
  const root = asRecord(payloadValue), parts: JsonRecord[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 12) return;
    const part = asRecord(value);
    if (!Object.keys(part).length) return;
    parts.push(part);
    if (Array.isArray(part.parts)) for (const child of part.parts) visit(child, depth + 1);
  };
  visit(root);
  const plain = parts.find(part => asString(part.mimeType).toLowerCase() === 'text/plain' && asString(asRecord(part.body).data));
  if (plain) return decodeBase64Url(asRecord(plain.body).data);
  const html = parts.find(part => asString(part.mimeType).toLowerCase() === 'text/html' && asString(asRecord(part.body).data));
  if (html) return htmlToText(decodeBase64Url(asRecord(html.body).data));
  const raw = asString(asRecord(root.body).data);
  return raw ? decodeBase64Url(raw) : '';
}
function normalizeGmail(message: JsonRecord): NormalizedMessage | null {
  const labels = Array.isArray(message.labelIds) ? message.labelIds.map(String) : [];
  const id = asString(message.id), threadId = asString(message.threadId);
  if (!id || !threadId || labels.includes('SENT') || labels.includes('DRAFT')) return null;
  const payload = asRecord(message.payload), headers = Array.isArray(payload.headers) ? payload.headers : [];
  const from = parseAddress(headerValue(headers, 'From'));
  const subject = headerValue(headers, 'Subject').slice(0,500);
  const to = headerValue(headers, 'To');
  const millis = Number(message.internalDate);
  const parsedDate = Number.isFinite(millis) ? new Date(millis) : new Date(headerValue(headers, 'Date'));
  return {
    externalThreadId: threadId.slice(0,500), providerMessageId: id.slice(0,500),
    title: subject || '(No subject)', participantDisplay: from.name || from.address || 'Email sender',
    participantAddress: from.address, senderName: from.name, senderAddress: from.address,
    recipientAddress: to.slice(0,320), subject,
    bodyText: (gmailBody(payload) || asString(message.snippet)).slice(0,20000),
    providerCreatedAt: Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString(),
    metadata: { provider: 'gmail', label_ids: labels.filter(label => ['INBOX','UNREAD','IMPORTANT','STARRED'].includes(label)).slice(0,10) }
  };
}
function normalizeOutlook(message: JsonRecord): NormalizedMessage | null {
  const id = asString(message.id);
  if (!id) return null;
  const from = asRecord(asRecord(message.from).emailAddress);
  const senderName = asString(from.name).slice(0,160), senderAddress = asString(from.address).slice(0,320);
  const recipients = Array.isArray(message.toRecipients) ? message.toRecipients : [];
  const recipientAddress = recipients.map(value => asString(asRecord(asRecord(value).emailAddress).address)).filter(Boolean).slice(0,10).join(', ').slice(0,320);
  const body = asRecord(message.body), rawBody = asString(body.content);
  const received = validDate(asString(message.receivedDateTime));
  return {
    externalThreadId: (asString(message.conversationId) || id).slice(0,500), providerMessageId: id.slice(0,500),
    title: asString(message.subject).slice(0,500) || '(No subject)', participantDisplay: senderName || senderAddress || 'Email sender',
    participantAddress: senderAddress, senderName, senderAddress, recipientAddress,
    subject: asString(message.subject).slice(0,500),
    bodyText: asString(body.contentType).toLowerCase() === 'html' ? htmlToText(rawBody) : rawBody.slice(0,20000),
    providerCreatedAt: received?.toISOString() || null,
    metadata: { provider: 'microsoft_graph', internet_message_id_present: Boolean(asString(message.internetMessageId)) }
  };
}
async function importAndCheckpoint(member: WorkspaceMember, credential: MailCredential, messages: NormalizedMessage[], started: Date, cursor: string | null): Promise<number> {
  return inTransaction(async client => {
    let imported = 0;
    for (const message of messages) {
      const result = await upsertExternalMessageWithClient(client, {
        workspaceId: member.workspace_id, channelKey: credential.channel_key, externalAccountId: credential.account_label,
        externalThreadId: message.externalThreadId, title: message.title,
        participantDisplay: message.participantDisplay, participantAddress: message.participantAddress,
        providerMessageId: message.providerMessageId, senderName: message.senderName,
        senderAddress: message.senderAddress, recipientAddress: message.recipientAddress, subject: message.subject,
        bodyText: message.bodyText.slice(0,20000), providerCreatedAt: message.providerCreatedAt, metadata: message.metadata
      });
      if (result.inserted) imported += 1;
    }
    await client.query(
      'UPDATE sp_channel_oauth_credentials SET sync_cursor=$1, sync_started_at=$2, last_synced_at=CASE WHEN $3 THEN now() ELSE last_synced_at END, sync_lock_until=now() + interval \'5 minutes\', updated_at=now() WHERE workspace_id=$4 AND channel_key=$5',
      [cursor, cursor ? started : null, !cursor, member.workspace_id, credential.channel_key]
    );
    await client.query(
      "UPDATE sp_channel_connections SET status='connected', last_synced_at=CASE WHEN $1 THEN now() ELSE last_synced_at END, last_error_code=NULL, updated_at=now() WHERE workspace_id=$2 AND channel_key=$3",
      [!cursor, member.workspace_id, credential.channel_key]
    );
    return imported;
  });
}
async function fetchGmailPage(accessToken: string, started: Date, cursor: string | null) {
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  url.searchParams.set('labelIds','INBOX');
  url.searchParams.set('q','after:' + Math.floor((started.getTime() - 60000) / 1000));
  url.searchParams.set('maxResults','50');
  if (cursor) url.searchParams.set('pageToken',cursor);
  const listing = await readJsonResponse(await fetch(url,{
    headers:{Authorization:'Bearer '+accessToken,Accept:'application/json'},signal:AbortSignal.timeout(15000)
  }));
  const refs: JsonRecord[] = Array.isArray(listing.messages) ? listing.messages.map(asRecord) : [];
  const normalized: NormalizedMessage[] = [];
  for (let i=0;i<refs.length;i+=5) {
    const detail = await Promise.all(refs.slice(i,i+5).map(async ref=>{
      const id=asString(ref.id);
      if(!id||id.length>500)return null;
      const data=await readJsonResponse(await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(id)+'?format=full',{
        headers:{Authorization:'Bearer '+accessToken,Accept:'application/json'},signal:AbortSignal.timeout(15000)
      }));
      return normalizeGmail(data);
    }));
    normalized.push(...detail.filter((item):item is NormalizedMessage=>Boolean(item)));
  }
  return {messages:normalized,cursor:asString(listing.nextPageToken)||null};
}
async function fetchOutlookPage(accessToken: string, started: Date, cursor: string | null) {
  let url: URL;
  if(cursor) {
    url=new URL(cursor);
    if(url.protocol!=='https:'||url.hostname!=='graph.microsoft.com')throw new MailSyncError('mail_sync_cursor_invalid');
  } else {
    url=new URL('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages');
    url.searchParams.set('$select','id,conversationId,subject,from,toRecipients,body,receivedDateTime,internetMessageId');
    url.searchParams.set('$filter','receivedDateTime ge '+started.toISOString());
    url.searchParams.set('$orderby','receivedDateTime asc');
    url.searchParams.set('$top','50');
  }
  const payload=await readJsonResponse(await fetch(url,{
    headers:{Authorization:'Bearer '+accessToken,Accept:'application/json',Prefer:'IdType="ImmutableId"'},
    signal:AbortSignal.timeout(15000)
  }));
  const messages=(Array.isArray(payload.value)?payload.value:[]).map((item:unknown)=>normalizeOutlook(asRecord(item))).filter((item:NormalizedMessage|null):item is NormalizedMessage=>Boolean(item));
  return {messages,cursor:asString(payload['@odata.nextLink'])||null};
}
async function runSync(member: WorkspaceMember, channelKey: ChannelKey) {
  const provider=providerFor(channelKey), config=providerConfig(provider);
  if(!env.oauthTokenEncryptionKey||!config.clientId||!config.clientSecret)throw new MailSyncError('mail_oauth_not_configured',503,'Mailbox OAuth is not configured in Railway.');
  const lock=await pool.query<MailCredential>(
    'UPDATE sp_channel_oauth_credentials SET sync_lock_until=now() + interval \'5 minutes\', updated_at=now() WHERE workspace_id=$1 AND channel_key=$2 AND (sync_lock_until IS NULL OR sync_lock_until < now()) RETURNING *',
    [member.workspace_id,channelKey]
  );
  const credential=lock.rows[0];
  if(!credential){
    const exists=await pool.query('SELECT id FROM sp_channel_oauth_credentials WHERE workspace_id=$1 AND channel_key=$2 LIMIT 1',[member.workspace_id,channelKey]);
    if(!exists.rows.length)throw new MailSyncError('mail_not_connected',409,'Connect this mailbox before syncing it.');
    throw new MailSyncError('mail_sync_already_running',409,'A sync is already running. Try again shortly.');
  }
  try {
    const accessToken=await accessTokenFor(credential,provider);
    const started=await ensureStartAt(credential);
    let cursor=credential.sync_cursor, imported=0, pages=0, complete=false;
    while(pages<2){
      const page=provider==='google'?await fetchGmailPage(accessToken,started,cursor):await fetchOutlookPage(accessToken,started,cursor);
      imported+=await importAndCheckpoint(member,credential,page.messages,started,page.cursor);
      cursor=page.cursor; pages+=1;
      if(!cursor){complete=true;break;}
    }
    await inTransaction(async client=>{
      await auditEvent(client,{workspaceId:member.workspace_id,actor:member,action:'mailbox.synced',entityType:'channel_connection',metadata:{channel_key:channelKey,imported_count:imported,pages_processed:pages,complete}});
    });
    return {channel_key:channelKey,imported_count:imported,pages_processed:pages,complete,more_pages_available:!complete,message:complete?'Mailbox sync completed. Imported messages were deduplicated against existing records.':'More messages remain in this sync window. Run sync again to continue.'};
  } catch(error) {
    if(error instanceof MailSyncError){
      const authorizationFailure=['reauthorization_required','mail_provider_permission_denied'].includes(error.code);
      await pool.query(
        'UPDATE sp_channel_connections SET status=CASE WHEN $1 THEN \'error\' ELSE status END,last_error_code=$2,updated_at=now() WHERE workspace_id=$3 AND channel_key=$4',
        [authorizationFailure,error.code,member.workspace_id,channelKey]
      ).catch(()=>undefined);
      throw error;
    }
    throw new MailSyncError('mail_sync_failed',502,'Mailbox sync failed. No external message was sent.');
  } finally {
    await pool.query(
      'UPDATE sp_channel_oauth_credentials SET sync_lock_until=NULL,updated_at=now() WHERE workspace_id=$1 AND channel_key=$2',
      [member.workspace_id,channelKey]
    ).catch(()=>undefined);
  }
}
export async function syncMailboxForWorkspace(member: WorkspaceMember, channelKey: ChannelKey) {
  return runSync(member,channelKey);
}
export async function registerMailSyncRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/channels/mail/sync',async(request,reply)=>{
    const member=await requireWorkspaceMember(request,reply,['owner','admin','sales']);
    if(!member)return;
    const body=asRecord(request.body), channelKey=body.channel_key;
    if(channelKey!=='email_gmail'&&channelKey!=='email_outlook')return fail(reply,400,'Choose Gmail or Outlook for mailbox sync.','invalid_mail_channel');
    try {
      const result=await syncMailboxForWorkspace(member,channelKey);
      noStore(reply); return reply.send(result);
    } catch(error) {
      const connector=error instanceof MailSyncError?error:new MailSyncError('mail_sync_failed',502);
      return fail(reply,connector.statusCode,connector.message,connector.code);
    }
  });
}
