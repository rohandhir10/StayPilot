import { describe, expect, it } from 'vitest';
import { resolveWorkspaceMembership } from '../src/workspace-selection.js';

const first = { workspace_id: '11111111-1111-4111-8111-111111111111', is_active: true, role: 'owner' };
const second = { workspace_id: '22222222-2222-4222-8222-222222222222', is_active: true, role: 'sales' };

describe('workspace membership selection', () => {
  it('uses the only active membership when no workspace is selected', () => {
    expect(resolveWorkspaceMembership([first])).toEqual({ kind: 'selected', member: first });
  });

  it('requires an explicit selection when the identity has multiple active workspaces', () => {
    expect(resolveWorkspaceMembership([first, second])).toEqual({ kind: 'selection_required' });
  });

  it('resolves only the membership matching the selected workspace ID', () => {
    expect(resolveWorkspaceMembership([first, second], second.workspace_id)).toEqual({
      kind: 'selected',
      member: second
    });
  });

  it('does not grant access when a client selects a workspace without membership', () => {
    expect(resolveWorkspaceMembership([first], second.workspace_id)).toEqual({ kind: 'not_a_member' });
  });

  it('does not expose a disabled membership as an active workspace', () => {
    const disabled = { ...first, is_active: false };
    expect(resolveWorkspaceMembership([disabled], disabled.workspace_id)).toEqual({ kind: 'disabled' });
    expect(resolveWorkspaceMembership([disabled])).toEqual({ kind: 'not_a_member' });
  });

  it('fails closed when duplicate membership rows make a selection ambiguous', () => {
    expect(resolveWorkspaceMembership([first, { ...first, role: 'admin' }], first.workspace_id)).toEqual({
      kind: 'ambiguous'
    });
  });

  it('denies an identity with no membership rows', () => {
    expect(resolveWorkspaceMembership([])).toEqual({ kind: 'not_a_member' });
  });
});
