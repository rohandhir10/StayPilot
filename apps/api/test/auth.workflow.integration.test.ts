import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUserFromRequest: vi.fn()
}));
vi.mock('@clerk/fastify', () => ({
  getAuth: (request: { headers: Record<string, unknown> }) => {
    const userId = request.headers['x-test-clerk-user'];
    return typeof userId === 'string' && userId.length
      ? { isAuthenticated: true, userId }
      : { isAuthenticated: false, userId: null };
  },
  clerkClient: { users: { getUser: mocks.getUserFromRequest } }
}));

import { pool } from '../src/db.js';
import { registerWorkspaceRoutes } from '../src/routes/workspace.js';
import { registerLeadRoutes } from '../src/routes/leads.js';
import { registerIntegrationRoutes } from '../src/routes/integrations.js';
import { registerChannelRoutes } from '../src/routes/channels.js';
import { registerPartnerRoutes } from '../src/routes/partner.js';

const app = Fastify();
const fixture = randomUUID().replaceAll('-', '').slice(0, 12);
let workspaceId = '';
let channelTestWorkspaceId = '';
let channelTestUserId = '';
let channelTestConnectionId = '';
const users: Record<string, { id: string; email: string; role: string; active: boolean }> = {};
let lifecycleKeyId = '';
let lifecycleSecret = '';
let lifecycleLeadId = '';
const inviteEmails = [`auth-${fixture}-viewer-invite@example.test`, `auth-${fixture}-admin-invite@example.test`, `auth-${fixture}-owner-invite@example.test`];

async function asUser(userId: string | null, input: { method: 'GET' | 'POST' | 'DELETE'; url: string; payload?: unknown }) {
  return app.inject({
    ...input,
    headers: userId ? { 'x-test-clerk-user': userId } : {},
    ...(input.payload === undefined ? {} : { payload: input.payload })
  });
}

describe('real membership and role checks (PostgreSQL integration; Clerk identity extractor stubbed)', () => {
  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>("SELECT id FROM workspaces WHERE slug='default' LIMIT 1");
    if (!ws.rows[0]) throw new Error('Default workspace migration must run first.');
    workspaceId = ws.rows[0].id;
    const definitions = [
      { key: 'owner', role: 'owner', active: true },
      { key: 'admin', role: 'admin', active: true },
      { key: 'sales', role: 'sales', active: true },
      { key: 'viewer', role: 'viewer', active: true },
      { key: 'inactiveSales', role: 'sales', active: false },
      { key: 'inactiveAdmin', role: 'admin', active: false }
    ];
    for (const def of definitions) {
      const id = `user_auth_${fixture}_${def.key}`;
      const email = `auth-${fixture}-${def.key.toLowerCase()}@example.test`;
      users[def.key] = { id, email, role: def.role, active: def.active };
      await pool.query(
        `INSERT INTO workspace_members (workspace_id,user_id,email,display_name,role,is_active)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [workspaceId, id, email, `Auth ${def.key}`, def.role, def.active]
      );
    }
    const channelWorkspace = await pool.query<{ id: string }>(
      'INSERT INTO workspaces (slug,name) VALUES ($1,$2) RETURNING id',
      [`channel-test-${fixture}`, `Channel Setup Test ${fixture}`]
    );
    channelTestWorkspaceId = channelWorkspace.rows[0].id;
    channelTestUserId = `user_channel_test_${fixture}`;
    await pool.query(
      `INSERT INTO workspace_members (workspace_id,user_id,email,display_name,role,is_active)
       VALUES ($1,$2,$3,'Channel Setup Test Owner','owner',true)`,
      [channelTestWorkspaceId, channelTestUserId, `channel-owner-${fixture}@example.test`]
    );
    const channelConnection = await pool.query<{ id: string }>(
      `INSERT INTO sp_channel_connections (workspace_id,channel_key,provider,display_name,connection_mode,status)
       VALUES ($1,'whatsapp','meta','WhatsApp Setup Test','webhook','not_connected') RETURNING id`,
      [channelTestWorkspaceId]
    );
    channelTestConnectionId = channelConnection.rows[0].id;

    await registerWorkspaceRoutes(app);
    await registerLeadRoutes(app);
    await registerIntegrationRoutes(app);
    await registerChannelRoutes(app);
    await registerPartnerRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (channelTestWorkspaceId) await pool.query('DELETE FROM workspaces WHERE id=$1', [channelTestWorkspaceId]);
    if (lifecycleKeyId) {
      await pool.query('DELETE FROM sp_partner_requests WHERE api_key_id=$1', [lifecycleKeyId]);
    }
    if (lifecycleLeadId) {
      await pool.query('DELETE FROM sp_audit_events WHERE workspace_id=$1 AND entity_id::text=$2', [workspaceId, lifecycleLeadId]);
      await pool.query('DELETE FROM leads WHERE workspace_id=$1 AND id=$2', [workspaceId, lifecycleLeadId]);
    }
    if (lifecycleKeyId) await pool.query('DELETE FROM sp_partner_api_keys WHERE id=$1', [lifecycleKeyId]);
    await pool.query('DELETE FROM workspace_invites WHERE workspace_id=$1 AND email=ANY($2::text[])', [workspaceId, inviteEmails]);
    await pool.query('DELETE FROM sp_audit_events WHERE workspace_id=$1 AND actor_user_id=ANY($2::text[])', [workspaceId, Object.values(users).map(user => user.id)]);
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=ANY($2::text[])', [workspaceId, Object.values(users).map(user => user.id)]);
  });

  it('rejects anonymous access and allows an active member to read their session', async () => {
    const anonymous = await asUser(null, { method: 'GET', url: '/api/session' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe('authentication_required');
    const viewer = await asUser(users.viewer.id, { method: 'GET', url: '/api/session' });
    expect(viewer.statusCode).toBe(200);
    expect(viewer.json().workspace.role).toBe('viewer');
  });

  it('enforces viewer, sales, admin and owner role boundaries through the real membership helper', async () => {
    const viewerWrite = await asUser(users.viewer.id, { method: 'POST', url: '/api/leads/create', payload: { client_name: 'Denied', property_name: 'Denied Hotel', inquiry_type: 'Test' } });
    expect(viewerWrite.statusCode).toBe(403);
    expect(viewerWrite.json().code).toBe('insufficient_role');
    const viewerKeys = await asUser(users.viewer.id, { method: 'GET', url: '/api/integrations/keys' });
    expect(viewerKeys.statusCode).toBe(403);
    const salesInvite = await asUser(users.sales.id, { method: 'POST', url: '/api/team/invites', payload: { email: inviteEmails[0], role: 'viewer' } });
    expect(salesInvite.statusCode).toBe(403);
    expect(salesInvite.json().code).toBe('insufficient_role');
    const adminPromote = await asUser(users.admin.id, { method: 'POST', url: '/api/team/invites', payload: { email: inviteEmails[1], role: 'admin' } });
    expect(adminPromote.statusCode).toBe(403);
    expect(adminPromote.json().code).toBe('owner_role_required');
    const ownerPromote = await asUser(users.owner.id, { method: 'POST', url: '/api/team/invites', payload: { email: inviteEmails[2], role: 'admin' } });
    expect(ownerPromote.statusCode).toBe(201);
    expect(ownerPromote.json().invite.role).toBe('admin');
    expect(ownerPromote.json().delivery).toBe('not_sent');
  });

  it('lets an owner configure a Meta account mapping and records setup as pending', async () => {
    // Exercise this route against an isolated workspace so it cannot interfere with webhook fixtures.
    const originalWorkspaceId = workspaceId;
    workspaceId = channelTestWorkspaceId;
    try {
      const configured = await asUser(channelTestUserId, {
        method: 'PUT', url: '/api/channels/whatsapp/meta-account',
        payload: { external_account_id: `phone-${fixture}`, account_label: `Test Phone ${fixture}` }
      });
      expect(configured.statusCode).toBe(200);
      expect(configured.json().connection).toMatchObject({
        channel_key: 'whatsapp', provider: 'meta', status: 'pending',
        connection_mode: 'webhook', external_account_id: `phone-${fixture}`,
        account_label: `Test Phone ${fixture}`, credentialsReturned: false, liveDataConfirmed: false
      });

      const status = await asUser(channelTestUserId, { method: 'GET', url: '/api/channels/status' });
      expect(status.statusCode).toBe(200);
      expect(status.json().connections.some((connection: { channel_key: string; external_account_id: string }) =>
        connection.channel_key === 'whatsapp' && connection.external_account_id === `phone-${fixture}`
      )).toBe(true);

      const invalid = await asUser(channelTestUserId, {
        method: 'PUT', url: '/api/channels/gmail/meta-account',
        payload: { external_account_id: '123456' }
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().code).toBe('invalid_meta_channel');
    } finally {
      workspaceId = originalWorkspaceId;
    }
  });

  it('denies viewer access to provider account configuration', async () => {
    const denied = await asUser(users.viewer.id, {
      method: 'PUT', url: '/api/channels/whatsapp/meta-account',
      payload: { external_account_id: '123456' }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('insufficient_role');
  });
  it('tests partner key creation, one-time secret handling, inquiry intake and revocation end to end', async () => {
    const createdKey = await asUser(users.owner.id, { method: 'POST', url: '/api/integrations/keys', payload: { name: `Lifecycle ${fixture}` } });
    expect(createdKey.statusCode).toBe(201);
    lifecycleKeyId = createdKey.json().key.id;
    lifecycleSecret = createdKey.json().secret;
    expect(lifecycleSecret).toMatch(/^sp_live_[a-f0-9]{64}$/);

    const listed = await asUser(users.owner.id, { method: 'GET', url: '/api/integrations/keys' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().keys.some((key: { id: string; is_active: boolean }) => key.id === lifecycleKeyId && key.is_active)).toBe(true);
    expect(JSON.stringify(listed.json())).not.toContain(lifecycleSecret);
    expect(JSON.stringify(listed.json())).not.toContain('key_hash');

    const payload = {
      client_name: `Lifecycle Guest ${fixture}`,
      company_name: `Lifecycle Company ${fixture}`,
      client_email: `lifecycle-${fixture}@example.test`,
      client_phone: '',
      property_name: 'Lifecycle Test Hotel',
      inquiry_type: 'Corporate stay',
      check_in: '2026-12-10',
      check_out: '2026-12-12',
      guests: 2,
      notes: 'Created via a freshly issued partner API key'
    };
    const headers = { authorization: `Bearer ${lifecycleSecret}`, 'idempotency-key': `lifecycle-${fixture}-key-001` };
    const accepted = await app.inject({ method: 'POST', url: '/api/partner/inquiries', headers, payload });
    expect(accepted.statusCode).toBe(201);
    lifecycleLeadId = accepted.json().lead_id;

    const revoked = await asUser(users.owner.id, { method: 'DELETE', url: `/api/integrations/keys/${lifecycleKeyId}` });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revoked).toBe(true);
    const blocked = await app.inject({
      method: 'POST', url: '/api/partner/inquiries',
      headers: { ...headers, 'idempotency-key': `lifecycle-${fixture}-key-after-revoke` },
      payload
    });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().code).toBe('partner_key_invalid');
  });
  it('blocks inactive members until an authorized owner restores access', async () => {
    const blocked = await asUser(users.inactiveSales.id, { method: 'GET', url: '/api/session' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('member_disabled');
    const reactivated = await asUser(users.owner.id, { method: 'POST', url: `/api/team/members/${users.inactiveSales.id}/reactivate` });
    expect(reactivated.statusCode).toBe(200);
    expect(reactivated.json().reactivated).toBe(true);
    const accessRestored = await asUser(users.inactiveSales.id, { method: 'GET', url: '/api/session' });
    expect(accessRestored.statusCode).toBe(200);
  });

  it('prevents admins from reactivating an administrator and handles already-active members', async () => {
    const denied = await asUser(users.admin.id, { method: 'POST', url: `/api/team/members/${users.inactiveAdmin.id}/reactivate` });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('owner_role_required');
    const allowed = await asUser(users.owner.id, { method: 'POST', url: `/api/team/members/${users.inactiveAdmin.id}/reactivate` });
    expect(allowed.statusCode).toBe(200);
    const alreadyActive = await asUser(users.owner.id, { method: 'POST', url: `/api/team/members/${users.inactiveAdmin.id}/reactivate` });
    expect(alreadyActive.statusCode).toBe(409);
    expect(alreadyActive.json().code).toBe('member_already_active');
  });
});
