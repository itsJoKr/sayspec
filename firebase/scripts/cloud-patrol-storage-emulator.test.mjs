import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { initializeApp as initializeClient, deleteApp as deleteClient } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, updateProfile } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, getFirestore as getClientFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// SaySpec Cloud storage of Flutter (Patrol) tests against the Auth, Firestore
// and Functions emulators: immutable versions, idempotent saves, plan and
// project checks, and Rules for teammates and outsiders. Nothing runs in the
// cloud; each Mac pulls the current version and runs it locally.
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Run through firebase emulators:exec.');
const projectId = 'demo-sayspec-local';
const config = { apiKey: 'demo-api-key', authDomain: `${projectId}.firebaseapp.com`, projectId, appId: '1:123:web:demo' };
const admin = initializeApp({ projectId }, `cloud-patrol-admin-${Date.now()}`);
const db = getFirestore(admin);
const run = Date.now().toString(36);
const apps = [];
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function person(label, displayName) {
  const app = initializeClient(config, `${label}-${run}`); apps.push(app);
  const auth = getAuth(app); const firestore = getClientFirestore(app); const functions = getFunctions(app, 'europe-west1');
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  const credential = await createUserWithEmailAndPassword(auth, `${label}.${run}@sayspec.local`, 'local-only-password');
  await updateProfile(credential.user, { displayName }); await credential.user.getIdToken(true);
  const call = (name, data) => httpsCallable(functions, name)(data).then((result) => result.data);
  return { uid: credential.user.uid, firestore, call };
}
async function rejectsWith(promise, code, pattern) {
  try { await promise; } catch (error) {
    assert.equal(String(error.code).replace(/^functions\//, ''), code, `${error.code}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
    return;
  }
  assert.fail(`Expected ${code}`);
}
const patrolSource = (label) => `import 'package:flutter_test/flutter_test.dart';\nimport 'package:patrol/patrol.dart';\n\nvoid main() {\n  patrolTest('${label}', (\$) async {\n    expect(\$('Ready'), findsOneWidget);\n  });\n}\n`;
const results = {};

try {
  const owner = await person('patrol-owner', 'Olive Owner');
  const editor = await person('patrol-editor', 'Eddie Editor');
  const outsider = await person('patrol-outsider', 'Oscar Outsider');
  const organizationId = `org_patrol_${run}`;
  await owner.call('organizationCreate', { organizationId, name: 'Mobile Team (synthetic)' });
  await owner.call('projectCreate', { organizationId, projectId: 'project_mobile', name: 'Mobile app', targetType: 'flutter', access: 'all-members' });
  await owner.call('projectCreate', { organizationId, projectId: 'project_site', name: 'Site', targetType: 'web', baseUrl: 'https://site.example.test/', access: 'all-members' });
  await owner.call('joinCodeRotate', { organizationId });
  const { code } = (await getDoc(doc(owner.firestore, `organizations/${organizationId}/private/joinCode`))).data();
  assert.equal((await editor.call('joinCodeRedeem', { code })).role, 'editor');

  const scope = { organizationId, projectId: 'project_mobile' };
  const testId = `patrol_test_${randomUUID()}`;
  const testPath = `organizations/${organizationId}/projects/project_mobile/tests/${testId}`;
  const recordingId = `flutter_capture_${randomUUID()}`;
  const first = patrolSource('checkout');
  const version = (source, extra = {}) => ({ ...scope, testId, title: 'Checkout with saved card', relativePath: 'patrol_test/checkout_test.dart', source, contentHash: sha(source), appVersion: '2.4.0+57', dependencies: { patrol: '3.11.0' }, recordingId, provider: 'codex', ...extra });

  // 1. SaySpec Cloud is a Pro feature: a Free workspace cannot store tests there.
  await rejectsWith(editor.call('testVersionSave', version(first)), 'failed-precondition', /Pro plan/);
  await db.doc(`organizations/${organizationId}`).update({ 'plan.kind': 'beta' });
  await owner.call('projectSetTestStorage', { ...scope, testStorage: 'cloud' });
  results.plan = 'Free rejected; Beta Flutter project switched to SaySpec Cloud';

  // 2. The first save creates the test and its first immutable version, with the recorded app version.
  const saved = await editor.call('testVersionSave', version(first));
  assert.deepEqual([saved.versionId, saved.version, saved.created, saved.contentHash], ['version_1', 1, true, sha(first)]);
  const test = (await getDoc(doc(owner.firestore, testPath))).data();
  assert.deepEqual([test.framework, test.status, test.currentVersionId, test.currentVersionHash, test.versionCount, test.authorLabel, test.ownerUid, test.recordingId, test.title], ['patrol', 'published', 'version_1', sha(first), 1, 'Eddie Editor', editor.uid, recordingId, 'Checkout with saved card']);
  const stored = (await getDoc(doc(owner.firestore, `${testPath}/versions/version_1`))).data();
  assert.deepEqual([stored.framework, stored.source, stored.relativePath, stored.appVersion, stored.dependencies, stored.provider, stored.publishedByUid], ['patrol', first, 'patrol_test/checkout_test.dart', '2.4.0+57', { patrol: '3.11.0' }, 'codex', editor.uid]);
  results.create = 'test and version_1 stored with source, path, app version 2.4.0+57 and Patrol pin; teammate can read both';

  // 3. Saving the current source again is a no-op; new source is a new version, and the cloud title is kept.
  assert.deepEqual(await owner.call('testVersionSave', version(first)), { testId, versionId: 'version_1', version: 1, contentHash: sha(first), created: false });
  const second = patrolSource('checkout with coupon');
  const next = await owner.call('testVersionSave', version(second, { title: 'Renamed by another Mac', appVersion: '2.5.0+60' }));
  assert.deepEqual([next.versionId, next.created], ['version_2', false]);
  const head = (await getDoc(doc(editor.firestore, testPath))).data();
  assert.deepEqual([head.currentVersionId, head.currentVersionHash, head.versionCount, head.title], ['version_2', sha(second), 2, 'Checkout with saved card']);
  assert.equal((await getDoc(doc(editor.firestore, `${testPath}/versions/version_1`))).data().source, first, 'earlier versions stay unchanged');
  assert.equal((await getDoc(doc(editor.firestore, `${testPath}/versions/version_2`))).data().appVersion, '2.5.0+60');
  results.versions = 'same source idempotent; new source makes version_2; version_1 unchanged; title kept';

  // 4. Saving a deleted test brings it back; the same source does not add a version.
  await owner.call('testArchive', { ...scope, testId });
  assert.equal((await getDoc(doc(editor.firestore, testPath))).data().status, 'archived');
  assert.equal((await editor.call('testVersionSave', version(second))).created, false);
  const restored = (await getDoc(doc(editor.firestore, testPath))).data();
  assert.deepEqual([restored.status, restored.versionCount, restored.archivedAt], ['published', 2, undefined]);
  results.restore = 'archived test restored by a save of its current source, without a new version';

  // 5. Invalid input is rejected before anything is written.
  await rejectsWith(editor.call('testVersionSave', { ...version(second), contentHash: 'f'.repeat(64) }), 'invalid-argument', /hash/);
  await rejectsWith(editor.call('testVersionSave', version("void main() { print('not patrol'); }")), 'invalid-argument', /Patrol test/);
  await rejectsWith(editor.call('testVersionSave', version(second, { relativePath: 'lib/checkout_test.dart' })), 'invalid-argument', /patrol_test/);
  await rejectsWith(editor.call('testVersionSave', version(second, { relativePath: 'patrol_test/../lib/main.dart' })), 'invalid-argument', /patrol_test/);
  await rejectsWith(editor.call('testVersionSave', version(second, { appVersion: '2.4.0 beta' })), 'invalid-argument', /App version/);
  await rejectsWith(editor.call('testVersionSave', version(second, { dependencies: { patrol: 3 } })), 'invalid-argument', /Dependency/);
  await rejectsWith(editor.call('testVersionSave', version(second, { title: '' })), 'invalid-argument', /title/);
  await rejectsWith(editor.call('testVersionSave', { ...version(second), projectId: 'project_site' }), 'failed-precondition', /Flutter projects/);
  assert.equal((await getDoc(doc(editor.firestore, testPath))).data().versionCount, 2);
  results.validation = 'bad hash, non-Patrol source, path outside patrol_test/, bad app version or pins, empty title and Web project rejected';

  // 6. Someone outside the workspace can neither save nor read.
  await rejectsWith(outsider.call('testVersionSave', { ...version(patrolSource('intruder')), testId: 'patrol_test_intruder' }), 'permission-denied');
  await assert.rejects(getDoc(doc(outsider.firestore, `${testPath}/versions/version_2`)), /permission|PERMISSION_DENIED|insufficient/i);
  results.access = 'outsider save denied by the callable and read denied by Rules';

  console.log(`CLOUD_PATROL_STORAGE=${JSON.stringify(results)}`);
} finally {
  await Promise.all(apps.map((app) => deleteClient(app)));
  await deleteApp(admin);
}
