// DEVELOPMENT FIXTURES ONLY. Loaded exclusively when the site is built or served
// with `--mode fixtures` (compile-time __PORTAL_FIXTURES__). Every screen shows a
// "Demo data" label. No passwords are stored: every fixture account signs in
// with the shared demo password below, and typed passwords are discarded.
import { authFailure } from '../auth-errors.ts';
import { canChangeRole, canRemoveMember, type Role } from '../permissions.ts';
import { FREE_BETA_SEAT_LIMIT, seatUsage } from '../plan.ts';
import { generateJoinCode } from '../validation.ts';
import {
  JOIN_CODE_ROLE, OperationError, type AuthAdapter, type AuthSnapshot, type AuthUser, type BillingAdapter,
  type JoinCodeState, type Loadable, type Member, type Services, type Workspace, type WorkspaceAdapter, type WorkspaceScope,
} from '../adapters/types.ts';
import type { FixtureControls, FixtureState } from './controls.ts';

const DEMO_PASSWORD = 'demo-password';
const STORAGE_KEY = 'sayspec.portal.fixtures.v1';
const code = (value: string | null, enabled = true): JoinCodeState => ({ code: value, enabled, role: JOIN_CODE_ROLE, rotatedAt: value ? '2026-09-01T09:00:00Z' : null });

interface FixtureUser extends AuthUser { disabled?: boolean }
interface FixtureWorkspace { id: string; name: string; ownerUids: string[]; members: Member[]; joinCode: JoinCodeState }
interface FixtureDb { users: FixtureUser[]; workspaces: FixtureWorkspace[]; sessionUid: string | null; state: FixtureState }

const member = (uid: string, role: Role, extra: Partial<Member> = {}): Member => ({
  uid, role, status: 'active', joinedAt: new Date('2026-09-01T09:00:00Z'), displayName: null, email: null, joinedVia: 'join-code', ...extra,
});

function seed(): FixtureDb {
  return {
    sessionUid: null,
    state: { team: 'normal', failNextWorkspaceCreate: false },
    users: [
      { uid: 'demo_owner', email: 'owner@demo.sayspec.test', displayName: 'Morgan Owner', emailVerified: true },
      { uid: 'demo_admin', email: 'alex@demo.sayspec.test', displayName: 'Alex Admin', emailVerified: true },
      { uid: 'demo_member', email: 'member@demo.sayspec.test', displayName: 'Sam Member', emailVerified: true },
      { uid: 'demo_new', email: 'new@demo.sayspec.test', displayName: 'Noa New', emailVerified: true },
      { uid: 'demo_disabled', email: 'disabled@demo.sayspec.test', displayName: 'Dana Disabled', emailVerified: true, disabled: true },
    ],
    workspaces: [
      {
        id: 'ws_acme', name: 'Acme QA (demo)', ownerUids: ['demo_owner'], joinCode: code('KXMPQRTA'), members: [
          member('demo_owner', 'owner', { displayName: 'Morgan Owner', email: 'owner@demo.sayspec.test', joinedVia: 'owner' }),
          member('demo_admin', 'admin', { displayName: 'Alex Admin', email: 'alex@demo.sayspec.test' }),
          member('demo_member', 'editor', { displayName: 'Sam Member', email: 'member@demo.sayspec.test' }),
          member('demo_former', 'editor', { displayName: 'Former Tester', email: 'former@demo.sayspec.test', status: 'revoked' }),
        ],
      },
      {
        id: 'ws_side', name: 'Side Project (demo)', ownerUids: ['demo_owner'], joinCode: code(null, false), members: [
          member('demo_owner', 'owner', { displayName: 'Morgan Owner', email: 'owner@demo.sayspec.test', joinedVia: 'owner' }),
        ],
      },
      {
        id: 'ws_partner', name: 'Partner Labs (demo)', ownerUids: ['demo_partner'], joinCode: code('WZNHGFDC'), members: [
          member('demo_partner', 'owner', { displayName: 'Pat Partner', email: 'pat@demo.sayspec.test', joinedVia: 'owner' }),
          member('demo_owner', 'editor', { displayName: 'Morgan Owner', email: 'owner@demo.sayspec.test' }),
        ],
      },
    ],
  };
}

function load(): FixtureDb {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const db = JSON.parse(raw) as FixtureDb;
      db.workspaces.forEach((workspace) => workspace.members.forEach((item) => { item.joinedAt = item.joinedAt ? new Date(item.joinedAt) : null; }));
      return db;
    }
  } catch { /* fall through to a fresh seed */ }
  return seed();
}

export function createFixtureServices(): Services {
  let db = load();
  const changeListeners = new Set<() => void>();
  const save = () => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch { /* storage unavailable: keep in memory */ }
    changeListeners.forEach((listener) => listener());
  };
  const watch = (fn: () => void) => { changeListeners.add(fn); fn(); return () => { changeListeners.delete(fn); }; };
  const delay = () => new Promise((resolve) => setTimeout(resolve, 350));
  const findWorkspace = (id: string) => db.workspaces.find((item) => item.id === id);
  const currentUid = () => db.sessionUid;

  // ------------------------------------------------------------ auth
  let expired = false;
  const snapshot = (): AuthSnapshot => {
    const user = db.users.find((item) => item.uid === db.sessionUid);
    if (user) return { status: 'signed-in', user: { uid: user.uid, email: user.email, displayName: user.displayName, emailVerified: user.emailVerified } };
    return { status: 'signed-out', reason: expired ? 'session-expired' : 'none' };
  };
  const auth: AuthAdapter = {
    subscribe(listener) {
      listener({ status: 'initializing' });
      const timer = setTimeout(() => listener(snapshot()), 250);
      let first = true;
      const off = watch(() => { if (first) { first = false; return; } listener(snapshot()); });
      return () => { clearTimeout(timer); off(); };
    },
    async signIn(email, password) {
      await delay();
      const user = db.users.find((item) => item.email === email.trim().toLowerCase());
      if (!user || password !== DEMO_PASSWORD) throw authFailure('invalid-credentials');
      if (user.disabled) throw authFailure('disabled');
      expired = false; db.sessionUid = user.uid; save();
    },
    async signUp({ email, displayName }) {
      await delay();
      const normalized = email.trim().toLowerCase();
      if (db.users.some((item) => item.email === normalized)) throw authFailure('email-in-use');
      const user: FixtureUser = { uid: `demo_${Date.now().toString(36)}`, email: normalized, displayName: displayName.trim() || null, emailVerified: false };
      db.users.push(user); expired = false; db.sessionUid = user.uid; save();
      return user;
    },
    async signOut() { await delay(); expired = false; db.sessionUid = null; save(); },
    async sendPasswordReset() { await delay(); },
    async updateDisplayName(displayName) {
      await delay();
      const user = db.users.find((item) => item.uid === currentUid());
      if (!user) throw authFailure('session-expired');
      user.displayName = displayName.trim() || null;
      db.workspaces.forEach((workspace) => workspace.members.forEach((item) => { if (item.uid === user.uid) item.displayName = user.displayName; }));
      save();
      return { ...user };
    },
    async changePassword(currentPassword) {
      await delay();
      if (currentPassword !== DEMO_PASSWORD) throw authFailure('invalid-credentials', 'Your current password is incorrect.');
      // Fixture passwords never change; the new value is discarded.
    },
  };

  // ------------------------------------------------------------ workspace
  const activeUsed = (workspace: FixtureWorkspace) => workspace.members.filter((item) => item.status === 'active').length;
  const actorContext = (workspace: FixtureWorkspace) => {
    const uid = currentUid() ?? '';
    const self = workspace.members.find((item) => item.uid === uid && item.status === 'active');
    return { uid, role: self?.role ?? null, ownerUids: workspace.ownerUids };
  };
  const requireWorkspace = (id: string) => {
    const workspace = findWorkspace(id);
    if (!workspace || !actorContext(workspace).role) throw new OperationError('permission-denied', 'You do not have permission to do that in this workspace.');
    return workspace;
  };

  const requireManager = (id: string) => {
    const item = requireWorkspace(id);
    const role = actorContext(item).role;
    if (role !== 'owner' && role !== 'admin') throw new OperationError('permission-denied', 'You do not have permission to do that in this workspace.');
    return item;
  };

  const workspace: WorkspaceAdapter = {
    capabilities: { createWorkspace: true, changeMemberRole: true, revokeMember: true, joinCodes: true, memberDirectory: true },
    subscribeWorkspaces(uid, listener) {
      listener({ status: 'loading' });
      let ready = false;
      const timer = setTimeout(() => { ready = true; emit(); }, 300);
      const emit = () => {
        if (!ready) return;
        const scopes: WorkspaceScope[] = db.workspaces.flatMap((item) => {
          const self = item.members.find((entry) => entry.uid === uid && entry.status === 'active');
          return self ? [{ id: item.id, name: item.name, role: self.role, status: 'active' }] : [];
        }).sort((a, b) => a.name.localeCompare(b.name));
        listener({ status: 'ready', data: scopes });
      };
      const off = watch(emit);
      return () => { clearTimeout(timer); off(); };
    },
    subscribeWorkspace(organizationId, listener) {
      listener({ status: 'loading' });
      return watch(() => {
        const item = findWorkspace(organizationId);
        if (!item || !actorContext(item).role) { listener({ status: 'error', kind: 'permission-denied', message: 'This workspace is no longer available.' }); return; }
        listener({ status: 'ready', data: { id: item.id, name: item.name, ownerUids: [...item.ownerUids] } satisfies Workspace });
      });
    },
    subscribeMembers(organizationId, listener) {
      listener({ status: 'loading' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = watch(() => {
        clearTimeout(timer);
        const item = findWorkspace(organizationId);
        if (!item || !actorContext(item).role) { listener({ status: 'error', kind: 'permission-denied', message: 'You no longer have access to this member list.' }); return; }
        if (db.state.team === 'loading') { listener({ status: 'loading' }); return; }
        if (db.state.team === 'error') { listener({ status: 'error', kind: 'unavailable', message: 'The member list could not be loaded. Check your connection and try again.' }); return; }
        const members = db.state.team === 'empty' ? item.members.filter((entry) => entry.uid === currentUid()) : item.members;
        timer = setTimeout(() => listener({ status: 'ready', data: members.map((entry) => ({ ...entry })) } as Loadable<Member[]>), 200);
      });
      return () => { clearTimeout(timer); off(); };
    },
    async createWorkspace({ organizationId, name }) {
      await delay();
      if (db.state.failNextWorkspaceCreate) { db.state.failNextWorkspaceCreate = false; save(); throw new OperationError('unavailable', 'SaySpec could not reach the workspace service. Try again.'); }
      const uid = currentUid(); const user = db.users.find((item) => item.uid === uid);
      if (!uid || !user) throw new OperationError('unauthenticated', 'Your session ended. Sign in again to continue.');
      if (findWorkspace(organizationId)) throw new OperationError('already-exists', 'That already exists.');
      db.workspaces.push({ id: organizationId, name: name.trim(), ownerUids: [uid], joinCode: code(null, false), members: [member(uid, 'owner', { displayName: user.displayName, email: user.email, joinedVia: 'owner' })] });
      save();
    },
    async changeMember({ organizationId, uid, role, status }) {
      await delay();
      const item = requireWorkspace(organizationId);
      const target = item.members.find((entry) => entry.uid === uid);
      if (!target) throw new OperationError('not-found', 'That member or workspace no longer exists.');
      const actor = actorContext(item);
      const decision = status === 'revoked' ? canRemoveMember(actor, target) : role ? canChangeRole(actor, target, role) : { allowed: true as const };
      if (!decision.allowed) throw new OperationError('failed-precondition', decision.reason);
      if (status === 'revoked') { target.status = 'revoked'; item.ownerUids = item.ownerUids.filter((owner) => owner !== uid); }
      if (role) {
        if (role === 'owner' && target.role !== 'owner') item.ownerUids.push(uid);
        if (role !== 'owner' && target.role === 'owner') item.ownerUids = item.ownerUids.filter((owner) => owner !== uid);
        target.role = role;
      }
      save();
    },
    subscribeJoinCode(organizationId, listener) {
      listener({ status: 'loading' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = watch(() => {
        clearTimeout(timer);
        const item = findWorkspace(organizationId);
        const role = item ? actorContext(item).role : null;
        if (!item || (role !== 'owner' && role !== 'admin')) { listener({ status: 'error', kind: 'permission-denied', message: 'Only owners and admins can see the company code.' }); return; }
        timer = setTimeout(() => listener({ status: 'ready', data: { ...item.joinCode } }), 150);
      });
      return () => { clearTimeout(timer); off(); };
    },
    async rotateJoinCode(organizationId) {
      await delay();
      const item = requireManager(organizationId);
      let next = generateJoinCode();
      while (db.workspaces.some((entry) => entry.joinCode.code === next)) next = generateJoinCode();
      item.joinCode = { ...item.joinCode, code: next, enabled: true, rotatedAt: new Date().toISOString() };
      save();
    },
    async setJoinCodeEnabled(organizationId, enabled) {
      await delay();
      const item = requireManager(organizationId);
      if (enabled && !item.joinCode.code) throw new OperationError('failed-precondition', 'Generate a company code first.');
      item.joinCode = { ...item.joinCode, enabled };
      save();
    },
    // Fixture members already carry directory fields.
    async syncMemberDirectory() { await delay(); },
  };

  // ------------------------------------------------------------ plan
  // Same policy as a new production workspace (Free plan, seat limit), labeled Demo data.
  const billing: BillingAdapter = {
    provider: 'fixture',
    subscribeStatus(_organizationId, listener) {
      listener({ status: 'loading' });
      const timer = setTimeout(() => listener({ status: 'ready', data: { kind: 'free', seatLimit: FREE_BETA_SEAT_LIMIT, source: 'fixture' } }), 200);
      return () => clearTimeout(timer);
    },
  };

  const controls: FixtureControls = {
    demoPassword: DEMO_PASSWORD,
    demoAccounts: [
      { email: 'owner@demo.sayspec.test', label: 'Owner of two workspaces, tester in a third' },
      { email: 'alex@demo.sayspec.test', label: 'Admin (team and code, no billing controls)' },
      { email: 'member@demo.sayspec.test', label: 'Tester only (sees the desktop-app page)' },
      { email: 'new@demo.sayspec.test', label: 'No workspace yet' },
      { email: 'disabled@demo.sayspec.test', label: 'Disabled account' },
    ],
    getState: () => ({ ...db.state }),
    subscribe(listener) { return watch(() => listener({ ...db.state })); },
    update(patch) { db.state = { ...db.state, ...patch }; save(); },
    revokeMembership(organizationId, uid) {
      const target = findWorkspace(organizationId)?.members.find((entry) => entry.uid === uid);
      if (target) { target.status = 'revoked'; save(); }
    },
    simulateJoin(organizationId) {
      // Mirrors the proposed joinCodeRedeem: needs an enabled code and a free
      // beta seat; joins as Editor immediately.
      const item = findWorkspace(organizationId);
      if (!item?.joinCode.enabled || !item.joinCode.code) return 'joining-off';
      if (seatUsage(activeUsed(item)).full) return 'full';
      const n = item.members.length + 1;
      item.members.push(member(`demo_joiner_${Date.now().toString(36)}`, JOIN_CODE_ROLE, { displayName: `New Tester ${n}`, email: `tester${n}@demo.sayspec.test`, joinedAt: new Date() }));
      save();
      return 'joined';
    },
    expireSession() { expired = true; db.sessionUid = null; save(); },
    reset() { const uid = db.sessionUid; db = seed(); db.sessionUid = uid; save(); },
  };

  return { runtime: { kind: 'fixtures', projectId: 'fixtures', emulators: false }, auth, workspace, billing, fixtures: controls };
}
