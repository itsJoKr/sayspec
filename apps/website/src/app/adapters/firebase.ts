import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import {
  browserLocalPersistence, connectAuthEmulator, createUserWithEmailAndPassword, EmailAuthProvider, indexedDBLocalPersistence,
  initializeAuth, onAuthStateChanged, reauthenticateWithCredential, sendPasswordResetEmail, signInWithEmailAndPassword,
  signOut, updatePassword, updateProfile, type Auth, type User,
} from 'firebase/auth';
import { collection, connectFirestoreEmulator, doc, getFirestore, onSnapshot, type Firestore, type FirestoreError, type Timestamp } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type Functions } from 'firebase/functions';
import { authFailure, toAuthFailure } from '../auth-errors.ts';
import { isRole } from '../permissions.ts';
import type { FirebaseRuntime } from '../runtime-config.ts';
import { FREE_BETA_SEAT_LIMIT, planKind } from '../plan.ts';
import {
  OperationError, type AuthAdapter, type AuthSnapshot, type AuthUser, type BillingAdapter, type JoinCodeState, type Loadable, type Member,
  type Services, type Workspace, type WorkspaceAdapter, type WorkspaceScope,
} from './types.ts';

type Connected = Extract<FirebaseRuntime, { kind: 'firebase' }>;

function toUser(user: User): AuthUser {
  return { uid: user.uid, email: user.email, displayName: user.displayName, emailVerified: user.emailVerified };
}

function createAuthAdapter(auth: Auth): AuthAdapter {
  const listeners = new Set<(snapshot: AuthSnapshot) => void>();
  let current: AuthSnapshot = { status: 'initializing' };
  let expectingSignOut = false;
  const emit = (next: AuthSnapshot) => { current = next; listeners.forEach((listener) => listener(next)); };

  onAuthStateChanged(auth, (user) => {
    if (user) { emit({ status: 'signed-in', user: toUser(user) }); return; }
    // A signed-in user that disappears without an explicit sign-out means the
    // session ended elsewhere (token revoked, account disabled, expiry).
    const reason = current.status === 'signed-in' ? (expectingSignOut ? 'signed-out' : 'session-expired') : 'none';
    expectingSignOut = false;
    emit({ status: 'signed-out', reason });
  }, () => emit({ status: 'signed-out', reason: 'session-expired' }));

  const requireUser = () => {
    if (!auth.currentUser) throw authFailure('session-expired');
    return auth.currentUser;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => { listeners.delete(listener); };
    },
    async signIn(email, password) {
      try { await signInWithEmailAndPassword(auth, email.trim(), password); } catch (error) { throw toAuthFailure(error); }
    },
    async signUp({ email, password, displayName }) {
      try {
        const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
        if (displayName.trim()) {
          // A failed profile update must not block the account that now exists.
          await updateProfile(credential.user, { displayName: displayName.trim() }).catch(() => undefined);
          await credential.user.getIdToken(true).catch(() => undefined);
        }
        const user = toUser(credential.user);
        emit({ status: 'signed-in', user });
        return user;
      } catch (error) { throw toAuthFailure(error); }
    },
    async signOut() {
      expectingSignOut = true;
      try { await signOut(auth); } catch (error) { expectingSignOut = false; throw toAuthFailure(error); }
    },
    async sendPasswordReset(email) {
      try { await sendPasswordResetEmail(auth, email.trim(), { url: `${window.location.origin}/sign-in` }); }
      catch (error) {
        const failure = toAuthFailure(error);
        // Neutral response: never reveal whether the account exists.
        if (failure.code === 'invalid-credentials') return;
        throw failure;
      }
    },
    async updateDisplayName(displayName) {
      const user = requireUser();
      try {
        await updateProfile(user, { displayName: displayName.trim() || null });
        await user.getIdToken(true).catch(() => undefined);
        const next = toUser(user);
        emit({ status: 'signed-in', user: next });
        return next;
      } catch (error) { throw toAuthFailure(error); }
    },
    async changePassword(currentPassword, newPassword) {
      const user = requireUser();
      if (!user.email) throw authFailure('unknown', 'This account does not use an email password.');
      try {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, currentPassword));
        await updatePassword(user, newPassword);
      } catch (error) {
        const failure = toAuthFailure(error);
        if (failure.code === 'invalid-credentials') throw authFailure('invalid-credentials', 'Your current password is incorrect.');
        throw failure;
      }
    },
  };
}

function snapshotError(error: FirestoreError, what: string): Loadable<never> {
  if (error.code === 'permission-denied') return { status: 'error', kind: 'permission-denied', message: `You no longer have access to this ${what}.` };
  if (error.code === 'unavailable') return { status: 'error', kind: 'unavailable', message: `The ${what} could not be loaded. Check your connection and try again.` };
  return { status: 'error', kind: 'unknown', message: `The ${what} could not be loaded. Try again.` };
}

const OPERATION_KINDS = ['permission-denied', 'failed-precondition', 'not-found', 'already-exists', 'invalid-argument', 'unavailable', 'unauthenticated'] as const;
function toOperationError(error: unknown): OperationError {
  const raw = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code).replace(/^functions\//, '') : '';
  const reason = typeof error === 'object' && error && 'details' in error ? (error as { details?: { reason?: unknown } }).details?.reason : undefined;
  if (reason === 'seats-full') return new OperationError('failed-precondition', 'This workspace has no free seats. Remove a member first.');
  const kind = (OPERATION_KINDS as readonly string[]).includes(raw) ? raw as OperationError['kind'] : raw === 'internal' || raw === 'deadline-exceeded' || raw === 'aborted' ? 'unavailable' : 'unknown';
  const messages: Record<OperationError['kind'], string> = {
    'permission-denied': 'You do not have permission to do that in this workspace.',
    'failed-precondition': 'That change is not allowed in the workspace’s current state.',
    'not-found': 'That member or workspace no longer exists.',
    'already-exists': 'That already exists.',
    'invalid-argument': 'Some details were rejected. Check them and try again.',
    unavailable: 'SaySpec could not reach the workspace service. Try again.',
    unauthenticated: 'Your session ended. Sign in again to continue.',
    unknown: 'The change could not be saved. Try again.',
  };
  return new OperationError(kind, messages[kind]);
}

function toDate(value: unknown): Date | null {
  return value && typeof (value as Timestamp).toDate === 'function' ? (value as Timestamp).toDate() : null;
}

function createWorkspaceAdapter(db: Firestore, functions: Functions): WorkspaceAdapter {
  const organizationCreate = httpsCallable<{ organizationId: string; name: string }, { organizationId: string }>(functions, 'organizationCreate');
  const memberChange = httpsCallable<{ organizationId: string; uid: string; role?: string; status?: 'revoked' }, unknown>(functions, 'memberChange');
  const joinCodeRotate = httpsCallable<{ organizationId: string }, unknown>(functions, 'joinCodeRotate');
  const joinCodeSetEnabled = httpsCallable<{ organizationId: string; enabled: boolean }, unknown>(functions, 'joinCodeSetEnabled');
  const memberDirectorySync = httpsCallable<{ organizationId: string }, unknown>(functions, 'memberDirectorySync');

  return {
    capabilities: {
      createWorkspace: true, changeMemberRole: true, revokeMember: true,
      joinCodes: true, memberDirectory: true,
    },
    subscribeWorkspaces(uid, listener) {
      listener({ status: 'loading' });
      return onSnapshot(collection(db, 'userScopes', uid, 'organizations'), (snapshot) => {
        const scopes: WorkspaceScope[] = snapshot.docs.flatMap((item) => {
          const data = item.data();
          if (!isRole(data.role) || data.status !== 'active') return [];
          return [{ id: item.id, name: typeof data.name === 'string' && data.name ? data.name : item.id, role: data.role, status: data.status }];
        }).sort((a, b) => a.name.localeCompare(b.name));
        listener({ status: 'ready', data: scopes });
      }, (error) => listener(snapshotError(error, 'workspace list')));
    },
    subscribeWorkspace(organizationId, listener) {
      listener({ status: 'loading' });
      return onSnapshot(doc(db, 'organizations', organizationId), (snapshot) => {
        const data = snapshot.data();
        if (!snapshot.exists() || !data) { listener({ status: 'error', kind: 'permission-denied', message: 'This workspace is no longer available.' }); return; }
        listener({ status: 'ready', data: { id: snapshot.id, name: String(data.name ?? snapshot.id), ownerUids: Array.isArray(data.ownerUids) ? data.ownerUids.map(String) : [] } satisfies Workspace });
      }, (error) => listener(snapshotError(error, 'workspace')));
    },
    subscribeMembers(organizationId, listener) {
      listener({ status: 'loading' });
      return onSnapshot(collection(db, 'organizations', organizationId, 'members'), (snapshot) => {
        const members: Member[] = snapshot.docs.flatMap((item) => {
          const data = item.data();
          if (!isRole(data.role)) return [];
          return [{
            uid: item.id, role: data.role, status: String(data.status ?? 'unknown'), joinedAt: toDate(data.joinedAt),
            // Server-written from Firebase Auth; null for a legacy membership until memberDirectorySync reaches it.
            displayName: typeof data.displayName === 'string' ? data.displayName : null,
            email: typeof data.email === 'string' ? data.email : null,
            joinedVia: typeof data.joinedVia === 'string' ? data.joinedVia : typeof data.invitationId === 'string' ? 'invitation' : null,
          }];
        });
        listener({ status: 'ready', data: members });
      }, (error) => listener(snapshotError(error, 'member list')));
    },
    async createWorkspace(input) {
      try { await organizationCreate(input); } catch (error) { throw toOperationError(error); }
    },
    async changeMember(input) {
      try { await memberChange(input); } catch (error) { throw toOperationError(error); }
    },
    subscribeJoinCode(organizationId, listener) {
      listener({ status: 'loading' });
      // Readable only by active owners/admins; a demotion ends the subscription with permission-denied.
      return onSnapshot(doc(db, 'organizations', organizationId, 'private', 'joinCode'), (snapshot) => {
        const data = snapshot.data();
        const code = typeof data?.code === 'string' && /^[A-Z]{8}$/.test(data.code) ? data.code : null;
        listener({ status: 'ready', data: { code, enabled: code !== null && data?.enabled === true, role: 'editor', rotatedAt: toDate(data?.rotatedAt)?.toISOString() ?? null } satisfies JoinCodeState });
      }, (error) => listener(snapshotError(error, 'company code')));
    },
    async rotateJoinCode(organizationId) {
      try { await joinCodeRotate({ organizationId }); } catch (error) { throw toOperationError(error); }
    },
    async setJoinCodeEnabled(organizationId, enabled) {
      try { await joinCodeSetEnabled({ organizationId, enabled }); } catch (error) { throw toOperationError(error); }
    },
    async syncMemberDirectory(organizationId) {
      try { await memberDirectorySync({ organizationId }); } catch (error) { throw toOperationError(error); }
    },
  };
}

/**
 * The plan kind and seat limit the backend writes on the workspace document
 * (organizations/{id}.plan). The browser never supplies plan values; it only
 * displays them. Legacy workspaces show the published default limit until the
 * next membership sync writes the server value.
 */
function createServerPlan(db: Firestore): BillingAdapter {
  return {
    provider: 'beta',
    subscribeStatus(organizationId, listener) {
      listener({ status: 'loading' });
      return onSnapshot(doc(db, 'organizations', organizationId), (snapshot) => {
        const plan = snapshot.data()?.plan as { kind?: unknown; seatLimit?: unknown } | undefined;
        const kind = planKind(plan?.kind);
        const limit = plan?.seatLimit;
        listener({ status: 'ready', data: Number.isSafeInteger(limit) && (limit as number) > 0
          ? { kind, seatLimit: limit as number, source: 'server' }
          : { kind, seatLimit: FREE_BETA_SEAT_LIMIT, source: 'default' } });
      }, (error) => listener(snapshotError(error, 'plan')));
    },
  };
}

export function createFirebaseServices(runtime: Connected): Services {
  const app = initializeApp(runtime.config);
  // Local persistence keeps the browser session across reloads. It is separate
  // from the desktop app's session even though both use the same Auth project.
  const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  if (runtime.appCheckSiteKey) initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(runtime.appCheckSiteKey), isTokenAutoRefreshEnabled: true });
  const functions = getFunctions(app, runtime.functionsRegion);
  if (runtime.emulators) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }
  const db = getFirestore(app);
  if (runtime.emulators) connectFirestoreEmulator(db, '127.0.0.1', 8080);
  return {
    runtime: { kind: 'firebase', projectId: runtime.config.projectId, emulators: runtime.emulators },
    auth: createAuthAdapter(auth),
    workspace: createWorkspaceAdapter(db, functions),
    billing: createServerPlan(db),
  };
}
