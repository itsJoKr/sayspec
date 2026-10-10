import type { Role } from '../permissions.ts';
import type { PlanKind } from '../plan.ts';

export type Unsubscribe = () => void;

export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; kind: 'permission-denied' | 'unavailable' | 'unknown'; message: string };

/** Thrown by every operation whose backend does not exist yet. */
export class NotConnectedError extends Error {
  readonly operation: string;
  constructor(operation: string, message: string) { super(message); this.name = 'NotConnectedError'; this.operation = operation; }
}

/** A trusted-operation failure mapped to plain copy (never raw server text). */
export type OperationErrorKind = 'permission-denied' | 'failed-precondition' | 'not-found' | 'already-exists' | 'invalid-argument' | 'unavailable' | 'unauthenticated' | 'unknown';
export class OperationError extends Error {
  readonly kind: OperationErrorKind;
  constructor(kind: OperationErrorKind, message: string) { super(message); this.name = 'OperationError'; this.kind = kind; }
}

// ---------------------------------------------------------------- auth

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
}

export type AuthSnapshot =
  | { status: 'initializing' }
  | { status: 'signed-out'; reason: 'none' | 'signed-out' | 'session-expired' }
  | { status: 'signed-in'; user: AuthUser };

export interface AuthAdapter {
  subscribe(listener: (snapshot: AuthSnapshot) => void): Unsubscribe;
  signIn(email: string, password: string): Promise<void>;
  /** Creates the signed-in visitor's own email/password identity. Never used on behalf of someone else. */
  signUp(input: { email: string; password: string; displayName: string }): Promise<AuthUser>;
  signOut(): Promise<void>;
  /** Resolves on success or unknown account (neutral response); rejects on transport/validation errors. */
  sendPasswordReset(email: string): Promise<void>;
  updateDisplayName(displayName: string): Promise<AuthUser>;
  /** Reauthenticates with the current password before changing it. */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
}

// ---------------------------------------------------------------- workspace

export interface WorkspaceScope { id: string; name: string; role: Role; status: string }
export interface Workspace { id: string; name: string; ownerUids: string[] }

export interface Member {
  uid: string;
  role: Role;
  status: 'active' | 'revoked' | string;
  joinedAt: Date | null;
  /**
   * Directory fields written by the server from Firebase Auth (organization
   * creation, company-code joins, invitations and memberDirectorySync). Null
   * until a sync reaches a legacy membership.
   */
  displayName: string | null;
  email: string | null;
  /** How the membership was created, when recorded ('owner' | 'invitation' | 'join-code'). */
  joinedVia: string | null;
}

/** Everyone who joins with a company code starts with this role (product decision 2026-09-24). */
export const JOIN_CODE_ROLE: Role = 'editor';

/**
 * Workspace company code. Testers type it in the SaySpec desktop app; they
 * join immediately as Editor. Server-written at
 * organizations/{orgId}/private/joinCode (readable by active owners/admins).
 */
export interface JoinCodeState {
  /** Eight letters, stored and compared uppercase without separators. Null until first generated. */
  code: string | null;
  enabled: boolean;
  role: Role;
  rotatedAt: string | null;
}

export interface WorkspaceCapabilities {
  /** Existing callables: organizationCreate / memberChange. */
  createWorkspace: boolean;
  changeMemberRole: boolean;
  revokeMember: boolean;
  /** joinCodeRotate / joinCodeSetEnabled callables and the owner/admin-readable private code. */
  joinCodes: boolean;
  /** Names/emails on membership documents. */
  memberDirectory: boolean;
}

export interface WorkspaceAdapter {
  capabilities: WorkspaceCapabilities;
  subscribeWorkspaces(uid: string, listener: (value: Loadable<WorkspaceScope[]>) => void): Unsubscribe;
  subscribeWorkspace(organizationId: string, listener: (value: Loadable<Workspace>) => void): Unsubscribe;
  subscribeMembers(organizationId: string, listener: (value: Loadable<Member[]>) => void): Unsubscribe;
  createWorkspace(input: { organizationId: string; name: string }): Promise<void>;
  changeMember(input: { organizationId: string; uid: string; role?: Role; status?: 'revoked' }): Promise<void>;
  subscribeJoinCode(organizationId: string, listener: (value: Loadable<JoinCodeState>) => void): Unsubscribe;
  /** Generates a new code server-side; the previous code stops working immediately. */
  rotateJoinCode(organizationId: string): Promise<void>;
  setJoinCodeEnabled(organizationId: string, enabled: boolean): Promise<void>;
  /**
   * Refreshes member names/emails from Firebase Auth and the server seat count
   * (memberDirectorySync). Safe to repeat; failures leave existing data as is.
   */
  syncMemberDirectory(organizationId: string): Promise<void>;
}

// ---------------------------------------------------------------- plan

/**
 * Workspace plan, written by the backend: Free (new workspaces), Beta (unpaid,
 * Pro features) or Pro (paid; not offered yet, operator-set only). Every plan
 * has a seat limit (product decision 2026-09-24). Prices and Stripe come later;
 * see BACKEND-HANDOFF.md §3.
 */
export interface PlanStatus {
  kind: PlanKind;
  /** Maximum active members, including the owner. Enforced server-side at join time. */
  seatLimit: number;
  /**
   * 'server': written by the backend on the workspace document (authoritative).
   * 'default': the workspace predates server plan fields; the published Beta
   * default is shown until the next membership sync writes the server value.
   */
  source: 'server' | 'default' | 'fixture';
}

export interface BillingAdapter {
  provider: 'beta' | 'fixture';
  subscribeStatus(organizationId: string, listener: (value: Loadable<PlanStatus>) => void): Unsubscribe;
}

export interface RuntimeInfo {
  kind: 'firebase' | 'fixtures';
  projectId: string;
  emulators: boolean;
}

export interface Services {
  runtime: RuntimeInfo;
  auth: AuthAdapter;
  workspace: WorkspaceAdapter;
  billing: BillingAdapter;
  /** Only present in `--mode fixtures` builds. */
  fixtures?: import('../fixtures/controls.ts').FixtureControls;
}
