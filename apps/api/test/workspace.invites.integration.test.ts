import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireWorkspaceMember: vi.fn() }));
vi.mock('../src/auth.js', () => ({ requireWorkspaceMember: mocks.requireWorkspaceMember }));

import { pool } from '../src/db.js';
import { registerWorkspaceRoutes } from '../src/routes/workspace.js';

const testEmails = [
  'active-pending-invite@example.test',
  'accepted-invite@example.test',
  'expired-invite@example.test',
  'revoked-invite@example.test'
];
const owner = {
  workspace_id: '',
  user_id: 'user_test_owner',
  email: 'owner@example.test',
  display_name: 'Test Owner',
  role: 'owner' as const
};
let workspaceId = '';
const app = Fastify();

async function insertInvite(input: {
  email: string;
  role: 'admin' | 'sales' | 'viewer';
  expiresAt: 'future' | 'past';
  accepted?: boolean;
  revoked?: boolean;
}) {
  await pool.query(
    `INSERT INTO workspace_invites
      (workspace_id, email, role, invited_by_user_id, expires_at, accepted_at, revoked_at, updated_at)
     VALUES ($1,$2,$3,'user_original_inviter',
       CASE WHEN $4 = 'future' THEN now() + interval '1 day' ELSE now() - interval '1 day' END,
       CASE WHEN $5 THEN now() ELSE NULL END,
       CASE WHEN $6 THEN now() ELSE NULL END, now())`,
    [workspaceId, input.email, input.role, input.expiresAt, input.accepted ?? false, input.revoked ?? false]
  );
}

async function createInvite(email: string, role: 'admin' | 'sales' | 'viewer') {
  return await app.inject({
    method: 'POST',
    url: '/api/team/invites',
    payload: { email, role }
  });
}

describe('workspace invitation lifecycle (PostgreSQL integration)', () => {
  beforeAll(async () => {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM workspaces WHERE slug='default' LIMIT 1`
    );
    if (!result.rows[0]) throw new Error('Default workspace migration was not applied.');
    workspaceId = result.rows[0].id;
    owner.workspace_id = workspaceId;
    mocks.requireWorkspaceMember.mockImplementation(async () => owner);
    await registerWorkspaceRoutes(app);
    await app.ready();
  });

  beforeEach(async () => {
    await pool.query(
      'DELETE FROM workspace_invites WHERE workspace_id=$1 AND email=ANY($2::text[])',
      [workspaceId, testEmails]
    );
  });

  afterAll(async () => {
    await app.close();
    await pool.query(
      'DELETE FROM workspace_invites WHERE workspace_id=$1 AND email=ANY($2::text[])',
      [workspaceId, testEmails]
    );
    await pool.end();
  });

  it('does not overwrite an unexpired pending invitation', async () => {
    const email = testEmails[0];
    await insertInvite({ email, role: 'viewer', expiresAt: 'future' });
    const response = await createInvite(email, 'sales');
    expect(response.statusCode).toBe(409);

    const { rows } = await pool.query(
      'SELECT role, invited_by_user_id, accepted_at, revoked_at FROM workspace_invites WHERE workspace_id=$1 AND email=$2',
      [workspaceId, email]
    );
    expect(rows[0]).toMatchObject({
      role: 'viewer',
      invited_by_user_id: 'user_original_inviter',
      accepted_at: null,
      revoked_at: null
    });
  });

  it('does not reopen an accepted invitation even if its expiry is in the past', async () => {
    const email = testEmails[1];
    await insertInvite({ email, role: 'viewer', expiresAt: 'past', accepted: true });
    const response = await createInvite(email, 'sales');
    expect(response.statusCode).toBe(409);

    const { rows } = await pool.query(
      'SELECT role, accepted_at, revoked_at FROM workspace_invites WHERE workspace_id=$1 AND email=$2',
      [workspaceId, email]
    );
    expect(rows[0].role).toBe('viewer');
    expect(rows[0].accepted_at).not.toBeNull();
    expect(rows[0].revoked_at).toBeNull();
  });

  it('allows an expired unaccepted invitation to be issued again', async () => {
    const email = testEmails[2];
    await insertInvite({ email, role: 'viewer', expiresAt: 'past' });
    const response = await createInvite(email, 'sales');
    expect(response.statusCode).toBe(201);

    const { rows } = await pool.query(
      'SELECT role, invited_by_user_id, expires_at, accepted_at, revoked_at FROM workspace_invites WHERE workspace_id=$1 AND email=$2',
      [workspaceId, email]
    );
    expect(rows[0].role).toBe('sales');
    expect(rows[0].invited_by_user_id).toBe(owner.user_id);
    expect(new Date(rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(rows[0].accepted_at).toBeNull();
    expect(rows[0].revoked_at).toBeNull();
  });

  it('allows an explicitly revoked unaccepted invitation to be reissued', async () => {
    const email = testEmails[3];
    await insertInvite({ email, role: 'viewer', expiresAt: 'future', revoked: true });
    const response = await createInvite(email, 'sales');
    expect(response.statusCode).toBe(201);

    const { rows } = await pool.query(
      'SELECT role, accepted_at, revoked_at FROM workspace_invites WHERE workspace_id=$1 AND email=$2',
      [workspaceId, email]
    );
    expect(rows[0].role).toBe('sales');
    expect(rows[0].accepted_at).toBeNull();
    expect(rows[0].revoked_at).toBeNull();
  });
});
