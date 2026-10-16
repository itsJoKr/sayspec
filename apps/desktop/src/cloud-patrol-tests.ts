import { useEffect } from 'react';
import type { CloudPatrolTestVersion, PatrolSavedTest, TestLibraryScope } from '@sayspec/contracts';
import type { CloudBackend, CloudTest } from './cloud/backend';
import { useCloud } from './cloud/context';

/** Fired after a sync with `{ organizationId, projectId, tests }`, so screens listing this Mac's Flutter tests can re-read them. */
export const CLOUD_PATROL_TESTS_SYNCED = 'sayspec:cloud-patrol-tests-synced';
export type CloudPatrolSyncResult = { tests: CloudTest[]; problems: string[] };

/** Freshly uploaded Flutter tests collect here, like the Just Recorded folder of Folder storage. */
const JUST_RECORDED_SUITE = 'suite_just_recorded';

function messageOf(reason: unknown) { return reason instanceof Error ? reason.message.replace(/^(Firebase)?Error:\s*/, '') : 'The request failed.'; }

export async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A saved Patrol test as SaySpec Cloud stores it. */
export function cloudPatrolVersion(test: Pick<PatrolSavedTest, 'id' | 'title' | 'relativePath' | 'source' | 'contentHash'> & Partial<Pick<PatrolSavedTest, 'appVersion' | 'dependencies' | 'recordingCaptureId' | 'provider'>>): CloudPatrolTestVersion {
  return {
    testId: test.id, title: test.title.trim().slice(0, 160) || 'Patrol test', relativePath: test.relativePath, source: test.source, contentHash: test.contentHash,
    ...(test.appVersion ? { appVersion: test.appVersion } : {}), ...(test.dependencies ? { dependencies: test.dependencies } : {}),
    ...(test.recordingCaptureId ? { recordingId: test.recordingCaptureId } : {}), ...(test.provider ? { provider: test.provider } : {}),
  };
}

/** Adds a new test to the project's Just Recorded suite, where a fresh recording's tests wait to be sorted. */
async function addToJustRecorded(cloud: CloudBackend, scope: TestLibraryScope, testId: string, recordingId: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const suite = await cloud.tests.readSuite({ ...scope, suiteId: JUST_RECORDED_SUITE });
    if (suite?.testIds.includes(testId)) return;
    try { await cloud.tests.saveSuite({ ...scope, suiteId: JUST_RECORDED_SUITE, expectedRevision: suite?.revision ?? 0, name: 'Just Recorded', testIds: [...(suite?.testIds ?? []), testId], sourceRecordingId: recordingId }); return; }
    // Someone else changed the suite meanwhile; read it again once.
    catch (reason) { if (attempt || !messageOf(reason).includes('changed elsewhere')) throw reason; }
  }
}

async function syncOnce(cloud: CloudBackend, scope: TestLibraryScope): Promise<CloudPatrolSyncResult> {
  const problems: string[] = [];
  // Uploads go first, so a pull never replaces a newer version made on this Mac.
  for (const test of await window.sayspec!.listPendingCloudPatrolTests(scope)) {
    try {
      const saved = await cloud.tests.savePatrolVersion({ ...scope, ...cloudPatrolVersion(test) });
      await window.sayspec!.markCloudPatrolTestUploaded({ ...scope, testId: test.id, versionId: test.versionId });
      if (saved.created && test.recordingCaptureId) await addToJustRecorded(cloud, scope, test.id, test.recordingCaptureId).catch(() => undefined);
    } catch (reason) { problems.push(`“${test.title}” is only on this Mac: ${messageOf(reason)}`); }
  }
  const [tests, local] = await Promise.all([cloud.tests.list(scope), window.sayspec!.listPatrolTests(scope)]);
  const localHashes = new Map(local.map((test) => [test.id, test.contentHash]));
  const stale = tests.filter((test) => test.currentVersionId && test.currentVersionHash && localHashes.get(test.id) !== test.currentVersionHash);
  try {
    const versions = (await Promise.all(stale.map((test) => cloud.tests.readPatrolVersion({ ...scope, testId: test.id, versionId: test.currentVersionId! })))).filter((version): version is CloudPatrolTestVersion => Boolean(version));
    if (versions.length) await window.sayspec!.pullCloudPatrolTests({ ...scope, versions });
  } catch (reason) { problems.push(messageOf(reason)); }
  return { tests, problems };
}

const syncs = new Map<string, { again: boolean; promise: Promise<CloudPatrolSyncResult> }>();

/**
 * Brings a SaySpec Cloud Flutter project and this Mac in step: tests saved
 * here are uploaded, then the cloud's current versions are pulled into this
 * Mac's store, where runs read them. Nothing runs in the cloud. Resolves with
 * the project's tests as SaySpec Cloud lists them; rejects only when the cloud
 * cannot be read. A call during a sync makes that sync go round once more.
 */
export function syncCloudPatrolTests(cloud: CloudBackend, scope: TestLibraryScope): Promise<CloudPatrolSyncResult> {
  const key = `${scope.organizationId}/${scope.projectId}`;
  const current = syncs.get(key);
  if (current) { current.again = true; return current.promise; }
  const state = { again: false, promise: Promise.resolve<CloudPatrolSyncResult>({ tests: [], problems: [] }) };
  state.promise = (async () => {
    try {
      let result: CloudPatrolSyncResult;
      do { state.again = false; result = await syncOnce(cloud, scope); } while (state.again);
      window.dispatchEvent(new CustomEvent(CLOUD_PATROL_TESTS_SYNCED, { detail: { ...scope, tests: result.tests } }));
      return result;
    } finally { syncs.delete(key); }
  })();
  syncs.set(key, state);
  return state.promise;
}

/**
 * Keeps a SaySpec Cloud Flutter project's tests in step on this Mac: syncs
 * when the project opens, when a generated test is saved, and when SaySpec
 * regains focus (a teammate may have added tests meanwhile).
 */
export function useCloudPatrolTestSync(input: { enabled: boolean; organizationId: string; projectId: string }) {
  const { enabled, organizationId, projectId } = input;
  const cloud = useCloud();
  useEffect(() => {
    if (!enabled || !projectId || !cloud) return;
    const backend = cloud;
    // Failures are retried on the next trigger; the Runs view reports them.
    const sync = () => void syncCloudPatrolTests(backend, { organizationId, projectId }).catch(() => undefined);
    sync();
    const unsubscribe = window.sayspec!.onPatrolGenerationEvent((event) => { if (event.kind === 'saved') sync(); });
    window.addEventListener('focus', sync);
    return () => { unsubscribe(); window.removeEventListener('focus', sync); };
  }, [cloud, enabled, organizationId, projectId]);
}
