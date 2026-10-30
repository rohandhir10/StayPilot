export type WorkspaceMembershipCandidate = {
  workspace_id: string;
  is_active: boolean;
};

export type WorkspaceMembershipResolution<T extends WorkspaceMembershipCandidate> =
  | { kind: 'selected'; member: T }
  | { kind: 'selection_required' }
  | { kind: 'not_a_member' }
  | { kind: 'disabled' }
  | { kind: 'ambiguous' };

/**
 * Resolve a workspace from server-fetched membership rows.
 * A client-supplied workspace ID is only a selector; it never creates access.
 */
export function resolveWorkspaceMembership<T extends WorkspaceMembershipCandidate>(
  memberships: T[],
  selectedWorkspaceId?: string
): WorkspaceMembershipResolution<T> {
  const candidates = selectedWorkspaceId
    ? memberships.filter(member => member.workspace_id === selectedWorkspaceId)
    : memberships.filter(member => member.is_active);

  if (candidates.length === 0) return { kind: 'not_a_member' };
  if (!selectedWorkspaceId && candidates.length > 1) return { kind: 'selection_required' };
  if (candidates.length !== 1) return { kind: 'ambiguous' };

  const member = candidates[0];
  if (!member) return { kind: 'not_a_member' };
  if (!member.is_active) return { kind: 'disabled' };
  return { kind: 'selected', member };
}
