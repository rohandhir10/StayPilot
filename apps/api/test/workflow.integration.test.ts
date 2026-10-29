import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  getDefaultWorkspaceId: vi.fn(),
  verifyTurnstile: vi.fn()
}));

vi.mock('../src/auth.js', () => ({
  requireWorkspaceMember: mocks.requireWorkspaceMember,
  getDefaultWorkspaceId: mocks.getDefaultWorkspaceId
}));
vi.mock('../src/turnstile.js', () => ({ verifyTurnstile: mocks.verifyTurnstile }));

import { pool } from '../src/db.js';
import { sha256 } from '../src/crypto.js';
import { registerLeadRoutes } from '../src/routes/leads.js';
import { registerImportRoutes } from '../src/routes/import.js';
import { registerInboxRoutes } from '../src/routes/inbox.js';
import { registerPartnerRoutes } from '../src/routes/partner.js';
import { registerPublicInquiryRoutes } from '../src/routes/public-inquiry.js';
import { registerMetaWebhookRoutes } from '../src/routes/webhooks-meta.js';

const app = Fastify();
const fixture = randomUUID().replaceAll('-', '').slice(0, 10);
let workspaceId = '';
let foreignWorkspaceId = '';
let foreignLeadId = '';
let staffLeadId = '';
let publicLeadId = '';
let partnerLeadId = '';
let partnerKeyId = '';
let conversationId = '';
let metaConversationId = '';
let metaProviderMessageId = '';
let metaEventKey = '';
let originalWhatsAppConnection: { external_account_id: string | null; status: string } | null = null;
const leadIds: string[] = [];

const member = {
  workspace_id: '',
  user_id: 'user_flow_test_sales',
  email: 'flow-test-sales@example.test',
  display_name: 'Workflow Integration Test',
  role: 'sales' as const
};

function leadPayload(suffix: string) {
  return {
    client_name: 'Workflow ' + fixture + ' ' + suffix,
    company_name: 'Workflow Company ' + fixture + ' ' + suffix,
    client_email: fixture + '-' + suffix + '@example.test',
    client_phone: '',
    agent_name: 'Workflow Test Agent',
    agent_email: 'agent@example.test',
    property_name: 'Workflow Test Hotel',
    inquiry_type: 'Corporate stay',
    check_in: '2026-12-10',
    check_out: '2026-12-12',
    guests: 4,
    estimated_value: 45000,
    source: 'Travel agent',
    status: 'New inquiry',
    assigned_to: 'Workflow Integration Test',
    notes: 'Automated end-to-end test fixture'
  };
}

function publicPayload(suffix: string) {
  return {
    client_name: 'Public ' + fixture + ' ' + suffix,
    client_email: 'public-' + fixture + '-' + suffix + '@example.test',
    client_phone: '',
    company_name: 'Public company ' + fixture,
    property_name: 'Public Test Hotel',
    inquiry_type: 'Direct website inquiry',
    privacy_consent: true,
    turnstile_token: 'test-captcha-' + fixture,
    form_started_at: Date.now() - 3000,
    website: ''
  };
}

describe('StayPilot API workflow integration (PostgreSQL)', () => {
  beforeAll(async () => {
    const ws = await pool.query("SELECT id FROM workspaces WHERE slug='default' LIMIT 1");
    if (!ws.rows[0]) throw new Error('Default workspace is missing. CI migrations must run first.');
    workspaceId = ws.rows[0].id;
    member.workspace_id = workspaceId;
    mocks.requireWorkspaceMember.mockImplementation(async () => member);
    mocks.getDefaultWorkspaceId.mockResolvedValue(workspaceId);
    mocks.verifyTurnstile.mockResolvedValue(true);

    const foreign = await pool.query(
      'INSERT INTO workspaces (slug,name) VALUES ($1,$2) RETURNING id',
      ['workflow-test-' + fixture, 'Workflow Test ' + fixture]
    );
    foreignWorkspaceId = foreign.rows[0].id;
    const foreignLead = await pool.query(
      "INSERT INTO leads (workspace_id,client_name,property_name,inquiry_type) VALUES ($1,$2,'Foreign Test Hotel','Test') RETURNING id",
      [foreignWorkspaceId, 'Foreign ' + fixture]
    );
    foreignLeadId = foreignLead.rows[0].id;

    await app.register(rawBody, { field: 'rawBody', global: false, encoding: false, runFirst: true, routes: ['/api/webhooks/meta'] });
    await registerLeadRoutes(app);
    await registerImportRoutes(app);
    await registerInboxRoutes(app);
    await registerPartnerRoutes(app);
    await registerPublicInquiryRoutes(app);
    await registerMetaWebhookRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (originalWhatsAppConnection) {
      await pool.query(
        'UPDATE sp_channel_connections SET external_account_id=$3,status=$4,updated_at=now() WHERE workspace_id=$1 AND channel_key=$2',
        [workspaceId, 'whatsapp', originalWhatsAppConnection.external_account_id, originalWhatsAppConnection.status]
      );
    }
    if (partnerKeyId) {
      await pool.query('DELETE FROM sp_partner_requests WHERE api_key_id=$1', [partnerKeyId]);
      await pool.query('DELETE FROM sp_partner_api_keys WHERE id=$1', [partnerKeyId]);
    }
    if (conversationId) await pool.query('DELETE FROM sp_conversations WHERE id=$1', [conversationId]);
    if (metaConversationId) await pool.query('DELETE FROM sp_conversations WHERE id=$1', [metaConversationId]);
    if (metaProviderMessageId) await pool.query('DELETE FROM sp_channel_messages WHERE provider_message_id=$1', [metaProviderMessageId]);
    if (metaEventKey) await pool.query("DELETE FROM sp_webhook_events WHERE provider='meta' AND event_key=$1", [metaEventKey]);
    if (leadIds.length) {
      await pool.query('DELETE FROM sp_audit_events WHERE entity_id::text = ANY($1::text[])', [leadIds]);
      await pool.query('DELETE FROM leads WHERE id=ANY($1::uuid[])', [leadIds]);
    }
    if (foreignLeadId) await pool.query('DELETE FROM leads WHERE id=$1', [foreignLeadId]);
    if (foreignWorkspaceId) await pool.query('DELETE FROM workspaces WHERE id=$1', [foreignWorkspaceId]);
  });

  it('creates, updates and reads an inquiry activity trail', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/leads/create', payload: leadPayload('staff') });
    expect(response.statusCode).toBe(201);
    staffLeadId = response.json().lead.id;
    leadIds.push(staffLeadId);
    expect(response.json().lead.source).toBe('Travel agent');
    expect(response.json().lead.status).toBe('New inquiry');

    const update = await app.inject({
      method: 'POST', url: '/api/leads/update',
      payload: { id: staffLeadId, status: 'Contacted', notes: 'First follow-up completed' }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().lead.status).toBe('Contacted');

    const activities = await app.inject({ method: 'GET', url: '/api/leads/activities?id=' + staffLeadId });
    expect(activities.statusCode).toBe(200);
    expect(activities.json().activities.some((item: { activity_type: string }) => item.activity_type === 'updated')).toBe(true);
  });

  it('previews and commits a spreadsheet batch with durable idempotency and duplicate confirmation', async () => {
    const rows = [leadPayload('import-a'), leadPayload('import-b')].map((value, index) => ({
      ...value,
      client_name: value.client_name + '-' + index,
      client_email: 'import-' + fixture + '-' + index + '@example.test'
    }));
    const preview = await app.inject({ method: 'POST', url: '/api/leads/import', payload: { mode: 'preview', rows } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().row_count).toBe(2);
    expect(preview.json().duplicate_count).toBe(0);

    const commitHeaders = { 'idempotency-key': 'workflow-' + fixture + '-import-batch-001' };
    const commit = await app.inject({ method: 'POST', url: '/api/leads/import', headers: commitHeaders, payload: { mode: 'commit', rows } });
    expect(commit.statusCode).toBe(201);
    expect(commit.json().created).toBe(2);
    const committedIds = commit.json().leads.map((row: { id: string }) => row.id);
    leadIds.push(...committedIds);

    // Simulate the client losing the 201 response and retrying the exact same request.
    const replay = await app.inject({ method: 'POST', url: '/api/leads/import', headers: commitHeaders, payload: { mode: 'commit', rows } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().duplicate_request).toBe(true);
    expect(replay.json().created).toBe(0);
    expect(replay.json().leads.map((row: { id: string }) => row.id)).toEqual(committedIds);

    const changedPayload = rows.map((row, index) => index === 0 ? { ...row, client_name: 'Changed import payload ' + fixture } : row);
    const conflict = await app.inject({ method: 'POST', url: '/api/leads/import', headers: commitHeaders, payload: { mode: 'commit', rows: changedPayload } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('idempotency_conflict');

    const savedCount = await pool.query('SELECT count(*)::int AS count FROM leads WHERE workspace_id=$1 AND client_email=ANY($2::text[])', [workspaceId, rows.map(row => row.client_email)]);
    expect(savedCount.rows[0].count).toBe(2);

    const duplicateRows = [rows[0]];
    const duplicatePreview = await app.inject({ method: 'POST', url: '/api/leads/import', payload: { mode: 'preview', rows: duplicateRows } });
    expect(duplicatePreview.statusCode).toBe(200);
    expect(duplicatePreview.json().duplicate_count).toBeGreaterThan(0);
    const confirmationHeaders = { 'idempotency-key': 'workflow-' + fixture + '-import-confirm-001' };
    const blockedCommit = await app.inject({ method: 'POST', url: '/api/leads/import', headers: confirmationHeaders, payload: { mode: 'commit', rows: duplicateRows } });
    expect(blockedCommit.statusCode).toBe(409);
    expect(blockedCommit.json().code).toBe('duplicate_confirmation_required');

    const confirmed = await app.inject({
      method: 'POST', url: '/api/leads/import', headers: confirmationHeaders,
      payload: { mode: 'commit', rows: duplicateRows, confirm_duplicates: true }
    });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().created).toBe(1);
    const confirmedId = confirmed.json().leads[0].id as string;
    leadIds.push(confirmedId);

    // Confirmation retry must use the same key and must not create a second row.
    const confirmedReplay = await app.inject({
      method: 'POST', url: '/api/leads/import', headers: confirmationHeaders,
      payload: { mode: 'commit', rows: duplicateRows, confirm_duplicates: true }
    });
    expect(confirmedReplay.statusCode).toBe(200);
    expect(confirmedReplay.json().duplicate_request).toBe(true);
    expect(confirmedReplay.json().leads.map((row: { id: string }) => row.id)).toEqual([confirmedId]);

    const missingHeader = await app.inject({ method: 'POST', url: '/api/leads/import', payload: { mode: 'commit', rows: [leadPayload('missing-key')] } });
    expect(missingHeader.statusCode).toBe(400);
    expect(missingHeader.json().code).toBe('idempotency_key_required');
  });

  it('requires consent and CAPTCHA, never lets public callers set internal workflow fields', async () => {
    const honeypot = await app.inject({
      method: 'POST', url: '/api/public/inquiry',
      payload: { ...publicPayload('honeypot'), website: 'spam-filled' }
    });
    expect(honeypot.statusCode).toBe(202);

    const noConsent = await app.inject({
      method: 'POST', url: '/api/public/inquiry',
      payload: { ...publicPayload('no-consent'), privacy_consent: false }
    });
    expect(noConsent.statusCode).toBe(400);
    expect(noConsent.json().code).toBe('consent_required');

    const created = await app.inject({
      method: 'POST', url: '/api/public/inquiry',
      payload: publicPayload('valid')
    });
    expect(created.statusCode).toBe(201);
    expect(mocks.verifyTurnstile).toHaveBeenCalled();
    const stored = await pool.query(
      'SELECT id,source,status,assigned_to,estimated_value,next_follow_up FROM leads WHERE workspace_id=$1 AND client_email=$2',
      [workspaceId, 'public-' + fixture + '-valid@example.test']
    );
    expect(stored.rows).toHaveLength(1);
    publicLeadId = stored.rows[0].id;
    leadIds.push(publicLeadId);
    expect(stored.rows[0]).toMatchObject({
      source: 'Website', status: 'New inquiry', assigned_to: 'Unassigned', estimated_value: '0.00', next_follow_up: null
    });

    const forged = await app.inject({
      method: 'POST', url: '/api/public/inquiry',
      payload: { ...publicPayload('forged'), status: 'Confirmed', assigned_to: 'CEO', estimated_value: 999999 }
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().code).toBe('invalid_inquiry');
  });

  it('enforces partner API idempotency and rejects reuse with a changed payload', async () => {
    const secret = 'sp_live_' + 'a'.repeat(64);
    const key = await pool.query(
      "INSERT INTO sp_partner_api_keys (workspace_id,name,key_prefix,key_hash,scopes,is_active,created_by_user_id) VALUES ($1,$2,$3,$4,'[\"inquiries:create\"]'::jsonb,true,$5) RETURNING id",
      [workspaceId, 'Workflow Test ' + fixture, secret.slice(0,16), sha256(secret), member.user_id]
    );
    partnerKeyId = key.rows[0].id;
    const { estimated_value: _value, source: _source, status: _status, assigned_to: _assignedTo, next_follow_up: _nextFollowUp, ...payload } = leadPayload('partner');
    const headers = { authorization: 'Bearer ' + secret, 'idempotency-key': 'workflow-' + fixture + '-partner-001' };

    const first = await app.inject({ method: 'POST', url: '/api/partner/inquiries', headers, payload });
    expect(first.statusCode).toBe(201);
    partnerLeadId = first.json().lead_id;
    leadIds.push(partnerLeadId);
    expect(first.json().status).toBe('New inquiry');
    const stored = await pool.query('SELECT source,status,assigned_to,estimated_value,next_follow_up FROM leads WHERE id=$1', [partnerLeadId]);
    expect(stored.rows[0]).toMatchObject({ source: 'Partner API', status: 'New inquiry', assigned_to: 'Unassigned', estimated_value: '0.00', next_follow_up: null });

    for (const [field, value] of Object.entries({
      status: 'Confirmed',
      source: 'Other',
      assigned_to: 'CEO',
      estimated_value: 999999,
      next_follow_up: '2026-12-01T10:00:00.000Z'
    })) {
      const forged = await app.inject({
        method: 'POST', url: '/api/partner/inquiries',
        headers: { ...headers, 'idempotency-key': `workflow-${fixture}-forged-${field}` },
        payload: { ...payload, [field]: value }
      });
      expect(forged.statusCode, `partner field ${field}`).toBe(400);
      expect(forged.json().code).toBe('invalid_inquiry');
    }

    const retry = await app.inject({ method: 'POST', url: '/api/partner/inquiries', headers, payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().duplicate_request).toBe(true);
    expect(retry.json().lead_id).toBe(partnerLeadId);

    const conflict = await app.inject({
      method: 'POST', url: '/api/partner/inquiries', headers,
      payload: { ...payload, client_name: 'Changed ' + fixture }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('idempotency_conflict');
  });

  it('enforces same-workspace inbox linking and stores internal notes without sending', async () => {
    const created = await pool.query(
      "INSERT INTO sp_conversations (workspace_id,channel_key,external_thread_id,title) VALUES ($1,'other',$2,'Workflow conversation') RETURNING id",
      [workspaceId, 'workflow-' + fixture + '-inbox']
    );
    conversationId = created.rows[0].id;
    const linked = await app.inject({
      method: 'POST', url: '/api/inbox/link',
      payload: { conversation_id: conversationId, lead_id: staffLeadId }
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().linked_lead_id).toBe(staffLeadId);

    const crossWorkspace = await app.inject({
      method: 'POST', url: '/api/inbox/link',
      payload: { conversation_id: conversationId, lead_id: foreignLeadId }
    });
    expect(crossWorkspace.statusCode).toBe(404);
    expect(crossWorkspace.json().code).toBe('lead_not_found');

    const note = await app.inject({
      method: 'POST', url: '/api/inbox/messages',
      payload: { conversation_id: conversationId, body_text: 'Internal handover; do not send externally' }
    });
    expect(note.statusCode).toBe(201);
    expect(note.json().message.direction).toBe('note');
    const messages = await app.inject({ method: 'GET', url: '/api/inbox/messages?conversation_id=' + conversationId });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().messages.some((item: { body_text: string; direction: string }) =>
      item.body_text === 'Internal handover; do not send externally' && item.direction === 'note'
    )).toBe(true);

    const statusChanged = await app.inject({
      method: 'PATCH', url: `/api/inbox/conversations/${conversationId}/status`,
      payload: { status: 'pending' }
    });
    expect(statusChanged.statusCode).toBe(200);
    expect(statusChanged.json()).toMatchObject({ ok: true, conversation_id: conversationId, status: 'pending', changed: true });
    const filtered = await app.inject({
      method: 'GET', url: '/api/inbox/conversations?status=pending'
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().conversations.some((item: { id: string }) => item.id === conversationId)).toBe(true);

    const noChange = await app.inject({
      method: 'PATCH', url: `/api/inbox/conversations/${conversationId}/status`,
      payload: { status: 'pending' }
    });
    expect(noChange.statusCode).toBe(200);
    expect(noChange.json().changed).toBe(false);

    const invalidStatus = await app.inject({
      method: 'PATCH', url: `/api/inbox/conversations/${conversationId}/status`,
      payload: { status: 'sent' }
    });
    expect(invalidStatus.statusCode).toBe(400);
    expect(invalidStatus.json().code).toBe('invalid_conversation_status');

    const closed = await app.inject({
      method: 'PATCH', url: `/api/inbox/conversations/${conversationId}/status`,
      payload: { status: 'closed' }
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe('closed');
  });

  it('verifies Meta webhook handshake, rejects invalid signatures and deduplicates retries', async () => {
    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN!;
    const appSecret = process.env.META_APP_SECRET!;
    const challenge = await app.inject({
      method: 'GET',
      url: '/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=' + encodeURIComponent(verifyToken) + '&hub.challenge=staypilot-test-challenge'
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.body).toBe('staypilot-test-challenge');

    const badChallenge = await app.inject({
      method: 'GET',
      url: '/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc'
    });
    expect(badChallenge.statusCode).toBe(403);

    const accountId = 'phone-' + fixture;
    const from = '9190' + fixture;
    metaProviderMessageId = 'wamid.test-' + fixture;
    metaEventKey = 'messages:' + sha256('whatsapp:' + metaProviderMessageId);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'test-account-' + fixture,
        changes: [{
          value: {
            metadata: { phone_number_id: accountId, display_phone_number: '+91 90000 11111' },
            contacts: [{ wa_id: from, profile: { name: 'Webhook Test Guest' } }],
            messages: [{ id: metaProviderMessageId, from, timestamp: '1793300000', type: 'text', text: { body: 'Inbound webhook ' + fixture } }]
          }
        }]
      }]
    };
    const raw = JSON.stringify(payload);
    const signature = 'sha256=' + createHmac('sha256', appSecret).update(Buffer.from(raw)).digest('hex');

    const rejected = await app.inject({
      method: 'POST', url: '/api/webhooks/meta',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
      payload: raw
    });
    expect(rejected.statusCode).toBe(401);

    const unconfigured = await app.inject({
      method: 'POST', url: '/api/webhooks/meta',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      payload: raw
    });
    expect(unconfigured.statusCode).toBe(503);
    expect(unconfigured.json().code).toBe('webhook_account_unconfigured');
    const notClaimed = await pool.query(
      "SELECT id FROM sp_webhook_events WHERE provider='meta' AND event_key=$1",
      [metaEventKey]
    );
    expect(notClaimed.rows).toHaveLength(0);

    const priorConnection = await pool.query<{ external_account_id: string | null; status: string }>(
      "SELECT external_account_id,status FROM sp_channel_connections WHERE workspace_id=$1 AND channel_key='whatsapp'",
      [workspaceId]
    );
    if (!priorConnection.rows[0]) throw new Error('Default WhatsApp channel connection is missing.');
    originalWhatsAppConnection = priorConnection.rows[0];
    await pool.query(
      "UPDATE sp_channel_connections SET external_account_id=$2,status='pending',updated_at=now() WHERE workspace_id=$1 AND channel_key='whatsapp'",
      [workspaceId, accountId]
    );

    const first = await app.inject({
      method: 'POST', url: '/api/webhooks/meta',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      payload: raw
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ received: true, imported: 1, duplicate_event: false });

    const retry = await app.inject({
      method: 'POST', url: '/api/webhooks/meta',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      payload: raw
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ received: true, imported: 0, duplicate_event: true });

    const stored = await pool.query('SELECT id,body_text FROM sp_channel_messages WHERE provider_message_id=$1', [metaProviderMessageId]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].body_text).toBe('Inbound webhook ' + fixture);

    const conversation = await pool.query(
      'SELECT id FROM sp_conversations WHERE external_account_id=$1 AND external_thread_id=$2',
      [accountId, accountId + ':' + from]
    );
    expect(conversation.rows).toHaveLength(1);
    metaConversationId = conversation.rows[0].id;
  });
});
