import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { collection, connectFirestoreEmulator, doc, getDoc, getDocs, getFirestore, setDoc } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const config = { apiKey: 'demo-api-key', authDomain: 'demo-sayspec-local.firebaseapp.com', projectId: 'demo-sayspec-local', appId: '1:123:web:demo' };
function client(name) {
  const app = initializeApp(config, name); const auth = getAuth(app); const db = getFirestore(app); const functions = getFunctions(app, 'europe-west1');
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080); connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  return { app, auth, db, functions };
}

const first = client(`portable-pro-first-${Date.now()}`);
const originalSource = "import { test, expect } from '@playwright/test'; test('ready', async ({ page }) => { await page.goto('/'); await expect(page.getByRole('heading', { name: 'Ready', exact: true })).toBeVisible(); });";
const files = [{ id: 'file_1', relativePath: 'tests/ready.spec.ts', text: originalSource, sha256: sha(originalSource), byteLength: Buffer.byteLength(originalSource), mimeType: 'text/typescript' }];
const steps = [{ id: 'step_1', instruction: 'Open the page.', assertion: 'The Ready heading is visible.', intentItemIds: [], transcriptSegmentIds: ['transcript_1'], evidenceEventIds: ['event_1'] }];
const runtime = { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: 'tests/ready.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, requirements: ['Node.js >=22.12.0', '@playwright/test 1.63.0', 'Playwright Chromium installed', 'Configured Web base URL'] };
const contentHash = sha(canonical({ steps, files, runtime }));
const bundle = { schemaVersion: 1, kind: 'sayspec-playwright-bundle', exportedAt: new Date().toISOString(), original: { testId: 'test_source', versionId: 'version_source', contentHash, state: 'execution-validated' }, title: 'Ready heading is visible', steps, files, runtime, secretPlaceholders: ['BASE_URL'], provenance: { provider: 'codex', cliVersion: '0.144.6', inputRevisionHash: 'a'.repeat(64), generatedAt: new Date().toISOString() } };
const scope = { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'import_callable_test' };
const draftPath = `organizations/${scope.organizationId}/projects/${scope.projectId}/tests/${scope.testId}/drafts/current`;
try {
  await signInWithEmailAndPassword(first.auth, 'tester@sayspec.local', 'local-only-password');
  const imported = await httpsCallable(first.functions, 'testPortableImport')({ ...scope, bundle });
  assert.equal(imported.data.contentHash, contentHash);
  const suiteScope = { organizationId: scope.organizationId, projectId: scope.projectId, suiteId: 'suite_callable_smoke' };
  const suite = await httpsCallable(first.functions, 'suiteSave')({ ...suiteScope, expectedRevision: 0, name: 'Smoke', testIds: [scope.testId] });
  assert.equal(suite.data.revision, 1);
  const authorized = await httpsCallable(first.functions, 'runLocalAuthorize')({ organizationId: scope.organizationId, projectId: scope.projectId, suiteId: suiteScope.suiteId, suiteRevision: 1, items: [{ testId: scope.testId, versionId: 'version_local', contentHash }] });
  assert.equal(authorized.data.authorized, true);
  await assert.rejects(httpsCallable(first.functions, 'runLocalAuthorize')({ organizationId: scope.organizationId, projectId: scope.projectId, suiteId: suiteScope.suiteId, suiteRevision: 0, items: [{ testId: scope.testId, versionId: 'version_local', contentHash }] }), /suite membership changed|aborted/i);
  const reportedRun = { schemaVersion: 1, id: 'run_11111111-1111-4111-8111-111111111111', organizationId: scope.organizationId, projectId: scope.projectId, name: 'Smoke', environmentHash: 'd'.repeat(64), items: [{ testId: scope.testId, versionId: 'version_local', contentHash, title: bundle.title }] };
  const runRecord = await httpsCallable(first.functions, 'runLocalSnapshotRecord')({ organizationId: scope.organizationId, projectId: scope.projectId, run: reportedRun });
  assert.equal(runRecord.data.attestedByServer, false);
  assert.equal((await getDoc(doc(first.db, `organizations/${scope.organizationId}/projects/${scope.projectId}/runs/${reportedRun.id}`))).data()?.clientReported, true);
  await assert.rejects(httpsCallable(first.functions, 'runLocalSnapshotRecord')({ organizationId: scope.organizationId, projectId: scope.projectId, run: { ...reportedRun, environmentHash: 'e'.repeat(64) } }), /overwritten|already-exists/i);
  await assert.rejects(httpsCallable(first.functions, 'suiteSave')({ ...suiteScope, expectedRevision: 0, name: 'Stale', testIds: [] }), /changed elsewhere|aborted/i);
  await assert.rejects(httpsCallable(first.functions, 'suiteSave')({ ...suiteScope, projectId: 'project_docs', expectedRevision: 0, name: 'Cross project', testIds: [scope.testId] }), /active tests|failed-precondition/i);
  assert.deepEqual((await getDoc(doc(first.db, `organizations/${scope.organizationId}/projects/${scope.projectId}/suites/${suiteScope.suiteId}`))).data()?.testIds, [scope.testId]);
  assert.ok((await getDocs(collection(first.db, `organizations/${scope.organizationId}/projects/${scope.projectId}/activity`))).docs.some((item) => item.data().kind === 'suite-created'));
  const assignment = await httpsCallable(first.functions, 'testReviewerAssign')({ ...scope, reviewerUid: 'user_reviewer', expectedRevision: 0 });
  assert.equal(assignment.data.revision, 1);
  await assert.rejects(httpsCallable(first.functions, 'testReviewerAssign')({ ...scope, reviewerUid: null, expectedRevision: 0 }), /changed elsewhere|aborted/i);
  const reviewer = client(`portable-pro-reviewer-${Date.now()}`);
  try {
    await signInWithEmailAndPassword(reviewer.auth, 'reviewer@sayspec.local', 'local-only-password');
    const versionId = `version_${contentHash.slice(0, 20)}`;
    const commented = await httpsCallable(reviewer.functions, 'testComment')({ ...scope, versionId, versionHash: contentHash, commentId: 'comment_review_one', body: 'Assertion and outcome reviewed.' });
    assert.equal(commented.data.commentId, 'comment_review_one');
    await assert.rejects(httpsCallable(reviewer.functions, 'testComment')({ ...scope, versionId, versionHash: 'f'.repeat(64), commentId: 'comment_bad_hash', body: 'Wrong version' }), /hash|version|failed-precondition/i);
    const anchorPath = `organizations/${scope.organizationId}/projects/${scope.projectId}/tests/${scope.testId}/versionAnchors/${versionId}`;
    assert.equal((await getDoc(doc(reviewer.db, `${anchorPath}/comments/comment_review_one`))).data()?.versionHash, contentHash);
    await httpsCallable(first.functions, 'memberChange')({ organizationId: scope.organizationId, uid: 'user_reviewer', status: 'revoked' });
    await assert.rejects(httpsCallable(reviewer.functions, 'testComment')({ ...scope, versionId, versionHash: contentHash, commentId: 'comment_revoked', body: 'Revoked' }), /permission|active/i);
    await assert.rejects(getDoc(doc(reviewer.db, anchorPath)));
  } finally { await deleteApp(reviewer.app); }
  const attempted = { schemaVersion: 1, id: 'attempt_11111111-1111-4111-8111-111111111111', ...scope, versionId: 'version_local', testVersionHash: contentHash, environmentHash: 'b'.repeat(64), executionManifestHash: 'c'.repeat(64), state: 'passed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: '1 passed locally.', detail: '', passed: 1, failed: 0, skipped: 0, tests: [{ id: 'spec_1', title: 'ready', outcome: 'passed', durationMs: 100, errors: [] }], artifacts: [], runner: 'desktop-local' };
  const recorded = await httpsCallable(first.functions, 'testLocalAttemptRecord')({ ...scope, attempt: attempted });
  assert.equal(recorded.data.clientReported, true); assert.equal(recorded.data.attestedByServer, false);
  await httpsCallable(first.functions, 'testArchive')({ ...scope });
  const delayedRun = { ...reportedRun, id: 'run_22222222-2222-4222-8222-222222222222', name: 'Delayed synchronization' };
  assert.equal((await httpsCallable(first.functions, 'runLocalSnapshotRecord')({ organizationId: scope.organizationId, projectId: scope.projectId, run: delayedRun })).data.clientReported, true);
  assert.equal((await httpsCallable(first.functions, 'testLocalAttemptRecord')({ ...scope, attempt: { ...attempted, id: 'attempt_22222222-2222-4222-8222-222222222222' } })).data.clientReported, true);
  await assert.rejects(httpsCallable(first.functions, 'runLocalAuthorize')({ organizationId: scope.organizationId, projectId: scope.projectId, items: [{ testId: scope.testId, versionId: 'version_local', contentHash }] }), /archived|failed-precondition/i);
  await assert.rejects(httpsCallable(first.functions, 'testLocalAttemptRecord')({ ...scope, attempt: attempted }), /overwritten|already-exists/i);
  await assert.rejects(setDoc(doc(first.db, `${draftPath}/attempts/${attempted.id}`), { state: 'failed' }, { merge: true }));
  assert.equal((await getDoc(doc(first.db, draftPath))).data()?.importedBundle?.files?.[0]?.text, originalSource);
  await deleteApp(first.app);
  const reopened = client(`portable-pro-reopened-${Date.now()}`);
  try {
    await signInWithEmailAndPassword(reopened.auth, 'tester@sayspec.local', 'local-only-password');
    assert.equal((await getDoc(doc(reopened.db, draftPath))).data()?.contentHash, contentHash);
    assert.equal((await getDoc(doc(reopened.db, `${draftPath}/attempts/${attempted.id}`))).data()?.clientReported, true);
    const outsider = client(`portable-pro-outsider-${Date.now()}`);
    try {
      await signInWithEmailAndPassword(outsider.auth, 'outsider@sayspec.local', 'local-only-password');
      await assert.rejects(getDoc(doc(outsider.db, draftPath)));
      await assert.rejects(httpsCallable(outsider.functions, 'testPortableImport')({ ...scope, testId: 'import_forbidden', bundle }), /permission|authoring/i);
      await assert.rejects(httpsCallable(outsider.functions, 'suiteSave')({ ...suiteScope, expectedRevision: 1, name: 'Intrusion', testIds: [] }), /permission|authoring/i);
      await assert.rejects(httpsCallable(outsider.functions, 'runLocalAuthorize')({ organizationId: scope.organizationId, projectId: scope.projectId, items: [{ testId: scope.testId, versionId: 'version_local', contentHash }] }), /permission|authoring/i);
    } finally { await deleteApp(outsider.app); }
  } finally { await deleteApp(reopened.app); }
  console.log(JSON.stringify({ callableImport: 'persisted-after-restart', localAttempt: 'immutable-client-reported', runSnapshot: 'immutable-client-reported', suiteConflict: 'rejected', crossProjectSuite: 'rejected', versionComment: 'anchored', reviewerRevocation: 'enforced', outsider: 'denied' }));
} catch (error) { try { await deleteApp(first.app); } catch { /* already deleted */ } throw error; }
