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

const app = Fastify();
const fixture = randomUUID().replaceAll('-', '').slice(0, 12);
let workspaceId = '';
const users: Record<string, { id: string; email: string; role: string; active: boolean }> = {};
const inviteEmails = [`auth-${fixture}-viewer-invite@example.test`, `auth-${fixture}-admin-invite@example.test`, `auth-${fixture}-owner-invite@example.test`];

async function asUser(userId: string | null, input: { method: 'GET' | 'POST'; url: string; payload?: unknown }) {
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
    await registerWorkspaceRoutes(app);
    await registerLeadRoutes(app);
    await registerIntegrationRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
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
