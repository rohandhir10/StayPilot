import { jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from './config.js';
import { pool, inTransaction } from './db.js';
import { fail } from './http.js';

export type MemberRole = 'owner' | 'admin' | 'sales' | 'viewer';
export type WorkspaceMember = {
  workspace_id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: MemberRole;
};
const allRoles: MemberRole[] = ['owner', 'admin', 'sales', 'viewer'];

type AuthProfile = { id: string; email: string; name: string; provider: string };
async function verifyRequest(request: FastifyRequest): Promise<AuthProfile | null> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || !env.apiAuthSecret) return null;
  try {
    const { payload } = await jwtVerify(header.slice(7), new TextEncoder().encode(env.apiAuthSecret), {
      algorithms: ['HS256'], issuer: env.authTokenIssuer, audience: 'staypilot-api', clockTolerance: 5
    });
    if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.email !== 'string' ||
        payload.email_verified !== true || typeof payload.name !== 'string' || typeof payload.auth_provider !== 'string') return null;
    const email = payload.email.trim().toLowerCase();
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || email.length > 254) return null;
    return { id: payload.sub, email, name: payload.name.slice(0, 160) || email, provider: payload.auth_provider };
  } catch {
    return null;
  }
}

export async function getDefaultWorkspaceId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM workspaces WHERE slug = 'default' LIMIT 1");
  if (!rows[0]) throw new Error('workspace_not_provisioned');
  return rows[0].id;
}

async function bootstrapConfiguredOwner(profile: AuthProfile): Promise<void> {
  if (!env.ownerEmail || profile.email !== env.ownerEmail) return;
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, role, is_active)
     SELECT id, $1, $2, $3, 'owner', true FROM workspaces WHERE slug = 'default'
     ON CONFLICT (workspace_id, email) DO UPDATE SET
       user_id = EXCLUDED.user_id, display_name = EXCLUDED.display_name, role = 'owner', is_active = true, updated_at = now()`,
    [profile.id, profile.email, profile.name]
  );
}

async function acceptMatchingInvite(profile: AuthProfile): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  await inTransaction(async client => {
    const invitation = await client.query<{ id: string; role: MemberRole }>(
      `SELECT id, role FROM workspace_invites
       WHERE workspace_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [workspaceId, profile.email]
    );
    const row = invitation.rows[0];
    if (!row) return;
    const accepted = await client.query(
      `UPDATE workspace_invites SET accepted_at = now(), accepted_user_id = $1, updated_at = now()
       WHERE id = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING id`,
      [profile.id, row.id]
    );
    if (!accepted.rows.length) return;
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, role, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (workspace_id, email) DO UPDATE SET user_id = EXCLUDED.user_id, display_name = EXCLUDED.display_name,
         role = EXCLUDED.role, is_active = true, updated_at = now()`,
      [workspaceId, profile.id, profile.email, profile.name, row.role]
    );
    await client.query(
      `INSERT INTO sp_audit_events (workspace_id, actor_user_id, actor_email, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, 'team.invitation_accepted', 'workspace_invite', $4, '{}'::jsonb)`,
      [workspaceId, profile.id, profile.email, row.id]
    );
  });
}

export async function requireWorkspaceMember(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: MemberRole[] = allRoles
): Promise<WorkspaceMember | null> {
  const profile = await verifyRequest(request);
  if (!profile) {
    fail(reply, 401, 'Sign in to access this StayPilot workspace.', 'authentication_required');
    return null;
  }

  if (profile.provider === 'test-credentials') {
    if (!env.testLoginEnabled || !env.testLoginEmail || profile.email !== env.testLoginEmail) {
      fail(reply, 403, 'Manual test access is disabled for this account.', 'test_access_disabled');
      return null;
    }
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, role, is_active)
       SELECT id, $1, $2, $3, 'admin', true FROM workspaces WHERE slug = 'test'
       ON CONFLICT (workspace_id, email) DO UPDATE SET user_id = EXCLUDED.user_id,
         display_name = EXCLUDED.display_name, role = 'admin', is_active = true, updated_at = now()`,
      [profile.id, profile.email, profile.name]
    );
    const testResult = await pool.query<WorkspaceMember & { is_active: boolean }>(
      `SELECT workspace_id, user_id, email, display_name, role, is_active
       FROM workspace_members WHERE email = $1 AND workspace_id = (SELECT id FROM workspaces WHERE slug = 'test') LIMIT 2`,
      [profile.email]
    );
    if (testResult.rows.length !== 1 || !testResult.rows[0]?.is_active) {
      fail(reply, 403, 'The isolated test workspace is not available.', 'test_workspace_unavailable');
      return null;
    }
    const testMember = testResult.rows[0];
    if (!allowedRoles.includes(testMember.role)) {
      fail(reply, 403, 'Your workspace role does not permit this action.', 'insufficient_role');
      return null;
    }
    await pool.query('UPDATE workspace_members SET last_seen_at = now() WHERE workspace_id = $1 AND user_id = $2',
      [testMember.workspace_id, testMember.user_id]);
    return { workspace_id: testMember.workspace_id, user_id: testMember.user_id, email: testMember.email,
      display_name: testMember.display_name, role: testMember.role };
  }

  let result = await pool.query<WorkspaceMember & { is_active: boolean }>(
    `SELECT workspace_id, user_id, email, display_name, role, is_active
     FROM workspace_members WHERE user_id = $1 OR email = $2
     ORDER BY CASE WHEN user_id = $1 THEN 0 ELSE 1 END LIMIT 2`, [profile.id, profile.email]
  );

  if (!result.rows.length) {
    await bootstrapConfiguredOwner(profile);
    result = await pool.query<WorkspaceMember & { is_active: boolean }>(
      `SELECT workspace_id, user_id, email, display_name, role, is_active
       FROM workspace_members WHERE user_id = $1 OR email = $2
       ORDER BY CASE WHEN user_id = $1 THEN 0 ELSE 1 END LIMIT 2`, [profile.id, profile.email]
    );
    if (!result.rows.length && profile.email !== env.ownerEmail) {
      try { await acceptMatchingInvite(profile); } catch {
        fail(reply, 403, 'Workspace invitation could not be accepted. Ask an owner to review access.', 'invitation_acceptance_failed');
        return null;
      }
      result = await pool.query<WorkspaceMember & { is_active: boolean }>(
        `SELECT workspace_id, user_id, email, display_name, role, is_active
         FROM workspace_members WHERE user_id = $1 OR email = $2
         ORDER BY CASE WHEN user_id = $1 THEN 0 ELSE 1 END LIMIT 2`, [profile.id, profile.email]
      );
    }
  }

  if (result.rows.length !== 1) {
    fail(reply, 403, 'This account is not a member of the StayPilot workspace.', 'workspace_membership_required');
    return null;
  }
  const member = result.rows[0];
  if (!member) {
    fail(reply, 403, 'This account is not a member of the StayPilot workspace.', 'workspace_membership_required');
    return null;
  }
  if (!member.is_active) {
    fail(reply, 403, 'Your StayPilot access has been disabled.', 'member_disabled');
    return null;
  }
  if (!allRoles.includes(member.role) || !allowedRoles.includes(member.role)) {
    fail(reply, 403, 'Your workspace role does not permit this action.', 'insufficient_role');
    return null;
  }
  await pool.query('UPDATE workspace_members SET last_seen_at = now() WHERE workspace_id = $1 AND user_id = $2',
    [member.workspace_id, member.user_id]);
  return { workspace_id: member.workspace_id, user_id: member.user_id, email: member.email, display_name: member.display_name, role: member.role };
}

export function isOwnerOrAdmin(member: WorkspaceMember): boolean {
  return member.role === 'owner' || member.role === 'admin';
}
