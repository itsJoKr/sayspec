import { getApp, getApps, initializeApp } from 'firebase/app';
import { browserLocalPersistence, connectAuthEmulator, createUserWithEmailAndPassword, getAuth, getIdToken, onIdTokenChanged, sendPasswordResetEmail, setPersistence, signInWithEmailAndPassword, signOut, updateProfile, type User } from 'firebase/auth';
import { collection, connectFirestoreEmulator, doc, getDoc, getDocs, getFirestore, limit, onSnapshot, orderBy, query, startAfter, where, type DocumentData, type DocumentSnapshot, type QueryConstraint } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { connectStorageEmulator, getStorage, ref, uploadBytesResumable } from 'firebase/storage';
import { planKind, type CloudPatrolTestVersion, type TestSuite } from '@sayspec/contracts';
import { joinFailure } from '../../join-code';
import type { CloudBackend, CloudPageCursor, CloudSuite, CloudTest, CloudUser, JoinResult, OrganizationScope, ProjectRef, ProjectScope, ShareUpload } from '../backend';
import { authErrorState } from './auth-errors';
import { resolveFirebaseSettings } from './config';

const ACTIVE_STATUSES = ['draft', 'generated', 'definition-only', 'published'];
const isoDate = (value: unknown) => String((value as { toDate?: () => Date } | undefined)?.toDate?.()?.toISOString() ?? '');
const projectPath = ({ organizationId, projectId }: ProjectRef) => `organizations/${organizationId}/projects/${projectId}`;
const toUser = (user: User | null): CloudUser | null => user && { uid: user.uid, email: user.email, displayName: user.displayName };
const messageOf = (reason: unknown) => reason instanceof Error ? reason.message : '';

function toCloudTest(id: string, data: DocumentData): CloudTest {
  return {
    id, title: String(data.title ?? ''), createdAt: isoDate(data.createdAt),
    ownerUid: typeof data.ownerUid === 'string' ? data.ownerUid : undefined,
    authorLabel: typeof data.authorLabel === 'string' ? data.authorLabel : undefined,
    reviewerUid: data.reviewerUid ?? null, reviewerRevision: data.reviewerRevision ?? 0,
    ...(typeof data.recordingId === 'string' ? { recordingId: data.recordingId } : {}),
    ...(typeof data.currentVersionId === 'string' ? { currentVersionId: data.currentVersionId } : {}),
    ...(typeof data.currentVersionHash === 'string' ? { currentVersionHash: data.currentVersionHash } : {}),
  };
}
function toCloudPatrolVersion(testId: string, data: DocumentData | undefined): CloudPatrolTestVersion | undefined {
  if (!data || data.framework !== 'patrol' || typeof data.source !== 'string') return undefined;
  return {
    testId, title: String(data.title ?? ''), relativePath: String(data.relativePath ?? ''), source: data.source, contentHash: String(data.contentHash ?? ''),
    ...(typeof data.appVersion === 'string' ? { appVersion: data.appVersion } : {}),
    ...(data.dependencies && typeof data.dependencies === 'object' ? { dependencies: data.dependencies as Record<string, string> } : {}),
    ...(typeof data.recordingId === 'string' ? { recordingId: data.recordingId } : {}),
    ...(data.provider === 'claude-code' || data.provider === 'codex' ? { provider: data.provider } : {}),
  };
}
function toCloudSuite(id: string, data: DocumentData): CloudSuite {
  return {
    id, name: typeof data.name === 'string' ? data.name : '', revision: Number(data.revision ?? 0),
    testIds: Array.isArray(data.testIds) ? data.testIds.filter((item: unknown): item is string => typeof item === 'string') : [],
    ...(typeof data.sourceRecordingId === 'string' ? { sourceRecordingId: data.sourceRecordingId } : {}),
  };
}

/**
 * SaySpec Cloud on Firebase: Auth for accounts, Firestore (read directly under
 * Rules), callable Functions for every write, and Storage for shared evidence.
 * Configured from the build environment by `resolveFirebaseSettings`.
 */
export function createFirebaseBackend(): CloudBackend {
  const settings = resolveFirebaseSettings(import.meta.env);
  const app = getApps().length ? getApp() : initializeApp(settings.config);
  const auth = getAuth(app);
  const persistenceReady = setPersistence(auth, browserLocalPersistence);
  const firestore = getFirestore(app);
  const storage = getStorage(app);
  const functions = getFunctions(app, settings.functionsRegion);
  if (settings.emulators) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
    connectStorageEmulator(storage, '127.0.0.1', 9199);
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }
  const call = async <T = unknown>(name: string, data: unknown) => (await httpsCallable<unknown, T>(functions, name)(data)).data;

  async function upload(path: string, input: ShareUpload) {
    const copy = new Uint8Array(input.bytes.byteLength); copy.set(input.bytes);
    const task = uploadBytesResumable(ref(storage, path), copy, { contentType: input.mimeType, customMetadata: input.metadata });
    const abort = () => task.cancel(); input.signal.addEventListener('abort', abort, { once: true });
    try { await new Promise<void>((resolve, reject) => task.on('state_changed', (snapshot) => input.onProgress(snapshot.totalBytes ? snapshot.bytesTransferred / snapshot.totalBytes : 0), reject, resolve)); }
    finally { input.signal.removeEventListener('abort', abort); }
  }

  return {
    id: 'firebase',
    development: settings.emulators,

    auth: {
      onUserChanged(next, failed) {
        let active = true; let unsubscribe = () => {};
        void persistenceReady.then(() => { if (active) unsubscribe = onIdTokenChanged(auth, (user) => next(toUser(user))); }).catch((error) => { if (active) failed(error); });
        return () => { active = false; unsubscribe(); };
      },
      currentUser: () => toUser(auth.currentUser),
      async signIn(email, password) {
        await persistenceReady;
        return toUser((await signInWithEmailAndPassword(auth, email.trim(), password)).user)!;
      },
      async signUp(input) {
        await persistenceReady;
        const credential = await createUserWithEmailAndPassword(auth, input.email.trim(), input.password);
        if (input.displayName.trim()) {
          // A failed profile update must not undo the account that now exists.
          await updateProfile(credential.user, { displayName: input.displayName.trim() }).catch(() => undefined);
          await credential.user.getIdToken(true).catch(() => undefined);
        }
        return toUser(credential.user)!;
      },
      async sendPasswordReset(email) {
        await persistenceReady;
        try { await sendPasswordResetEmail(auth, email.trim()); }
        catch (error) {
          const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
          if (code.includes('user-not-found') || code.includes('invalid-credential')) return;
          throw error;
        }
      },
      signOut: () => signOut(auth),
      async refreshSession() {
        if (!auth.currentUser) return null;
        await getIdToken(auth.currentUser, true);
        return toUser(auth.currentUser);
      },
      idToken: async () => auth.currentUser?.getIdToken(),
      describeError: (error) => authErrorState(error, settings.emulators ? 'emulator' : 'live'),
    },

    workspaces: {
      subscribeOrganizations: (uid, next, failed) => onSnapshot(collection(firestore, 'userScopes', uid, 'organizations'), (snapshot) => next(snapshot.docs
        .map((item) => ({ id: item.id, ...item.data() } as OrganizationScope))
        .filter((item) => typeof item.name === 'string' && typeof item.role === 'string')), () => failed()),
      subscribeProjects: (uid, organizationId, next, failed) => onSnapshot(collection(firestore, 'userScopes', uid, 'organizations', organizationId, 'projects'), (snapshot) => next(snapshot.docs
        .map((item) => ({ id: item.id, ...item.data() } as ProjectScope))), () => failed()),
      subscribePlan: (organizationId, next) => onSnapshot(doc(firestore, 'organizations', organizationId), (snapshot) => next(planKind(snapshot.data())), () => next(null)),
      redeemJoinCode: (code) => call<JoinResult>('joinCodeRedeem', { code }),
      describeJoinError: joinFailure,
    },

    projects: {
      async create(input) { await call('projectCreate', input); },
      async setBaseUrl(input) { await call('projectConfigure', input); },
      async remove(input) { await call('projectDelete', input); },
      async setTestStorage(input) { await call('projectSetTestStorage', input); },
      subscribeTestInstructions: (input, next) => onSnapshot(doc(firestore, `${projectPath(input)}/config/testInstructions`), (snapshot) => {
        const text = snapshot.data()?.text;
        next(typeof text === 'string' ? text : null);
      }, () => undefined),
      async setTestInstructions(input) { await call('projectSetTestInstructions', input); },
    },

    tests: {
      subscribeSuites: (input, next, failed) => onSnapshot(collection(firestore, `${projectPath(input)}/suites`), (snapshot) => next(snapshot.docs.map((item): TestSuite => {
        const data = item.data();
        return { id: item.id, projectId: input.projectId, name: String(data.name), testIds: Array.isArray(data.testIds) ? data.testIds : [], revision: Number(data.revision ?? 0), updatedAt: isoDate(data.updatedAt), updatedByUid: data.updatedByUid, ...(typeof data.sourceRecordingId === 'string' ? { sourceRecordingId: data.sourceRecordingId } : {}) };
      })), () => failed()),
      subscribePage(input, next, failed) {
        const constraints: QueryConstraint[] = [where('status', 'in', ACTIVE_STATUSES), orderBy('normalizedTitle')];
        if (input.after) constraints.push(startAfter((input.after as CloudPageCursor & { snapshot: DocumentSnapshot }).snapshot));
        constraints.push(limit(input.size));
        return onSnapshot(query(collection(firestore, `${projectPath(input)}/tests`), ...constraints), (snapshot) => {
          const last = snapshot.docs.at(-1);
          next({ tests: snapshot.docs.map((item) => toCloudTest(item.id, item.data())), last: last ? { kind: 'cloud-page-cursor', snapshot: last } as CloudPageCursor : null });
        }, () => failed());
      },
      async list(input) {
        const snapshot = await getDocs(query(collection(firestore, `${projectPath(input)}/tests`), where('status', 'in', ACTIVE_STATUSES)));
        return snapshot.docs.map((item) => toCloudTest(item.id, item.data()));
      },
      async count(input) { return (await getDocs(query(collection(firestore, `${projectPath(input)}/tests`), where('status', 'in', ACTIVE_STATUSES)))).size; },
      async listSuites(input) { return (await getDocs(collection(firestore, `${projectPath(input)}/suites`))).docs.map((item) => toCloudSuite(item.id, item.data())); },
      async readSuite(input) {
        const snapshot = await getDoc(doc(firestore, `${projectPath(input)}/suites/${input.suiteId}`));
        return snapshot.exists() ? toCloudSuite(snapshot.id, snapshot.data()) : null;
      },
      async readDraftSource(input) { return (await getDoc(doc(firestore, `${projectPath(input)}/tests/${input.testId}/drafts/current`))).data()?.generation; },
      async saveDraft({ organizationId, projectId, testId, title, folder, tags, intent, generation }) {
        const draft = doc(firestore, `${projectPath({ organizationId, projectId })}/tests/${testId}/drafts/current`);
        let snapshot = await getDoc(draft);
        if (!snapshot.exists()) {
          try { await call('testDraftCreate', { organizationId, projectId, testId, title, folder, tags }); }
          catch (reason) { if (!messageOf(reason).toLowerCase().includes('already')) throw reason; }
          snapshot = await getDoc(draft);
        }
        await call('testDraftSave', { organizationId, projectId, testId, expectedRevision: Number(snapshot.data()?.revision ?? 0), intent, generation });
      },
      async rename(input) { await call('testRename', input); },
      async archive(input) { await call('testArchive', input); },
      async saveSuite(input) { await call('suiteSave', input); },
      async deleteSuite(input) { await call('suiteDelete', input); },
      async moveTest(input) { await call('suiteMoveTest', input); },
      async importPortable(input) { await call('testPortableImport', input); },
      async readPatrolVersion(input) { return toCloudPatrolVersion(input.testId, (await getDoc(doc(firestore, `${projectPath(input)}/tests/${input.testId}/versions/${input.versionId}`))).data()); },
      savePatrolVersion: (input) => call<{ versionId: string; created: boolean }>('testVersionSave', input),
    },

    runs: {
      async authorize(input) { await call('runLocalAuthorize', input); },
      async recordRun(input) { await call('runLocalSnapshotRecord', input); },
      async recordAttempt(input) { await call('testLocalAttemptRecord', input); },
    },

    reviews: {
      subscribeVersions: (input, next, failed) => onSnapshot(collection(firestore, `${projectPath(input)}/tests/${input.testId}/versions`), (snapshot) => next(snapshot.docs.map((item) => ({ id: item.id, version: Number(item.data().version), contentHash: String(item.data().contentHash) }))), () => failed()),
      subscribeComments: (input, next, failed) => onSnapshot(query(collection(firestore, `${projectPath(input)}/tests/${input.testId}/${input.local ? 'versionAnchors' : 'versions'}/${input.versionId}/comments`), orderBy('createdAt'), limit(100)), (snapshot) => next(snapshot.docs.map((item) => ({ id: item.id, body: String(item.data().body), authorUid: String(item.data().authorUid) }))), () => failed()),
      subscribeReviewers: (organizationId, next) => onSnapshot(query(collection(firestore, `organizations/${organizationId}/members`), where('status', '==', 'active')), (snapshot) => next(snapshot.docs.filter((item) => ['owner', 'admin', 'reviewer'].includes(item.data().role)).map((item) => ({ uid: item.id, role: item.data().role }))), () => next([])),
      subscribeActivity: (input, next) => onSnapshot(query(collection(firestore, `${projectPath(input)}/activity`), orderBy('at', 'desc'), limit(20)), (snapshot) => next(snapshot.docs.map((item) => ({ id: item.id, kind: String(item.data().kind), actorUid: String(item.data().actorUid) }))), () => next([])),
      async comment(input) { await call('testComment', input); },
      async assignReviewer(input) { await call('testReviewerAssign', input); },
    },

    sharing: {
      async beginRecordingShare(input) { await call('recordingShareBegin', input); },
      uploadRecordingArtifact: (input) => upload(`${projectPath(input)}/recordings/${input.recordingId}/${input.artifactId}`, input),
      async finalizeRecordingShare(input) { await call('recordingShareFinalize', input); },
      async beginFlutterShare(input) { await call('flutterSliceShareBegin', input); },
      uploadFlutterArtifact: (input) => upload(`${projectPath(input)}/flutterShares/${input.shareId}/${input.artifactId}`, input),
      async finalizeFlutterShare(input) { await call('flutterSliceShareFinalize', input); },
    },
  };
}
