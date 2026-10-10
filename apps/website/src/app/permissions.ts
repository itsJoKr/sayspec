// UI-only mirrors of server rules. Hiding a control is not authorization: the
// callable functions and Firestore Rules enforce every decision independently.
export type Role = 'owner' | 'admin' | 'editor' | 'reviewer' | 'viewer';
export const ROLES: Role[] = ['owner', 'admin', 'editor', 'reviewer', 'viewer'];
export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', reviewer: 'Reviewer', viewer: 'Viewer' };
export const ROLE_SUMMARIES: Record<Role, string> = {
  owner: 'Full control, including billing and ownership.',
  admin: 'Manages projects and non-owner members.',
  editor: 'Records, authors, generates and runs tests.',
  reviewer: 'Reviews and publishes tests and approves fixes.',
  viewer: 'Reads granted projects.',
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as string[]).includes(value);
}

export function canManageTeam(role: Role | null | undefined) { return role === 'owner' || role === 'admin'; }
/** The portal is for workspace owners and admins; testers use the desktop app. */
export const canUsePortal = canManageTeam;
/** Billing, ownership transfer and workspace deletion are owner-only. */
export function canManageBilling(role: Role | null | undefined) { return role === 'owner'; }

export function assignableRoles(actorRole: Role | null | undefined): Role[] {
  if (actorRole === 'owner') return ['owner', 'admin', 'editor', 'reviewer', 'viewer'];
  if (actorRole === 'admin') return ['editor', 'reviewer', 'viewer'];
  return [];
}

export interface MemberTarget { uid: string; role: Role; status: string }
export interface ActorContext { uid: string; role: Role | null; ownerUids: readonly string[] }

export type Decision = { allowed: true } | { allowed: false; reason: string };
const allow: Decision = { allowed: true };
const deny = (reason: string): Decision => ({ allowed: false, reason });

function isLastOwner(target: MemberTarget, actor: ActorContext) {
  return target.role === 'owner' && actor.ownerUids.filter(Boolean).length <= 1;
}

/** Mirrors changeMemberRole in firebase/functions/src/commands.ts. */
export function canChangeRole(actor: ActorContext, target: MemberTarget, nextRole: Role): Decision {
  if (!canManageTeam(actor.role)) return deny('Only owners and admins can change roles.');
  if (target.status !== 'active') return deny('Only active members can change roles.');
  if (actor.uid === target.uid && nextRole !== target.role) return deny('You cannot change your own role.');
  if (actor.role !== 'owner' && (target.role === 'owner' || nextRole === 'owner' || nextRole === 'admin')) return deny('Only an owner can change owner or admin roles.');
  if (nextRole !== 'owner' && isLastOwner(target, actor)) return deny('The last owner cannot be demoted. Make another member an owner first.');
  return allow;
}

export function canRemoveMember(actor: ActorContext, target: MemberTarget): Decision {
  if (!canManageTeam(actor.role)) return deny('Only owners and admins can remove members.');
  if (target.status !== 'active') return deny('This membership is already inactive.');
  if (actor.role !== 'owner' && target.role === 'owner') return deny('Only an owner can remove another owner.');
  if (isLastOwner(target, actor)) return deny('The last owner cannot be removed from the workspace.');
  return allow;
}
