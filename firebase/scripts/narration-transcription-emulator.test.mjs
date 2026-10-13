import assert from 'node:assert/strict';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { initializeApp, deleteApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Refusing to run without FIRESTORE_EMULATOR_HOST.');

// Minimal Ogg/Opus: OpusHead, OpusTags and one audio page whose granule
// position sets the duration. The function reads only the container timing;
// the emulator transcriber never decodes audio. CRCs are not checked.
function page({ serial, sequence, granule, headerType, body }) {
  const lacing = []; let left = body.length;
  while (left >= 255) { lacing.push(255); left -= 255; }
  lacing.push(left);
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'latin1'); header[5] = headerType; header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial, 14); header.writeUInt32LE(sequence, 18); header[26] = lacing.length;
  lacing.forEach((value, index) => { header[27 + index] = value; });
  return Buffer.concat([header, body]);
}
function oggOpus(durationMs, serial = 0x5a5a) {
  const head = Buffer.alloc(19); head.write('OpusHead', 0, 'latin1'); head[8] = 1; head[9] = 1; head.writeUInt16LE(312, 10); head.writeUInt32LE(16_000, 12);
  const tags = Buffer.concat([Buffer.from('OpusTags', 'latin1'), Buffer.alloc(8)]);
  return Buffer.concat([
    page({ serial, sequence: 0, granule: 0, headerType: 0x02, body: head }),
    page({ serial, sequence: 1, granule: 0, headerType: 0, body: tags }),
    page({ serial, sequence: 2, granule: 312 + durationMs * 48, headerType: 0x04, body: Buffer.alloc(300, 0x11) }),
  ]).toString('base64');
}
const minutes = (value) => value * 60_000;
const rejectsWith = (promise, code, reason) => assert.rejects(promise, (error) => {
  assert.equal(error.code, `functions/${code}`, error.message);
  if (reason) assert.equal(error.details?.reason, reason);
  return true;
});

const admin = initializeAdminApp({ projectId: 'demo-sayspec-local' }, `transcription-admin-${Date.now()}`);
const adminDb = getAdminFirestore(admin);
const app = initializeApp({ apiKey: 'demo-api-key', authDomain: 'demo-sayspec-local.firebaseapp.com', projectId: 'demo-sayspec-local', appId: '1:123:web:demo' }, `transcription-${Date.now()}`);
const auth = getAuth(app); const db = getFirestore(app); const functions = getFunctions(app, 'europe-west1');
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
connectFirestoreEmulator(db, '127.0.0.1', 8080); connectFunctionsEmulator(functions, '127.0.0.1', 5001);
const transcribe = httpsCallable(functions, 'narrationTranscribe', { timeout: 60_000 });
const storefront = { organizationId: 'org_northstar', projectId: 'project_storefront', mimeType: 'audio/ogg' };
const period = new Date().toISOString().slice(0, 7);

try {
  await rejectsWith(transcribe({ ...storefront, audio: oggOpus(minutes(1)) }), 'unauthenticated');

  await signInWithEmailAndPassword(auth, 'tester@sayspec.local', 'local-only-password');
  await rejectsWith(transcribe({ ...storefront, audio: oggOpus(minutes(1)) }), 'failed-precondition', 'plan-required');

  await adminDb.doc('organizations/org_northstar').update({ 'plan.kind': 'beta' });
  const first = await transcribe({ ...storefront, audio: oggOpus(minutes(20)) });
  assert.equal(first.data.model, 'emulator'); assert.equal(first.data.language, 'en'); assert.equal(first.data.durationMs, minutes(20));
  assert.deepEqual(first.data.segments.map((item) => item.text), ['Open the sign in page.', 'The welcome message should show the user name.']);
  assert.deepEqual(first.data.segments.map((item) => [item.startMs, item.endMs]), [[0, 4_000], [5_000, 9_000]]);
  assert.deepEqual(first.data.allowance, { usedMinutes: 20, limitMinutes: 45 });

  await rejectsWith(transcribe({ ...storefront, audio: oggOpus(minutes(26)) }), 'failed-precondition', 'too-long');
  await rejectsWith(transcribe({ ...storefront, audio: Buffer.from('not an ogg file').toString('base64') }), 'invalid-argument');
  await rejectsWith(transcribe({ ...storefront, audio: oggOpus(minutes(1)), mimeType: 'audio/webm' }), 'invalid-argument');

  // A provider failure refunds the reserved minutes.
  await rejectsWith(transcribe({ ...storefront, audio: oggOpus(minutes(10), 0xfa11) }), 'unavailable');
  assert.equal((await adminDb.doc(`organizations/org_northstar/usage/transcription-${period}`).get()).data()?.usedMs, minutes(20));

  assert.deepEqual((await transcribe({ ...storefront, audio: oggOpus(minutes(20)) })).data.allowance, { usedMinutes: 40, limitMinutes: 45 });
  await rejectsWith(transcribe({ ...storefront, audio: oggOpus(minutes(10)) }), 'resource-exhausted', 'allowance-exhausted');

  // Usage is server-owned: members cannot read or forge it.
  await assert.rejects(getDoc(doc(db, `organizations/org_northstar/usage/transcription-${period}`)), /permission/i);

  // A viewer in another workspace, and a reviewer without authoring rights, cannot spend the allowance.
  await rejectsWith(transcribe({ organizationId: 'org_rival', projectId: 'project_rival', mimeType: 'audio/ogg', audio: oggOpus(minutes(1)) }), 'permission-denied');
  await signOut(auth);
  await signInWithEmailAndPassword(auth, 'reviewer@sayspec.local', 'local-only-password');
  await rejectsWith(transcribe({ ...storefront, audio: oggOpus(minutes(1)) }), 'permission-denied');

  console.log(JSON.stringify({ narrationTranscription: 'passed', planGate: 'enforced', durationCap: 'enforced', refundOnFailure: 'verified', allowance: 'enforced', usageRules: 'server-only', roles: 'enforced' }));
} finally {
  await adminDb.doc('organizations/org_northstar').update({ 'plan.kind': 'free' }).catch(() => undefined);
  await deleteApp(app); await deleteAdminApp(admin);
}
