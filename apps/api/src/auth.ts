import { verifyApiToken } from './auth-token.js';
import { clerkClient, getAuth } from '@clerk/fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from './config.js';
import { pool, inTransaction } from './db.js';
import { fail } from './http.js';
import { resolveWorkspaceMembership } from './workspace-selection.js';

export type MemberRole = 'owner' | 'admin' | 'sales' | 'viewer';
export type WorkspaceMember = {
  workspace_id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: MemberRole;
};
const allRoles: MemberRole[] = ['owner', 'admin', 'sales', 'viewer'];

type AuthProfile = { id: string; email: string; name: string; provider: 'google' | 'test-credentials' | 'clerk' };
export async function getAuthenticatedProfile(request: FastifyRequest): Promise<AuthProfile | null> {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ') && env.apiAuthSecret && env.authTokenIssuer) {
    const authJsIdentity = await verifyApiToken(header.slice(7), env.apiAuthSecret, env.authTokenIssuer);
    if (authJsIdentity) return authJsIdentity;
  }

  // Temporary compatibility: the existing production Vite client still uses Clerk
  // until the Next.js app is configured, deployed and explicitly cut over.
  const clerkAuth = getAuth(request);
  if (!clerkAuth.isAuthenticated || !clerkAuth.userId) return null;
  try {
    const user = await clerkClient.users.getUser(clerkAuth.userId);
    const primary = user.emailAddresses.find(item => item.id === user.primaryEmailAddressId);
    const verified = primary?.verification?.status === 'verified'
      ? primary
      : user.emailAddresses.find(item => item.verification?.status === 'verified');
    if (!verified?.emailAddress) return null;
    const email = verified.emailAddress.trim().toLowerCase();
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || email;
    return { id: clerkAuth.userId, email, name, provider: 'clerk' };
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
  const isConfiguredOwner = profile.provider === 'clerk'
    ? Boolean(env.ownerClerkUserId && profile.id === env.ownerClerkUserId)
    : Boolean(env.ownerEmail && profile.email === env.ownerEmail);
  if (!isConfiguredOwner) return;
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, role, is_active)
     SELECT id, $1, $2, $3, 'owner', true FROM workspaces WHERE slug = 'default'
     ON CONFLICT (workspace_id, email) DO UPDATE SET
       user_id = EXCLUDED.user_id, display_name = EXCLUDED.display_name, role = 'owner', is_active = true, updated_at = now()`,
    [profile.id, profile.email, profile.name]
  );
}

async function acceptMatchingInvite(profile: AuthProfile, workspaceId?: string): Promise<void> {
  const targetWorkspaceId = workspaceId || await getDefaultWorkspaceId();
  await inTransaction(async client => {
    const invitation = await client.query<{ id: string; role: MemberRole }>(
      `SELECT id, role FROM workspace_invites
       WHERE workspace_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [targetWorkspaceId, profile.email]
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
      [targetWorkspaceId, profile.id, profile.email, profile.name, row.role]
    );
    await client.query(
      `INSERT INTO sp_audit_events (workspace_id, actor_user_id, actor_email, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, 'team.invitation_accepted', 'workspace_invite', $4, '{}'::jsonb)`,
      [targetWorkspaceId, profile.id, profile.email, row.id]
    );
  });
}

export async function requireWorkspaceMember(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: MemberRole[] = allRoles
): Promise<WorkspaceMember | null> {
  const profile = await getAuthenticatedProfile(request);
  if (!profile) {
    fail(reply, 401, 'Sign in to access this StayPilot workspace.', 'authentication_required');
    return null;
  }

  const rawWorkspaceId = request.headers['x-staypilot-workspace-id'];
  if (Array.isArray(rawWorkspaceId)) {
    fail(reply, 400, 'Select one workspace at a time.', 'invalid_workspace_selection');
    return null;
  }
  const selectedWorkspaceId = typeof rawWorkspaceId === 'string' ? rawWorkspaceId.trim() : '';
  if (selectedWorkspaceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selectedWorkspaceId)) {
    fail(reply, 400, 'The selected workspace identifier is invalid.', 'invalid_workspace_selection');
    return null;
  }

  if (profile.provider === 'test-credentials') {
    if (!env.testLoginEnabled || !env.testLoginEmail || profile.email !== env.testLoginEmail) {
      fail(reply, 403, 'Manual test access is disabled for this account.', 'test_access_disabled');
      return null;
    }
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, role, is_active)
       SELECT id, $1, $2, $3, 'sales', true FROM workspaces
       WHERE slug = 'test' AND ($4::uuid IS NULL OR id = $4)
       ON CONFLICT (workspace_id, email) DO NOTHING`,
      [profile.id, profile.email, profile.name, selectedWorkspaceId || null]
    );
    const testResult = await pool.query<WorkspaceMember & { is_active: boolean }>(
      `SELECT wm.workspace_id, wm.user_id, wm.email, wm.display_name, wm.role, wm.is_active
       FROM workspace_members wm JOIN workspaces w ON w.id=wm.workspace_id
       WHERE wm.email=$1 AND w.slug='test' AND ($2::uuid IS NULL OR wm.workspace_id=$2)
       LIMIT 2`,
      [profile.email, selectedWorkspaceId || null]
    );
    if (testResult.rows.length !== 1 || !testResult.rows[0]?.is_active) {
      fail(reply, 403, 'The selected workspace is not available to this test account.', 'test_workspace_unavailable');
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

  const queryMembership = async () => {
    if (selectedWorkspaceId) {
      return pool.query<WorkspaceMember & { is_active: boolean }>(
        `SELECT workspace_id, user_id, email, display_name, role, is_active
         FROM workspace_members WHERE (user_id=$1 OR email=$2) AND workspace_id=$3
         ORDER BY CASE WHEN user_id=$1 THEN 0 ELSE 1 END LIMIT 2`,
        [profile.id, profile.email, selectedWorkspaceId]
      );
    }
    return pool.query<WorkspaceMember & { is_active: boolean }>(
      `SELECT workspace_id, user_id, email, display_name, role, is_active
       FROM workspace_members WHERE (user_id=$1 OR email=$2) AND is_active=true
       ORDER BY CASE WHEN user_id=$1 THEN 0 ELSE 1 END LIMIT 3`,
      [profile.id, profile.email]
    );
  };

  let result = await queryMembership();
  if (!result.rows.length) {
    const isConfiguredOwner = profile.provider === 'clerk'
      ? Boolean(env.ownerClerkUserId && profile.id === env.ownerClerkUserId)
      : Boolean(env.ownerEmail && profile.email === env.ownerEmail);
    if (isConfiguredOwner) {
      const defaultWorkspaceId = await getDefaultWorkspaceId();
      if (!selectedWorkspaceId || selectedWorkspaceId === defaultWorkspaceId) {
        await bootstrapConfiguredOwner(profile);
        result = await queryMembership();
      }
    }
    if (!result.rows.length) {
      try {
        const inviteWorkspaceId = selectedWorkspaceId || await getDefaultWorkspaceId();
        await acceptMatchingInvite(profile, inviteWorkspaceId);
      } catch {
        fail(reply, 403, 'Workspace invitation could not be accepted. Ask an owner to review access.', 'invitation_acceptance_failed');
        return null;
      }
      result = await queryMembership();
    }
  }

  const resolution = resolveWorkspaceMembership(result.rows, selectedWorkspaceId || undefined);
  if (resolution.kind === 'selection_required') {
    fail(reply, 409, 'Choose a hotel workspace before continuing.', 'workspace_selection_required');
    return null;
  }
  if (resolution.kind === 'disabled') {
    fail(reply, 403, 'Your StayPilot access has been disabled in this workspace.', 'member_disabled');
    return null;
  }
  if (resolution.kind === 'ambiguous') {
    fail(reply, 409, 'Workspace membership is ambiguous. Ask an owner to review your access.', 'workspace_membership_ambiguous');
    return null;
  }
  if (resolution.kind !== 'selected') {
    fail(reply, 403, 'This account is not a member of the selected StayPilot workspace.', 'workspace_membership_required');
    return null;
  }
  const member = resolution.member;
  if (!allRoles.includes(member.role) || !allowedRoles.includes(member.role)) {
    fail(reply, 403, 'Your workspace role does not permit this action.', 'insufficient_role');
    return null;
  }
  await pool.query('UPDATE workspace_members SET last_seen_at = now() WHERE workspace_id = $1 AND user_id = $2',
    [member.workspace_id, member.user_id]);
  return { workspace_id: member.workspace_id, user_id: member.user_id, email: member.email,
    display_name: member.display_name, role: member.role };
}

export function isOwnerOrAdmin(member: WorkspaceMember): boolean {
  return member.role === 'owner' || member.role === 'admin';
}
