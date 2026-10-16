import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc } from 'firebase/firestore';
import { getBytes, getMetadata, ref, uploadBytes } from 'firebase/storage';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  acceptInvitation, beginRecordingShare, changeMemberRole, configureProject, createInvitation, createOrganization,
  createProject, createTestDraft, deleteProject, importPortableTest, publishTestDraft, recordLocalTestAttempt, renameTest, saveTestDraft, setProjectGrant,
  finalizeRecordingShare, recordingManifestHash,
} from '../functions/lib/commands.js';

const projectId = 'demo-sayspec-local';
const parseHost = (value, fallbackPort) => { const [host = '127.0.0.1', port = fallbackPort] = (value ?? '').split(':'); return { host, port: Number(port) }; };
const firestoreHost = parseHost(process.env.FIRESTORE_EMULATOR_HOST, 8080);
const storageHost = parseHost(process.env.FIREBASE_STORAGE_EMULATOR_HOST, 9199);
const testEnv = await initializeTestEnvironment({
  projectId,
  firestore: { ...firestoreHost, rules: await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  storage: { ...storageHost, rules: await readFile(new URL('../../storage.rules', import.meta.url), 'utf8') },
});
const adminApp = initializeApp({ projectId }, `rules-admin-${Date.now()}`);
const adminDb = getFirestore(adminApp);
const owner = { uid: 'user_tester', email: 'tester@sayspec.local' };
const reviewer = { uid: 'user_reviewer', email: 'reviewer@sayspec.local' };
const outsider = { uid: 'user_outsider', email: 'outsider@sayspec.local' };
const tokenHash = 'a'.repeat(64);

try {
  await createOrganization(adminDb, owner, { organizationId: 'org_northstar', name: 'Northstar QA (synthetic)' });
  await createInvitation(adminDb, owner, { organizationId: 'org_northstar', invitationId: 'invite_reviewer', email: reviewer.email, role: 'reviewer', tokenHash, expiresAt: new Date(Date.now() + 60_000) });
  await assert.rejects(acceptInvitation(adminDb, outsider, { organizationId: 'org_northstar', invitationId: 'invite_reviewer', tokenHash }), /does not belong/);
  await acceptInvitation(adminDb, reviewer, { organizationId: 'org_northstar', invitationId: 'invite_reviewer', tokenHash });
  await assert.rejects(acceptInvitation(adminDb, reviewer, { organizationId: 'org_northstar', invitationId: 'invite_reviewer', tokenHash }), /already used/);
  await createProject(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', name: 'Storefront', targetType: 'web', baseUrl: 'http://127.0.0.1:4173', access: 'restricted' });
  await configureProject(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', baseUrl: 'http://127.0.0.1:4174' });
  assert.equal((await adminDb.doc('organizations/org_northstar/projects/project_storefront').get()).data()?.baseUrl, 'http://127.0.0.1:4174/');
  assert.equal((await adminDb.doc('userScopes/user_tester/organizations/org_northstar/projects/project_storefront').get()).data()?.baseUrl, 'http://127.0.0.1:4174/');
  // Desktop builds up to v0.10.0 send the URL inside `environment`.
  await configureProject(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', targetType: 'web', environment: { id: 'environment_local', name: 'Local', baseUrl: 'http://127.0.0.1:4173' } });
  assert.equal((await adminDb.doc('organizations/org_northstar/projects/project_storefront').get()).data()?.baseUrl, 'http://127.0.0.1:4173/');
  await assert.rejects(configureProject(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', baseUrl: 'ftp://user:secret@example.test' }), /HTTP\(S\)/);
  await setProjectGrant(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', uid: reviewer.uid, access: 'reviewer' });
  await createTestDraft(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_manual', title: 'Manual checkout' });
  const createdTest = (await adminDb.doc('organizations/org_northstar/projects/project_storefront/tests/test_manual').get()).data();
  assert.equal(createdTest?.ownerUid, owner.uid);
  assert.equal(createdTest?.authorLabel, owner.email);
  const intent = { prerequisites: ['A cart has one item'], steps: [{ action: 'Open checkout', target: 'Checkout button', expectedOutcome: 'The shipping form appears', allowedVariation: 'Copy may vary' }] };
  assert.deepEqual(await saveTestDraft(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_manual', expectedRevision: 0, intent }), { testId: 'test_manual', revision: 1 });
  await assert.rejects(saveTestDraft(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_manual', expectedRevision: 0, intent }), /Draft conflict/);
  const sourceText = "import { test } from '@playwright/test';";
  const sourceHash = createHash('sha256').update(sourceText).digest('hex');
  const publication = await publishTestDraft(adminDb, reviewer, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_manual', expectedRevision: 1, files: [{ id: 'file_test', relativePath: 'tests/manual.spec.ts', text: sourceText, sha256: sourceHash, mimeType: 'text/typescript' }] });
  assert.equal(publication.version, 1);
  await renameTest(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_manual', title: 'Checkout from recording' });
  assert.equal((await adminDb.doc('organizations/org_northstar/projects/project_storefront/tests/test_manual').get()).data()?.normalizedTitle, 'checkout from recording');
  await assert.rejects(publishTestDraft(adminDb, reviewer, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_manual', expectedRevision: 1, files: [{ id: 'file_bad', relativePath: '../escape.ts', text: sourceText, sha256: sourceHash, mimeType: 'text/typescript' }] }), /unsafe/);
  assert.equal((await adminDb.doc('organizations/org_northstar/projects/project_storefront/tests/test_manual/versions/version_2').get()).exists, false);
  await createTestDraft(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_definition', title: 'Definition only' });
  await saveTestDraft(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_definition', expectedRevision: 0, intent });
  await publishTestDraft(adminDb, reviewer, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_definition', expectedRevision: 1 });
  const generatedSource = "import { test, expect } from '@playwright/test'; test('generated', async ({ page }) => { await expect(page).toHaveURL(/checkout/); });";
  const generatedDraft = {
    schemaVersion: 1, id: 'generation_cloud', organizationId: 'org_northstar', projectId: 'project_storefront', recordingId: 'recording_cloud', state: 'draft', title: 'Generated checkout',
    steps: [{ id: 'step_checkout', instruction: 'Open checkout.', assertion: 'Checkout URL is visible.', intentItemIds: ['intent_checkout'], transcriptSegmentIds: ['transcript_checkout'], evidenceEventIds: ['event_checkout'] }],
    files: [{ id: 'file_1', relativePath: 'tests/generated.spec.ts', text: generatedSource, byteLength: Buffer.byteLength(generatedSource), sha256: createHash('sha256').update(generatedSource).digest('hex'), mimeType: 'text/typescript' }],
    runtime: { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: 'tests/generated.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, requirements: ['Node.js >=22.12.0'] },
    unresolvedQuestions: [], warnings: ['Generated draft has not been executed or published.'],
    provenance: { provider: 'codex', cliVersion: '0.144.6', generatedAt: '2026-09-20T10:00:00.000Z', inputRevisionHash: 'b'.repeat(64), recordingId: 'recording_cloud', intentUpdatedAt: '2026-09-20T10:00:00.000Z', selectedEvidenceEventIds: ['event_checkout'], executionValidated: false, published: false },
  };
  await createTestDraft(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_generated', title: 'Generated checkout' });
  await saveTestDraft(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_generated', expectedRevision: 0, intent, generation: generatedDraft });
  const storedGeneratedDraft = (await adminDb.doc('organizations/org_northstar/projects/project_storefront/tests/test_generated/drafts/current').get()).data();
  assert.equal(storedGeneratedDraft?.generation?.provenance?.published, false);
  assert.equal(storedGeneratedDraft?.generation?.files?.[0]?.sha256, generatedDraft.files[0].sha256);
  await assert.rejects(saveTestDraft(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_generated', expectedRevision: 1, intent, generation: { ...generatedDraft, provenance: { ...generatedDraft.provenance, executionValidated: true } } }), /invalid/);
  const validatedDraft = { ...generatedDraft, provenance: { ...generatedDraft.provenance, executionValidated: true }, validation: { status: 'passed', attempts: 2, passed: 1, failed: 0, summary: '1 Playwright test passed.', validatedAt: '2026-09-21T09:00:00.000Z' } };
  await saveTestDraft(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_generated', expectedRevision: 1, intent, generation: validatedDraft });
  assert.equal((await adminDb.doc('organizations/org_northstar/projects/project_storefront/tests/test_generated/drafts/current').get()).data()?.generation?.provenance?.executionValidated, true);
  await assert.rejects(saveTestDraft(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_generated', expectedRevision: 2, intent, generation: { ...generatedDraft, files: [{ ...generatedDraft.files[0], relativePath: '../application.ts' }], runtime: { ...generatedDraft.runtime, entrypoint: '../application.ts' } } }), /invalid/);
  const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const generatedHash = createHash('sha256').update(canonical({ steps: validatedDraft.steps, files: validatedDraft.files, runtime: validatedDraft.runtime })).digest('hex');
  const localAttempt = { schemaVersion: 1, id: 'attempt_11111111-1111-4111-8111-111111111111', organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_generated', versionId: 'version_local', testVersionHash: generatedHash,
    environmentHash: 'c'.repeat(64), executionManifestHash: 'd'.repeat(64), state: 'failed', startedAt: '2026-09-21T10:00:00.000Z', finishedAt: '2026-09-21T10:00:01.000Z', summary: '1 test failed.', detail: 'Expected checkout URL.', passed: 0, failed: 1, skipped: 0, tests: [{ id: 'spec_1', title: 'Checkout', outcome: 'failed', durationMs: 1000, errors: ['Expected checkout URL.'] }], artifacts: [], runner: 'desktop-local' };
  const cloudAttempt = await recordLocalTestAttempt(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_generated', attempt: localAttempt });
  assert.equal(cloudAttempt.clientReported, true); assert.equal(cloudAttempt.attestedByServer, false);
  await assert.rejects(recordLocalTestAttempt(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_generated', attempt: localAttempt }), /overwritten/);
  await assert.rejects(recordLocalTestAttempt(adminDb, outsider, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_generated', attempt: { ...localAttempt, id: 'attempt_22222222-2222-4222-8222-222222222222' } }), /authoring requires/i);
  await assert.rejects(recordLocalTestAttempt(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'test_generated', attempt: { ...localAttempt, id: 'attempt_33333333-3333-4333-8333-333333333333', testVersionHash: 'f'.repeat(64) } }), /source hash/);
  const portableRuntime = { ...validatedDraft.runtime, requirements: ['Node.js >=22.12.0', '@playwright/test 1.63.0', 'Playwright Chromium installed', 'Configured Web base URL'] };
  const portableHash = createHash('sha256').update(canonical({ steps: validatedDraft.steps, files: validatedDraft.files, runtime: portableRuntime })).digest('hex');
  const bundle = { schemaVersion: 1, kind: 'sayspec-playwright-bundle', exportedAt: '2026-09-21T10:00:00.000Z', original: { testId: 'test_generated', versionId: 'version_local', contentHash: portableHash, state: 'execution-validated' }, title: 'Imported checkout', steps: validatedDraft.steps, files: validatedDraft.files, runtime: portableRuntime, secretPlaceholders: ['BASE_URL'], provenance: { provider: 'codex', cliVersion: '0.144.6', inputRevisionHash: 'b'.repeat(64), generatedAt: '2026-09-21T09:00:00.000Z' } };
  await importPortableTest(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'import_cloud_test', bundle });
  assert.equal((await adminDb.doc('organizations/org_northstar/projects/project_storefront/tests/import_cloud_test/drafts/current').get()).data()?.importedBundle?.files?.[0]?.text, generatedSource);
  await assert.rejects(importPortableTest(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'import_cloud_test', bundle }), /overwrite/);
  await assert.rejects(importPortableTest(adminDb, outsider, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'import_outsider', bundle }), /authoring requires/i);
  await assert.rejects(importPortableTest(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', testId: 'import_traversal', bundle: { ...bundle, files: [{ ...bundle.files[0], relativePath: '../escape.spec.ts' }] } }), /path|hash/);
  await createOrganization(adminDb, outsider, { organizationId: 'org_rival', name: 'Rival Labs (synthetic)' });
  await createProject(adminDb, outsider, { organizationId: 'org_rival', projectId: 'project_rival', name: 'Rival app', targetType: 'flutter', access: 'all-members' });
  await adminDb.doc('organizations/org_northstar/projects/project_storefront/tests/test_checkout').set({ organizationId: 'org_northstar', projectId: 'project_storefront', title: 'Checkout' });
  await assert.rejects(configureProject(adminDb, outsider, { organizationId: 'org_rival', projectId: 'project_rival', baseUrl: 'https://example.test' }), /Only Web projects/);
  // A v0.10.0 Flutter save is accepted and stores nothing.
  await configureProject(adminDb, outsider, { organizationId: 'org_rival', projectId: 'project_rival', targetType: 'flutter', environment: { id: 'environment_local', name: 'Local acceptance', appId: 'dev.sayspec.fixture', flavor: 'development' } });
  assert.equal((await adminDb.doc('organizations/org_rival/projects/project_rival/environments/environment_local').get()).exists, false);

  const ownerDb = testEnv.authenticatedContext(owner.uid, { email: owner.email }).firestore();
  const reviewerDb = testEnv.authenticatedContext(reviewer.uid, { email: reviewer.email }).firestore();
  const outsiderDb = testEnv.authenticatedContext(outsider.uid, { email: outsider.email }).firestore();
  const testPath = 'organizations/org_northstar/projects/project_storefront/tests/test_checkout';
  const generatedDraftPath = 'organizations/org_northstar/projects/project_storefront/tests/test_generated/drafts/current';
  await assertSucceeds(getDoc(doc(ownerDb, testPath)));
  await assertSucceeds(getDoc(doc(ownerDb, generatedDraftPath)));
  await assertSucceeds(getDoc(doc(reviewerDb, testPath)));
  await assertSucceeds(getDoc(doc(reviewerDb, 'userScopes/user_reviewer/organizations/org_northstar')));
  await assertSucceeds(getDoc(doc(reviewerDb, 'userScopes/user_reviewer/organizations/org_northstar/projects/project_storefront')));
  await assertFails(getDoc(doc(outsiderDb, testPath)));
  await assertFails(getDoc(doc(outsiderDb, generatedDraftPath)));
  await assertFails(getDoc(doc(outsiderDb, 'organizations/org_northstar/projects/project_storefront/tests/import_cloud_test/drafts/current')));
  await assertFails(setDoc(doc(ownerDb, 'organizations/org_northstar/projects/project_storefront/tests/test_generated/drafts/current/attempts/attempt_11111111-1111-4111-8111-111111111111'), { state: 'passed' }, { merge: true }));
  await assertFails(getDoc(doc(outsiderDb, 'userScopes/user_reviewer/organizations/org_northstar')));
  await assertFails(getDoc(doc(ownerDb, 'organizations/org_rival/projects/project_rival')));
  await assertFails(setDoc(doc(reviewerDb, 'organizations/org_northstar/members/user_reviewer'), { role: 'owner', status: 'active' }, { merge: true }));
  await assertFails(setDoc(doc(reviewerDb, 'userScopes/user_reviewer/organizations/org_northstar'), { role: 'owner' }, { merge: true }));
  await assertFails(setDoc(doc(ownerDb, 'organizations/org_northstar/projects/project_storefront'), { organizationId: 'org_rival' }, { merge: true }));
  await assertFails(setDoc(doc(ownerDb, 'organizations/org_northstar/projects/project_storefront/environments/environment_local'), { baseUrl: 'https://forged.invalid' }, { merge: true }));
  await assertFails(setDoc(doc(ownerDb, generatedDraftPath), { generation: { provenance: { published: true } } }, { merge: true }));
  await assertFails(setDoc(doc(ownerDb, 'organizations/org_northstar/projects/project_storefront/tests/test_manual/versions/version_1'), { contentHash: 'f'.repeat(64) }, { merge: true }));

  const bulk = adminDb.bulkWriter();
  for (let index = 0; index < 5000; index += 1) {
    const id = `fixture_${String(index).padStart(4, '0')}`;
    bulk.set(adminDb.doc(`organizations/org_northstar/projects/project_storefront/tests/${id}`), { id, organizationId: 'org_northstar', projectId: 'project_storefront', title: `Fixture ${String(index).padStart(4, '0')}`, normalizedTitle: `fixture ${String(index).padStart(4, '0')}`, folder: 'Scale', tags: ['fixture'], ownerUid: owner.uid, status: 'draft', versionCount: 0 });
  }
  await bulk.close();
  const firstPage = await assertSucceeds(getDocs(query(collection(ownerDb, 'organizations/org_northstar/projects/project_storefront/tests'), orderBy('normalizedTitle'), limit(25))));
  assert.equal(firstPage.size, 25);
  const cleanupBulk = adminDb.bulkWriter();
  for (let index = 0; index < 5000; index += 1) cleanupBulk.delete(adminDb.doc(`organizations/org_northstar/projects/project_storefront/tests/fixture_${String(index).padStart(4, '0')}`));
  await cleanupBulk.close();

  const ownerStorage = testEnv.authenticatedContext(owner.uid, { email: owner.email }).storage('demo-sayspec-local.appspot.com');
  const outsiderStorage = testEnv.authenticatedContext(outsider.uid, { email: outsider.email }).storage('demo-sayspec-local.appspot.com');
  const objectPath = 'organizations/org_northstar/projects/project_storefront/evidence/result_01/screenshot.png';
  const bytes = new TextEncoder().encode('synthetic-image');
  await assertSucceeds(uploadBytes(ref(ownerStorage, objectPath), bytes, { customMetadata: { organizationId: 'org_northstar', projectId: 'project_storefront' } }));
  await assertFails(getBytes(ref(outsiderStorage, objectPath)));
  await assertFails(uploadBytes(ref(ownerStorage, 'organizations/org_northstar/projects/project_storefront/evidence/result_01/forged.png'), bytes, { customMetadata: { organizationId: 'org_rival', projectId: 'project_storefront' } }));

  const recordingBytes = new TextEncoder().encode('synthetic-recording-audio');
  const recordingSha = createHash('sha256').update(recordingBytes).digest('hex');
  const recordingManifest = {
    schemaVersion: '1.0.0', kind: 'recording', id: 'recording_cloud_test', organizationId: 'org_northstar', projectId: 'project_storefront', createdByUid: owner.uid, createdAt: '2026-09-20T10:00:00.000Z',
    targetType: 'web', environmentSnapshotId: 'environment_local', captureAdapter: { name: 'sayspec-playwright-chromium', version: '1.0.0' }, sessionId: 'session_cloud_test', timebase: 'monotonic-ms',
    segments: [{ id: 'segment_1', startMs: 0, endMs: 1000, pausedAfter: false, audioArtifactId: 'audio_segment_1' }], events: [],
    artifacts: [{ id: 'audio_segment_1', relativePath: 'audio/segment_1.webm', sha256: recordingSha, byteLength: recordingBytes.byteLength, mimeType: 'audio/webm', storage: 'cloud-storage' }], completenessWarnings: [],
  };
  const recordingHash = recordingManifestHash(recordingManifest);
  await beginRecordingShare(adminDb, owner, { manifest: recordingManifest, manifestHash: recordingHash });
  const recordingPath = 'organizations/org_northstar/projects/project_storefront/recordings/recording_cloud_test/audio_segment_1';
  const metadataFor = async (path) => {
    try {
      const metadata = await getMetadata(ref(ownerStorage, path));
      return { byteLength: metadata.size, sha256: metadata.customMetadata?.sha256, organizationId: metadata.customMetadata?.organizationId, projectId: metadata.customMetadata?.projectId };
    } catch { return null; }
  };
  await assert.rejects(finalizeRecordingShare(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', recordingId: 'recording_cloud_test', manifestHash: recordingHash }, metadataFor), /missing or failed integrity/);
  assert.equal((await adminDb.doc('organizations/org_northstar/projects/project_storefront/recordings/recording_cloud_test').get()).data()?.status, 'uploading');
  await uploadBytes(ref(ownerStorage, recordingPath), recordingBytes, { customMetadata: { organizationId: 'org_northstar', projectId: 'project_storefront', sha256: recordingSha, manifestHash: recordingHash } });
  await finalizeRecordingShare(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_storefront', recordingId: 'recording_cloud_test', manifestHash: recordingHash }, metadataFor);
  assert.equal((await adminDb.doc('organizations/org_northstar/projects/project_storefront/recordings/recording_cloud_test').get()).data()?.status, 'shared');
  await assert.rejects(beginRecordingShare(adminDb, owner, { manifest: { ...recordingManifest, completenessWarnings: ['changed'] }, manifestHash: recordingManifestHash({ ...recordingManifest, completenessWarnings: ['changed'] }) }), /manifest changed/);

  const reviewerManifest = { ...recordingManifest, id: 'recording_revoke_test', sessionId: 'session_revoke_test', createdByUid: reviewer.uid };
  const reviewerHash = recordingManifestHash(reviewerManifest);
  await changeMemberRole(adminDb, owner, { organizationId: 'org_northstar', uid: reviewer.uid, role: 'editor' });
  await beginRecordingShare(adminDb, reviewer, { manifest: reviewerManifest, manifestHash: reviewerHash });

  await assert.rejects(changeMemberRole(adminDb, owner, { organizationId: 'org_northstar', uid: owner.uid, status: 'revoked' }), /last owner/);
  await changeMemberRole(adminDb, owner, { organizationId: 'org_northstar', uid: reviewer.uid, status: 'revoked' });
  await assertFails(getDoc(doc(reviewerDb, testPath)));
  await assertFails(getBytes(ref(testEnv.authenticatedContext(reviewer.uid).storage('demo-sayspec-local.appspot.com'), objectPath)));
  await assert.rejects(finalizeRecordingShare(adminDb, reviewer, { organizationId: 'org_northstar', projectId: 'project_storefront', recordingId: 'recording_revoke_test', manifestHash: reviewerHash }, async () => null), /authoring requires/i);

  assert.equal((await adminDb.doc('organizations/org_northstar/members/user_reviewer').get()).data()?.status, 'revoked');
  assert.equal((await adminDb.doc('userScopes/user_reviewer/organizations/org_northstar').get()).exists, false);

  await createProject(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_doomed', name: 'Doomed', targetType: 'web', baseUrl: 'https://example.test', access: 'all-members' });
  await createTestDraft(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_doomed', testId: 'test_doomed', title: 'Doomed test' });
  await assert.rejects(deleteProject(adminDb, outsider, { organizationId: 'org_northstar', projectId: 'project_doomed' }), /owner or admin/);
  await deleteProject(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_doomed' });
  assert.equal((await adminDb.doc('organizations/org_northstar/projects/project_doomed').get()).exists, false);
  assert.equal((await adminDb.doc('organizations/org_northstar/projects/project_doomed/tests/test_doomed').get()).exists, false);
  assert.equal((await adminDb.doc('userScopes/user_tester/organizations/org_northstar/projects/project_doomed').get()).exists, false);
  assert.equal((await adminDb.doc('organizations/org_northstar/projects/project_storefront').get()).exists, true);
  await assert.rejects(deleteProject(adminDb, owner, { organizationId: 'org_northstar', projectId: 'project_doomed' }), /does not exist/);
  console.log(JSON.stringify({ invitationReplay: 'rejected', crossTenantRead: 'rejected', privateScopeIndex: 'enforced', selfPromotion: 'rejected', forgedParent: 'rejected', invalidBaseUrl: 'rejected', flutterBaseUrl: 'rejected', legacyFlutterSettings: 'ignored', draftConflict: 'explicit', generatedDraft: 'persisted-unpublished', generatedTraversal: 'rejected', portableImport: 'authorized-no-overwrite', localAttempt: 'immutable-client-reported', rename: 'command-only', unsafeSource: 'rejected', immutableVersion: 'enforced', definitionOnly: 'published', fiveThousandPagination: firstPage.size, storageIsolation: 'passed', recordingMissingAsset: 'not-shared', recordingIntegrity: 'shared-after-validation', recordingManifestConflict: 'rejected', recordingRevocation: 'enforced', lastOwner: 'protected', revocation: 'enforced', projectDelete: 'cascaded' }));
} finally {
  await testEnv.cleanup();
  await deleteApp(adminApp);
}
