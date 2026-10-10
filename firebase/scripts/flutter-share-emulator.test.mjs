import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { connectStorageEmulator, getBytes, getStorage, ref, uploadBytes } from 'firebase/storage';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha = (value) => createHash('sha256').update(value).digest('hex');
const config = { apiKey: 'demo-api-key', authDomain: 'demo-sayspec-local.firebaseapp.com', projectId: 'demo-sayspec-local', appId: '1:123:web:demo', storageBucket: 'demo-sayspec-local.appspot.com' };
async function client(label, email) {
  const app = initializeApp(config, `${label}-${Date.now()}`); const auth = getAuth(app); const db = getFirestore(app); const functions = getFunctions(app, 'europe-west1'); const storage = getStorage(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }); connectFirestoreEmulator(db, '127.0.0.1', 8080); connectFunctionsEmulator(functions, '127.0.0.1', 5001); connectStorageEmulator(storage, '127.0.0.1', 9199);
  await signInWithEmailAndPassword(auth, email, 'local-only-password'); return { app, auth, db, functions, storage };
}

const owner = await client('flutter-owner', 'outsider@sayspec.local');
const reader = await client('flutter-reader', 'tester@sayspec.local');
const outsider = await client('flutter-outsider', 'reviewer@sayspec.local');
try {
  const screenshot = Buffer.from('flutter-screenshot'); const log = Buffer.from('client-reported patrol log');
  const source = "// SAYSPEC_GENERATED\nimport 'package:patrol/patrol.dart';\nvoid main(){ patrolTest('receipt', ($) async {}); }\n";
  const manifest = {
    schemaVersion: 1, kind: 'flutter-slice', id: 'flutter_share_receipt', organizationId: 'org_rival', projectId: 'project_rival', createdByUid: 'user_outsider', includeRawAudio: false,
    capture: { id: 'flutter_capture_receipt', organizationId: 'org_rival', projectId: 'project_rival', title: 'Receipt', platform: 'android', appId: 'dev.sayspec.fixture', recorderSdkVersion: '0.9.0', recorderSchemaVersion: 1, clock: { uncertaintyMs: 5 }, events: [{ id: 'event_receipt_total' }], assertions: [{ eventId: 'event_receipt_total', confidence: 'high' }], transcript: { segments: [{ id: 'transcript_receipt', text: 'The receipt total should be twelve dollars.', evidenceEventIds: ['event_receipt_total'] }] } },
    testVersion: { id: 'patrol_test_receipt', versionId: 'patrol_version_one', version: 1, organizationId: 'org_rival', projectId: 'project_rival', recordingCaptureId: 'flutter_capture_receipt', title: 'Receipt total', relativePath: 'patrol_test/receipt_test.dart', source, contentHash: sha(source), state: 'published', dependencies: { patrol: '4.10.0' }, provider: 'codex', requirements: { platform: 'android', appId: 'dev.sayspec.fixture', entrypoint: 'patrol_test/receipt_test.dart', flutterVersion: '3.38.5', dartVersion: '3.10.4', patrolCliVersion: '4.8.0', patrolPackageVersion: '4.10.0', apiLevel: '37' } },
    attempt: { id: 'patrol_attempt_replay', testId: 'patrol_test_receipt', versionId: 'patrol_version_one', organizationId: 'org_rival', projectId: 'project_rival', testContentHash: sha(source), state: 'passed', summary: '1 Patrol test passed.', detail: '', passed: 1, failed: 0, skipped: 0, tests: [{ id: 'receipt', title: 'receipt', outcome: 'passed', durationMs: 1000, errors: [] }], clientReported: true, runner: 'desktop-local-patrol' },
    artifacts: [
      { id: 'capture_screenshot', kind: 'screenshot', sha256: sha(screenshot), byteLength: screenshot.byteLength, mimeType: 'image/png', storage: 'cloud-storage' },
      { id: 'attempt_log', kind: 'attempt', sha256: sha(log), byteLength: log.byteLength, mimeType: 'text/plain', storage: 'cloud-storage' },
    ],
  };
  const manifestHash = sha(canonicalJson(manifest));
  const begin = httpsCallable(owner.functions, 'flutterSliceShareBegin'); const finalize = httpsCallable(owner.functions, 'flutterSliceShareFinalize'); const readOwner = httpsCallable(owner.functions, 'flutterSliceShareRead');
  assert.equal((await begin({ manifest, manifestHash })).data.status, 'uploading');
  assert.equal((await begin({ manifest, manifestHash })).data.status, 'uploading', 'begin retry must be idempotent');
  const base = `organizations/org_rival/projects/project_rival/flutterShares/${manifest.id}`;
  await uploadBytes(ref(owner.storage, `${base}/capture_screenshot`), screenshot, { contentType: 'image/png', customMetadata: { organizationId: 'org_rival', projectId: 'project_rival', sha256: sha(screenshot), manifestHash } });
  await assert.rejects(finalize({ organizationId: 'org_rival', projectId: 'project_rival', shareId: manifest.id, manifestHash }), /missing or failed integrity/i);
  await uploadBytes(ref(owner.storage, `${base}/attempt_log`), log, { contentType: 'text/plain', customMetadata: { organizationId: 'org_rival', projectId: 'project_rival', sha256: sha(log), manifestHash } });
  assert.equal((await finalize({ organizationId: 'org_rival', projectId: 'project_rival', shareId: manifest.id, manifestHash })).data.status, 'shared');
  assert.equal((await finalize({ organizationId: 'org_rival', projectId: 'project_rival', shareId: manifest.id, manifestHash })).data.status, 'shared', 'finalize retry must be idempotent');
  assert.equal((await begin({ manifest, manifestHash })).data.status, 'shared', 'begin after completion must recover the receipt');
  const read = await readOwner({ organizationId: 'org_rival', projectId: 'project_rival', shareId: manifest.id });
  assert.equal(read.data.manifest.attempt.clientReported, true); assert.equal(read.data.manifest.testVersion.contentHash, sha(source));
  assert.equal((await getDoc(doc(owner.db, `organizations/org_rival/projects/project_rival/flutterShares/${manifest.id}`))).data()?.status, 'shared');
  assert.equal(new TextDecoder().decode(await getBytes(ref(reader.storage, `${base}/attempt_log`))), log.toString());
  assert.equal((await httpsCallable(reader.functions, 'flutterSliceShareRead')({ organizationId: 'org_rival', projectId: 'project_rival', shareId: manifest.id })).data.status, 'shared');
  await assert.rejects(httpsCallable(outsider.functions, 'flutterSliceShareRead')({ organizationId: 'org_rival', projectId: 'project_rival', shareId: manifest.id }), /membership|permission|access/i);
  const crossProject = { ...manifest, id: 'flutter_share_cross_project', capture: { ...manifest.capture, projectId: 'project_storefront' } };
  await assert.rejects(begin({ manifest: crossProject, manifestHash: sha(canonicalJson(crossProject)) }), /same project/i);
  const narration = Buffer.from('raw narration');
  const hiddenAudio = { ...manifest, id: 'flutter_share_hidden_audio', artifacts: [...manifest.artifacts, { id: 'raw_narration', kind: 'narration', sha256: sha(narration), byteLength: narration.byteLength, mimeType: 'audio/webm', storage: 'cloud-storage' }] };
  await assert.rejects(begin({ manifest: hiddenAudio, manifestHash: sha(canonicalJson(hiddenAudio)) }), /explicit sharing choice/i);
  await httpsCallable(owner.functions, 'memberChange')({ organizationId: 'org_rival', uid: 'user_tester', status: 'revoked' });
  await assert.rejects(httpsCallable(reader.functions, 'flutterSliceShareRead')({ organizationId: 'org_rival', projectId: 'project_rival', shareId: manifest.id }), /membership|permission|access/i);
  await assert.rejects(getBytes(ref(reader.storage, `${base}/attempt_log`)), /unauthorized|permission/i);
  console.log(JSON.stringify({ flutterShare: 'passed', sameProjectReferences: 'enforced', tenantIsolation: 'enforced', revokedAccess: 'enforced', partialUploadRecovery: 'passed', idempotentRetry: 'passed', rawAudioOptIn: 'enforced', executionClaim: 'client-reported-local' }));
} finally { await Promise.all([deleteApp(owner.app), deleteApp(reader.app), deleteApp(outsider.app)]); }
