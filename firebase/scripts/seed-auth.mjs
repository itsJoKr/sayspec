import { readFile } from 'node:fs/promises';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const fixtures = JSON.parse(await readFile(new URL('../fixtures/tenants.json', import.meta.url), 'utf8'));
const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
if (!fixtures.projectId.startsWith('demo-') || !/^127\.0\.0\.1:\d+$/.test(emulatorHost)) {
  throw new Error('Refusing to seed anything except a loopback Firebase demo project.');
}
process.env.FIREBASE_AUTH_EMULATOR_HOST = emulatorHost;

const clearResponse = await fetch(`http://${emulatorHost}/emulator/v1/projects/${fixtures.projectId}/accounts`, { method: 'DELETE' });
if (!clearResponse.ok) throw new Error(`Could not clear Auth emulator: ${clearResponse.status}`);

const app = initializeApp({ projectId: fixtures.projectId }, `seed-${Date.now()}`);
const auth = getAuth(app);
const users = fixtures.organizations.flatMap((organization) => organization.members);
for (const user of users) {
  await auth.createUser({ uid: user.uid, email: user.email, displayName: user.displayName, password: fixtures.password, emailVerified: true });
}
console.log(JSON.stringify({ projectId: fixtures.projectId, users: users.map(({ uid, email }) => ({ uid, email })) }));
await deleteApp(app);
