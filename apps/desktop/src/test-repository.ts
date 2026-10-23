import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LibraryTest, PatrolSavedTest, SavedWebTestVersion, TestLibraryScope, TestStorageMode, TestStorageSettings, TestSuite } from '@sayspec/contracts';
import type { CloudBackend, CloudPageCursor } from './cloud/backend';
import { useCloud } from './cloud/context';

export const LIBRARY_PAGE_SIZE = 25;

/** A library test plus the fields only SaySpec cloud storage has: review state and a Flutter test's current version. */
export type RepositoryTest = LibraryTest & { ownerUid?: string; reviewerUid?: string | null; reviewerRevision?: number; currentVersionId?: string };
export type SuiteSave = { suiteId: string; expectedRevision: number; name: string; testIds: string[]; sourceRecordingId?: string };
/** A test's code for reading: its files (the entry file first) and, for a Web test, the steps they carry out. */
export type TestCode = { files: { relativePath: string; text: string }[]; steps?: { instruction: string; assertion: string }[]; version?: number; savedAt?: string };

/**
 * Storage-independent access to a project's tests and suites. The library,
 * and anything else that lists or edits tests, works against this interface
 * and never against Firestore or a folder directly.
 */
export interface TestRepository {
  /** `cloud`: SaySpec Cloud (the cloud backend). `device`: Local storage on this Mac. `folder`: a storage folder. */
  kind: 'cloud' | 'device' | 'folder';
  status: 'loading' | 'ready' | 'error';
  /** The current page of tests. */
  tests: RepositoryTest[];
  suites: TestSuite[];
  page: number; hasNext: boolean;
  nextPage(): void; previousPage(): void; reload(): void;
  /** Review comments, reviewers and version anchors exist only in SaySpec cloud storage. */
  supportsReview: boolean;
  renameTest(testId: string, title: string): Promise<void>;
  deleteTest(testId: string): Promise<void>;
  /** Creates or renames a suite and resolves to its ID, which a storage folder derives from the name. */
  saveSuite(change: SuiteSave): Promise<string>;
  moveTest(testId: string, targetSuiteId: string | null): Promise<void>;
  /** The test's current code, or null when neither this Mac nor the storage has it. */
  readCode(testId: string): Promise<TestCode | null>;
}

/** Where a project's tests are read from, decided by its storage setting and whether the workspace is signed in. */
export type RepositorySource = { organizationId: string; projectId: string; signedIn: boolean; mode: TestStorageMode; targetType?: 'web' | 'flutter' };

export function useTestRepository(source: RepositorySource): TestRepository {
  const backend = useCloud();
  const cloud = Boolean(backend) && source.signedIn && source.mode === 'cloud';
  const cloudRepository = useCloudRepository(cloud ? backend : null, source.organizationId, source.projectId, source.targetType);
  const deviceRepository = useDeviceRepository(!cloud, source.organizationId, source.projectId, source.mode, source.targetType);
  return cloud ? cloudRepository : deviceRepository;
}

const patrolCode = (test: Pick<PatrolSavedTest, 'relativePath' | 'source'> & Partial<Pick<PatrolSavedTest, 'version' | 'createdAt'>>): TestCode => ({ files: [{ relativePath: test.relativePath, text: test.source }], ...(test.version ? { version: test.version } : {}), ...(test.createdAt ? { savedAt: test.createdAt } : {}) });
function webCode(test: Pick<SavedWebTestVersion, 'files' | 'steps' | 'runtime'> & Partial<Pick<SavedWebTestVersion, 'version' | 'createdAt'>>): TestCode {
  const isEntry = (file: { relativePath: string }) => file.relativePath === test.runtime.entrypoint;
  return {
    files: [...test.files.filter(isEntry), ...test.files.filter((file) => !isEntry(file))].map((file) => ({ relativePath: file.relativePath, text: file.text })),
    steps: test.steps.map((step) => ({ instruction: step.instruction, assertion: step.assertion })),
    ...(test.version ? { version: test.version } : {}), ...(test.createdAt ? { savedAt: test.createdAt } : {}),
  };
}

/** The latest code this Mac holds for a test. A storage folder is re-read first, so edits made outside SaySpec show. */
async function readLocalCode(scope: TestLibraryScope, testId: string, targetType?: 'web' | 'flutter'): Promise<TestCode | null> {
  if (targetType !== 'web') {
    const patrol = (await window.sayspec!.listPatrolTests(scope)).find((test) => test.id === testId);
    if (patrol) return patrolCode(patrol);
  }
  if (targetType !== 'flutter') {
    const web = (await window.sayspec!.listProjectWebTestVersions(scope)).filter((version) => version.testId === testId).sort((left, right) => right.version - left.version)[0];
    if (web) return webCode(web);
  }
  return null;
}

/** SaySpec Cloud storage for signed-in workspaces, paged on the server. Reviews cover Web tests only for now. */
function useCloudRepository(backend: CloudBackend | null, organizationId: string, projectId: string, targetType?: 'web' | 'flutter'): TestRepository {
  const [tests, setTests] = useState<RepositoryTest[]>([]); const [suites, setSuites] = useState<TestSuite[]>([]);
  const [status, setStatus] = useState<TestRepository['status']>('loading'); const [retryKey, setRetryKey] = useState(0);
  const [page, setPage] = useState(0); const [cursors, setCursors] = useState<Array<CloudPageCursor | null>>([null]); const [last, setLast] = useState<CloudPageCursor | null>(null);
  useEffect(() => { setPage(0); setCursors([null]); }, [organizationId, projectId]);
  useEffect(() => {
    if (!backend) return;
    return backend.tests.subscribeSuites({ organizationId, projectId }, setSuites, () => setSuites([]));
  }, [backend, organizationId, projectId]);
  useEffect(() => {
    if (!backend) return;
    setTests([]); setStatus('loading');
    return backend.tests.subscribePage({ organizationId, projectId, after: cursors[page] ?? null, size: LIBRARY_PAGE_SIZE }, (result) => {
      setTests(result.tests.map((test) => ({ ...test, projectId, status: 'generated' })));
      setLast(result.last); setStatus('ready');
    }, () => { setTests([]); setStatus('error'); });
  }, [backend, organizationId, projectId, page, retryKey, cursors]);
  const scope = { organizationId, projectId };
  return {
    kind: 'cloud', status, tests, suites, page, hasNext: tests.length >= LIBRARY_PAGE_SIZE, supportsReview: targetType !== 'flutter',
    nextPage() { if (!last || tests.length < LIBRARY_PAGE_SIZE) return; setCursors((value) => [...value.slice(0, page + 1), last]); setPage((value) => value + 1); },
    previousPage() { setPage((value) => Math.max(0, value - 1)); },
    reload() { setRetryKey((value) => value + 1); },
    async renameTest(testId, title) { await backend!.tests.rename({ ...scope, testId, title }); },
    async deleteTest(testId) { await backend!.tests.archive({ ...scope, testId }); },
    async saveSuite(change) { await backend!.tests.saveSuite({ ...scope, ...change }); return change.suiteId; },
    async moveTest(testId, targetSuiteId) { await backend!.tests.moveTest({ ...scope, testId, targetSuiteId }); },
    // This Mac's copy first, as runs use it; otherwise the version SaySpec Cloud holds, like a storage switch reads it.
    async readCode(testId) {
      const local = await readLocalCode(scope, testId, targetType);
      if (local) return local;
      if (targetType === 'flutter') {
        const versionId = tests.find((test) => test.id === testId)?.currentVersionId;
        const version = versionId ? await backend!.tests.readPatrolVersion({ ...scope, testId, versionId }) : undefined;
        return version ? patrolCode(version) : null;
      }
      const draft = await backend!.tests.readDraftSource({ ...scope, testId });
      return draft?.files.length ? webCode(draft) : null;
    },
  };
}

/** Storage on this machine, behind the desktop bridge: a storage folder, or the guest workspace. Paged locally. */
function useDeviceRepository(enabled: boolean, organizationId: string, projectId: string, mode: TestStorageMode, targetType?: 'web' | 'flutter'): TestRepository {
  const [all, setAll] = useState<LibraryTest[]>([]); const [suites, setSuites] = useState<TestSuite[]>([]);
  const [status, setStatus] = useState<TestRepository['status']>('loading'); const [page, setPage] = useState(0);
  const scope = useMemo(() => ({ organizationId, projectId }), [organizationId, projectId]);
  const load = useCallback(async () => {
    const snapshot = await window.sayspec!.getTestLibrary(scope);
    setAll(snapshot.tests); setSuites(snapshot.suites); setStatus('ready');
  }, [scope]);
  const reload = useCallback(() => { void load().catch(() => setStatus('error')); }, [load]);
  useEffect(() => { setPage(0); }, [organizationId, projectId, mode]);
  useEffect(() => {
    if (!enabled || !projectId) return;
    setStatus('loading'); reload();
    // A folder changes outside SaySpec (a git pull, an edit), so returning to the app re-reads it.
    if (mode !== 'folder') return;
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [enabled, projectId, mode, reload]);
  const lastPage = Math.max(0, Math.ceil(all.length / LIBRARY_PAGE_SIZE) - 1);
  const current = Math.min(page, lastPage);
  async function mutate<T>(action: () => Promise<T>) { const result = await action(); await load(); return result; }
  return {
    kind: mode === 'folder' ? 'folder' : 'device', status, suites, page: current,
    tests: all.slice(current * LIBRARY_PAGE_SIZE, (current + 1) * LIBRARY_PAGE_SIZE), hasNext: current < lastPage, supportsReview: false,
    nextPage() { setPage(Math.min(current + 1, lastPage)); }, previousPage() { setPage(Math.max(0, current - 1)); }, reload,
    renameTest: (testId, title) => mutate(() => window.sayspec!.renameLibraryTest({ ...scope, testId, title })),
    deleteTest: (testId) => mutate(() => window.sayspec!.deleteLibraryTest({ ...scope, testId })),
    saveSuite: async (change) => (await mutate(() => window.sayspec!.saveLibrarySuite({ ...scope, ...change, projectId }))).id,
    moveTest: (testId, targetSuiteId) => mutate(() => window.sayspec!.moveLibraryTest({ ...scope, testId, targetSuiteId })),
    readCode: (testId) => readLocalCode(scope, testId, targetType),
  };
}

/**
 * A project's test storage. A guest project's choice lives on this Mac; a
 * signed-in project's choice is shared through SaySpec Cloud (`sharedMode`) and
 * mirrored to this machine, which also remembers where a storage folder is.
 */
export function useProjectTestStorage(input: { organizationId: string; projectId: string; targetType?: 'web' | 'flutter'; sharedMode?: TestStorageMode }) {
  const { organizationId, projectId, targetType, sharedMode } = input;
  const [settings, setSettings] = useState<TestStorageSettings | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true; setSettings(null);
    if (!projectId || !targetType) return;
    const scope = { organizationId, projectId };
    const read = sharedMode ? window.sayspec!.configureTestStorage({ ...scope, targetType, mode: sharedMode }) : window.sayspec!.getTestStorage(scope);
    read.then((next) => { if (active) setSettings(next); }).catch(() => { if (active) setSettings({ projectId, mode: sharedMode ?? 'local' }); });
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener('sayspec:test-storage-changed', refresh);
    return () => { active = false; window.removeEventListener('sayspec:test-storage-changed', refresh); };
  }, [organizationId, projectId, targetType, sharedMode, revision]);
  return settings;
}

/** Tells every `useProjectTestStorage` that a project's storage changed. */
export function announceTestStorageChange() { window.dispatchEvent(new Event('sayspec:test-storage-changed')); }
