import { clerkClient, getAuth } from '@clerk/fastify';
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

async function getVerifiedPrimaryEmail(userId: string): Promise<{ email: string; name: string } | null> {
  const user = await clerkClient.users.getUser(userId);
  const primary = user.emailAddresses.find(item => item.id === user.primaryEmailAddressId);
  const verified = primary?.verification?.status === 'verified'
    ? primary
    : user.emailAddresses.find(item => item.verification?.status === 'verified');
  if (!verified?.emailAddress) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || verified.emailAddress;
  return { email: verified.emailAddress.trim().toLowerCase(), name };
}

export async function getDefaultWorkspaceId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM workspaces WHERE slug = 'default' LIMIT 1");
  if (!rows[0]) throw new Error('workspace_not_provisioned');
  return rows[0].id;
}

async function bootstrapConfiguredOwner(userId: string, profile: { email: string; name: string }): Promise<void> {
  if (!env.ownerClerkUserId || userId !== env.ownerClerkUserId) return;
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, role, is_active)
     SELECT id, $1, $2, $3, 'owner', true FROM workspaces WHERE slug = 'default'
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET
       email = EXCLUDED.email, display_name = EXCLUDED.display_name, role = 'owner', is_active = true, updated_at = now()`,
    [userId, profile.email, profile.name]
  );
}

async function acceptMatchingInvite(userId: string, profile: { email: string; name: string }): Promise<void> {
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
      [userId, row.id]
    );
    if (!accepted.rows.length) return;
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, email, display_name, role, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, userId, profile.email, profile.name, row.role]
    );
    await client.query(
      `INSERT INTO sp_audit_events (workspace_id, actor_user_id, actor_email, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, 'team.invitation_accepted', 'workspace_invite', $4, '{}'::jsonb)`,
      [workspaceId, userId, profile.email, row.id]
    );
  });
}

export async function requireWorkspaceMember(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: MemberRole[] = allRoles
): Promise<WorkspaceMember | null> {
  const auth = getAuth(request);
  const userId = auth.isAuthenticated ? auth.userId : null;
  if (!userId) {
    fail(reply, 401, 'Sign in to access this StayPilot workspace.', 'authentication_required');
    return null;
  }

  let result = await pool.query<WorkspaceMember & { is_active: boolean }>(
    `SELECT workspace_id, user_id, email, display_name, role, is_active
     FROM workspace_members WHERE user_id = $1 LIMIT 2`, [userId]
  );

  if (!result.rows.length) {
    let profile: { email: string; name: string } | null = null;
    try {
      profile = await getVerifiedPrimaryEmail(userId);
    } catch {
      fail(reply, 401, 'Your sign-in could not be verified. Sign in again.', 'identity_verification_failed');
      return null;
    }
    if (!profile) {
      fail(reply, 403, 'Use a verified email address invited to this workspace.', 'verified_email_required');
      return null;
    }
    await bootstrapConfiguredOwner(userId, profile);
    result = await pool.query<WorkspaceMember & { is_active: boolean }>(
      `SELECT workspace_id, user_id, email, display_name, role, is_active
       FROM workspace_members WHERE user_id = $1 LIMIT 2`, [userId]
    );
    if (!result.rows.length && env.ownerClerkUserId !== userId) {
      try { await acceptMatchingInvite(userId, profile); } catch {
        fail(reply, 403, 'Workspace invitation could not be accepted. Ask an owner to review access.', 'invitation_acceptance_failed');
        return null;
      }
      result = await pool.query<WorkspaceMember & { is_active: boolean }>(
        `SELECT workspace_id, user_id, email, display_name, role, is_active
         FROM workspace_members WHERE user_id = $1 LIMIT 2`, [userId]
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
  await pool.query(
    'UPDATE workspace_members SET last_seen_at = now() WHERE workspace_id = $1 AND user_id = $2',
    [member.workspace_id, member.user_id]
  );
  return {
    workspace_id: member.workspace_id,
    user_id: member.user_id,
    email: member.email,
    display_name: member.display_name,
    role: member.role
  };
}

export function isOwnerOrAdmin(member: WorkspaceMember): boolean {
  return member.role === 'owner' || member.role === 'admin';
}
