import type { FastifyInstance } from 'fastify';
import { pool, inTransaction } from '../db.js';
import { requireWorkspaceMember, type MemberRole } from '../auth.js';
import { fail, noStore } from '../http.js';
import { auditEvent } from '../domain.js';
import { inviteSchema } from '../validation.js';

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  const currentSession = async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const member = await requireWorkspaceMember(request, reply);
    if (!member) return;
    noStore(reply);
    return reply.send({
      user: { id: member.user_id, email: member.email, name: member.display_name },
      workspace: { id: member.workspace_id, role: member.role },
      permissions: {
        canManageTeam: ['owner', 'admin'].includes(member.role),
        canManageIntegrations: ['owner', 'admin'].includes(member.role),
        canWriteInquiries: ['owner', 'admin', 'sales'].includes(member.role)
      }
    });
  };
  app.get('/api/me', currentSession);
  app.get('/api/session', currentSession); // Compatibility alias for the existing StayPilot UI.

  app.get('/api/team/invites', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
    if (!member) return;
    try {
      const { rows } = await pool.query(
        `SELECT id, email, role, expires_at, accepted_at, accepted_user_id IS NOT NULL AS accepted, revoked_at, created_at
         FROM workspace_invites WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 200`, [member.workspace_id]
      );
      noStore(reply);
      return reply.send({ invites: rows });
    } catch {
      return fail(reply, 500, 'Could not load team invitations.', 'team_invites_failed');
    }
  });

  app.post('/api/team/invites', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
    if (!member) return;
    const parsed = inviteSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message || 'Invitation data is invalid.', 'invalid_invite');
    if (parsed.data.role === 'admin' && member.role !== 'owner') return fail(reply, 403, 'Only the workspace owner may invite administrators.', 'owner_role_required');
    if (parsed.data.email === member.email) return fail(reply, 409, 'You cannot invite your own email address.', 'self_invite_not_allowed');
    try {
      const result = await inTransaction(async client => {
        const existing = await client.query(
          'SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND email=$2 LIMIT 1', [member.workspace_id, parsed.data.email]
        );
        if (existing.rows.length) return { conflict: true as const };
        const invitation = await client.query(
          `INSERT INTO workspace_invites (workspace_id, email, role, invited_by_user_id, expires_at, accepted_at, accepted_user_id, revoked_at, updated_at)
           VALUES ($1,$2,$3,$4,now() + interval '7 days',NULL,NULL,NULL,now())
           ON CONFLICT (workspace_id, email) DO UPDATE SET role=EXCLUDED.role, invited_by_user_id=EXCLUDED.invited_by_user_id,
             expires_at=EXCLUDED.expires_at, accepted_at=NULL, accepted_user_id=NULL, revoked_at=NULL, updated_at=now()
           WHERE workspace_invites.accepted_at IS NULL
             AND (workspace_invites.revoked_at IS NOT NULL OR workspace_invites.expires_at <= now())
           RETURNING id, email, role, expires_at, created_at`,
          [member.workspace_id, parsed.data.email, parsed.data.role, member.user_id]
        );
        if (!invitation.rows[0]) return { conflict: true as const };
        await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'team.invite_created', entityType: 'workspace_invite', entityId: invitation.rows[0].id, metadata: { role: parsed.data.role } });
        return { conflict: false as const, invitation: invitation.rows[0] };
      });
      if (result.conflict) return fail(reply, 409, 'This person already has access or an unexpired invitation.', 'invite_conflict');
      noStore(reply);
      return reply.code(201).send({ ok: true, invite: result.invitation, delivery: 'not_sent', message: 'Invitation access grant created. Email delivery is not configured in this release; send the invitee the sign-in link through your approved channel.' });
    } catch {
      return fail(reply, 500, 'Could not create the team invitation.', 'team_invite_create_failed');
    }
  });

  app.post('/api/team/invites/:id/revoke', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
    if (!member) return;
    const id = (request.params as { id?: string }).id || '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(reply, 400, 'A valid invitation ID is required.', 'invalid_invite_id');
    try {
      const result = await inTransaction(async client => {
        const update = await client.query(
          `UPDATE workspace_invites SET revoked_at=now(), updated_at=now()
           WHERE id=$1 AND workspace_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email`, [id, member.workspace_id]
        );
        if (!update.rows.length) return false;
        await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'team.invite_revoked', entityType: 'workspace_invite', entityId: id, metadata: {} });
        return true;
      });
      if (!result) return fail(reply, 404, 'Active invitation not found.', 'invite_not_found');
      return reply.send({ ok: true, revoked: true });
    } catch {
      return fail(reply, 500, 'Could not revoke the invitation.', 'team_invite_revoke_failed');
    }
  });

  app.get('/api/team/members', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
    if (!member) return;
    try {
      const { rows } = await pool.query(
        `SELECT user_id, email, display_name, role, is_active, created_at, last_seen_at
         FROM workspace_members WHERE workspace_id=$1 ORDER BY role, email LIMIT 200`, [member.workspace_id]
      );
      noStore(reply);
      return reply.send({ members: rows });
    } catch {
      return fail(reply, 500, 'Could not load workspace members.', 'team_members_failed');
    }
  });

  app.post('/api/team/members/:userId/reactivate', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
    if (!member) return;
    const targetUserId = (request.params as { userId?: string }).userId || '';
    if (targetUserId.length < 5 || targetUserId.length > 200) return fail(reply, 400, 'A valid member identifier is required.', 'invalid_member_id');
    try {
      const outcome = await inTransaction(async client => {
        const target = await client.query<{ role: MemberRole; is_active: boolean }>(
          'SELECT role, is_active FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',
          [member.workspace_id, targetUserId]
        );
        const existing = target.rows[0];
        if (!existing) return 'missing' as const;
        if (existing.is_active) return 'already_active' as const;
        if ((existing.role === 'owner' || existing.role === 'admin') && member.role !== 'owner') return 'forbidden' as const;
        await client.query(
          'UPDATE workspace_members SET is_active=true, updated_at=now() WHERE workspace_id=$1 AND user_id=$2',
          [member.workspace_id, targetUserId]
        );
        await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'team.member_reactivated', entityType: 'workspace_member', entityId: targetUserId, metadata: { role: existing.role } });
        return 'ok' as const;
      });
      if (outcome === 'missing') return fail(reply, 404, 'Workspace member not found.', 'member_not_found');
      if (outcome === 'already_active') return fail(reply, 409, 'This workspace member is already active.', 'member_already_active');
      if (outcome === 'forbidden') return fail(reply, 403, 'Only the owner may reactivate an owner or administrator.', 'owner_role_required');
      noStore(reply);
      return reply.send({ ok: true, reactivated: true });
    } catch {
      return fail(reply, 500, 'Could not restore workspace access.', 'member_reactivation_failed');
    }
  });
  app.post('/api/team/members/:userId/deactivate', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, ['owner', 'admin']);
    if (!member) return;
    const targetUserId = (request.params as { userId?: string }).userId || '';
    if (targetUserId.length < 5 || targetUserId.length > 200) return fail(reply, 400, 'A valid member identifier is required.', 'invalid_member_id');
    if (targetUserId === member.user_id) return fail(reply, 400, 'You cannot deactivate your own account.', 'self_deactivation_denied');
    try {
      const outcome = await inTransaction(async client => {
        const target = await client.query<{ role: MemberRole }>(
          `SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND is_active=true FOR UPDATE`,
          [member.workspace_id, targetUserId]
        );
        if (!target.rows[0]) return 'missing' as const;
        if (target.rows[0].role === 'owner') return 'owner' as const;
        if (target.rows[0].role === 'admin' && member.role !== 'owner') return 'forbidden' as const;
        await client.query('UPDATE workspace_members SET is_active=false, updated_at=now() WHERE workspace_id=$1 AND user_id=$2', [member.workspace_id, targetUserId]);
        await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'team.member_deactivated', entityType: 'workspace_member', entityId: targetUserId, metadata: {} });
        return 'ok' as const;
      });
      if (outcome === 'missing') return fail(reply, 404, 'Active workspace member not found.', 'member_not_found');
      if (outcome === 'owner') return fail(reply, 409, 'The owner account cannot be deactivated through this endpoint.', 'owner_deactivation_denied');
      if (outcome === 'forbidden') return fail(reply, 403, 'Only the owner may deactivate an administrator.', 'owner_role_required');
      return reply.send({ ok: true, deactivated: true });
    } catch {
      return fail(reply, 500, 'Could not deactivate workspace access.', 'member_deactivation_failed');
    }
  });
}
