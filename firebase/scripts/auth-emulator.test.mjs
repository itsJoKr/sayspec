import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, inMemoryPersistence, setPersistence, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { initializeApp as initializeAdminApp, deleteApp as deleteAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';

const fixtures = JSON.parse(await readFile(new URL('../fixtures/tenants.json', import.meta.url), 'utf8'));
const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
process.env.FIREBASE_AUTH_EMULATOR_HOST = host;
const config = { apiKey: 'demo-api-key', authDomain: 'demo-sayspec-local.firebaseapp.com', projectId: fixtures.projectId, appId: '1:1234567890:web:demo' };

const app = initializeApp(config, `auth-test-${Date.now()}`);
const auth = getAuth(app);
connectAuthEmulator(auth, `http://${host}`, { disableWarnings: true });
await setPersistence(auth, inMemoryPersistence);
const adminApp = initializeAdminApp({ projectId: fixtures.projectId }, `auth-admin-${Date.now()}`);
const adminAuth = getAdminAuth(adminApp);

const credential = await signInWithEmailAndPassword(auth, 'tester@sayspec.local', fixtures.password);
assert.equal(credential.user.uid, 'user_tester');
assert.ok((await credential.user.getIdToken()).length > 100);
await adminAuth.updateUser('user_tester', { disabled: true });
await assert.rejects(credential.user.getIdToken(true), /auth\/(?:user-token-expired|user-disabled|invalid-user-token)/);
await signOut(auth);
await adminAuth.updateUser('user_tester', { disabled: false });
assert.equal(auth.currentUser, null);

await assert.rejects(signInWithEmailAndPassword(auth, 'tester@sayspec.local', 'wrong-password'), /auth\/(?:invalid-credential|wrong-password)/);

await adminAuth.updateUser('user_tester', { disabled: true });
await assert.rejects(signInWithEmailAndPassword(auth, 'tester@sayspec.local', fixtures.password), /auth\/user-disabled/);
await adminAuth.updateUser('user_tester', { disabled: false });

const offlineApp = initializeApp(config, `auth-offline-${Date.now()}`);
const offlineAuth = getAuth(offlineApp);
connectAuthEmulator(offlineAuth, 'http://127.0.0.1:9199', { disableWarnings: true });
await setPersistence(offlineAuth, inMemoryPersistence);
await assert.rejects(Promise.race([
  signInWithEmailAndPassword(offlineAuth, 'tester@sayspec.local', fixtures.password),
  new Promise((_, reject) => setTimeout(() => reject(new Error('offline timeout')), 4_000)),
]), /auth\/network-request-failed|offline timeout/);

await deleteApp(offlineApp);
await deleteApp(app);
await deleteAdminApp(adminApp);
console.log(JSON.stringify({ signIn: 'passed', activeSessionRevocation: 'rejected', signOut: 'passed', invalidCredential: 'rejected', disabledUser: 'rejected', offline: 'reported' }));
