import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { connectStorageEmulator, getStorage, ref, uploadBytes } from 'firebase/storage';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

const app = initializeApp({ apiKey: 'demo-api-key', authDomain: 'demo-sayspec-local.firebaseapp.com', projectId: 'demo-sayspec-local', appId: '1:123:web:demo', storageBucket: 'demo-sayspec-local.appspot.com' }, `recording-share-${Date.now()}`);
const auth = getAuth(app); const db = getFirestore(app); const functions = getFunctions(app, 'europe-west1'); const storage = getStorage(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
connectFirestoreEmulator(db, '127.0.0.1', 8080); connectFunctionsEmulator(functions, '127.0.0.1', 5001); connectStorageEmulator(storage, '127.0.0.1', 9199);

try {
  await signInWithEmailAndPassword(auth, 'tester@sayspec.local', 'local-only-password');
  const bytes = new TextEncoder().encode('callable-recording-audio'); const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = {
    schemaVersion: '1.0.0', kind: 'recording', id: 'recording_callable_test', organizationId: 'org_northstar', projectId: 'project_storefront', createdByUid: 'user_tester', createdAt: '2026-09-20T10:00:00.000Z',
    targetType: 'web', environmentSnapshotId: 'environment_local', captureAdapter: { name: 'sayspec-playwright-chromium', version: '1.0.0' }, sessionId: 'session_callable_test', timebase: 'monotonic-ms',
    segments: [{ id: 'segment_1', startMs: 0, endMs: 1000, pausedAfter: false, audioArtifactId: 'audio_segment_1' }], events: [],
    artifacts: [{ id: 'audio_segment_1', relativePath: 'audio/segment_1.webm', sha256, byteLength: bytes.byteLength, mimeType: 'audio/webm', storage: 'cloud-storage' }], completenessWarnings: [],
  };
  const manifestHash = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
  const begin = httpsCallable(functions, 'recordingShareBegin'); const finalize = httpsCallable(functions, 'recordingShareFinalize');
  await begin({ manifest, manifestHash });
  await assert.rejects(finalize({ organizationId: manifest.organizationId, projectId: manifest.projectId, recordingId: manifest.id, manifestHash }), /missing or failed integrity/i);
  const uploadPath = `organizations/${manifest.organizationId}/projects/${manifest.projectId}/recordings/${manifest.id}/audio_segment_1`;
  await uploadBytes(ref(storage, uploadPath), bytes, { contentType: 'audio/webm', customMetadata: { organizationId: manifest.organizationId, projectId: manifest.projectId, sha256, manifestHash } });
  const result = await finalize({ organizationId: manifest.organizationId, projectId: manifest.projectId, recordingId: manifest.id, manifestHash });
  assert.equal(result.data.status, 'shared');
  assert.equal((await getDoc(doc(db, `organizations/${manifest.organizationId}/projects/${manifest.projectId}/recordings/${manifest.id}`))).data()?.status, 'shared');
  console.log(JSON.stringify({ callableShare: 'passed', missingAsset: 'not-shared', artifactIntegrity: 'validated' }));
} finally { await deleteApp(app); }
