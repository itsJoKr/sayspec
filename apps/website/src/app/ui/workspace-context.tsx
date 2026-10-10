import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthUser, PlanStatus, Loadable, Member, Workspace, WorkspaceScope } from '../adapters/types.ts';
import { canUsePortal, type Role } from '../permissions.ts';
import { useServices } from './context.tsx';

export interface WorkspaceData {
  user: AuthUser;
  scope: WorkspaceScope;
  workspace: Loadable<Workspace>;
  members: Loadable<Member[]>;
  billing: Loadable<PlanStatus>;
  me: Member | null;
  /** Role from the live membership document, falling back to the user scope. */
  role: Role;
  ownerUids: string[];
}

const WorkspaceContext = createContext<WorkspaceData | null>(null);

/**
 * Loads one workspace's data. The provider is keyed by workspace ID, so a
 * switch unmounts it and discards every listener and cached value.
 */
export function WorkspaceProvider({ user, scope, onRevoked, children }: { user: AuthUser; scope: WorkspaceScope; onRevoked: () => void; children: ReactNode }) {
  const services = useServices();
  const [workspace, setWorkspace] = useState<Loadable<Workspace>>({ status: 'loading' });
  const [members, setMembers] = useState<Loadable<Member[]>>({ status: 'loading' });
  const [billing, setBilling] = useState<Loadable<PlanStatus>>({ status: 'loading' });

  useEffect(() => services.workspace.subscribeWorkspace(scope.id, setWorkspace), [services, scope.id]);
  useEffect(() => services.workspace.subscribeMembers(scope.id, setMembers), [services, scope.id]);
  useEffect(() => services.billing.subscribeStatus(scope.id, setBilling), [services, scope.id]);
  // Backfills names/emails of legacy memberships from Firebase Auth and
  // refreshes the server seat count. Best effort: the page works without it.
  useEffect(() => { void services.workspace.syncMemberDirectory(scope.id).catch(() => undefined); }, [services, scope.id]);

  const revoked = (workspace.status === 'error' && workspace.kind === 'permission-denied') || (members.status === 'error' && members.kind === 'permission-denied');
  const me = members.status === 'ready' ? members.data.find((member) => member.uid === user.uid) ?? null : null;
  // Removed, or no longer an owner/admin (the portal is not for testers).
  const selfRevoked = members.status === 'ready' && (!me || me.status !== 'active' || !canUsePortal(me.role));
  useEffect(() => { if (revoked || selfRevoked) onRevoked(); }, [revoked, selfRevoked, onRevoked]);

  const value: WorkspaceData = {
    user, scope, workspace, members, billing, me,
    role: me?.role ?? scope.role,
    ownerUids: workspace.status === 'ready' ? workspace.data.ownerUids : [],
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('No workspace is selected.');
  return value;
}
