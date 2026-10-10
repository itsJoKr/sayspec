// Live end-to-end check of the deployed backend through the client SDK, the
// same way the portal and desktop call it. Creates clearly labelled synthetic
// accounts and workspaces ("live-check", @example.com) and never uses admin
// credentials, so it sees exactly what a real client would.
//
//   SAYSPEC_LIVE_CHECK_PROJECT=<project-id> SAYSPEC_LIVE_CHECK_RECORD=<file> node firebase/scripts/live-check.mjs
// The Firebase Web configuration is read from the desktop's live build file
// (apps/desktop/.env.live, see apps/desktop/.env.example) and must name the
// same project. The record file receives the created accounts (with their
// generated passwords, for cleanup) and must be outside the repository.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { deleteApp, initializeApp } from 'firebase/app';
import { createUserWithEmailAndPassword, getAuth, updateProfile } from 'firebase/auth';
import { collection, doc, getDoc, getDocs, getFirestore, setDoc, updateDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';

const liveEnv = Object.fromEntries(readFileSync(new URL('../../apps/desktop/.env.live', import.meta.url), 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const config = { apiKey: liveEnv.VITE_FIREBASE_API_KEY, authDomain: liveEnv.VITE_FIREBASE_AUTH_DOMAIN, projectId: liveEnv.VITE_FIREBASE_PROJECT_ID, storageBucket: liveEnv.VITE_FIREBASE_STORAGE_BUCKET, appId: liveEnv.VITE_FIREBASE_APP_ID };
const functionsRegion = liveEnv.VITE_FIREBASE_FUNCTIONS_REGION || 'europe-west1';
if (!config.projectId || process.env.SAYSPEC_LIVE_CHECK_PROJECT !== config.projectId) throw new Error('Refusing to run without SAYSPEC_LIVE_CHECK_PROJECT naming the project in apps/desktop/.env.live.');
const recordPath = process.env.SAYSPEC_LIVE_CHECK_RECORD;
if (!recordPath) throw new Error('Set SAYSPEC_LIVE_CHECK_RECORD to a file outside the repository.');
const run = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const apps = [];
const record = { run, accounts: [], organizations: [], projects: [] };
const save = () => writeFileSync(recordPath, JSON.stringify(record, null, 2), { mode: 0o600 });

async function person(label) {
  const app = initializeApp(config, `${label}-${run}`); apps.push(app);
  const auth = getAuth(app); const firestore = getFirestore(app); const functions = getFunctions(app, functionsRegion);
  const email = `qa+live-check-${label}-${run}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(credential.user, { displayName: `Live check ${label} (synthetic)` }); await credential.user.getIdToken(true);
  record.accounts.push({ label, email, uid: credential.user.uid, password }); save();
  const call = (name, data) => httpsCallable(functions, name)(data).then((result) => result.data);
  return { label, uid: credential.user.uid, email, firestore, call };
}
async function rejectsWith(promise, code, pattern) {
  try { await promise; } catch (error) {
    assert.equal(String(error.code).replace(/^(functions|firestore)\//, ''), code, `${error.code}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`Expected ${code}`);
}
const denied = (promise) => rejectsWith(promise, 'permission-denied');
const read = async (person, path) => (await getDoc(doc(person.firestore, path))).data();
const results = {};

try {
  // Portal: sign up, create a workspace (Free, 4 seats), generate the company code.
  const owner = await person('owner');
  const orgId = `org_live_check_${run}`;
  await owner.call('organizationCreate', { organizationId: orgId, name: `Live check ${run} (synthetic)` });
  record.organizations.push(orgId); save();
  const organization = await read(owner, `organizations/${orgId}`);
  assert.deepEqual([organization.plan, organization.activeMemberCount], [{ kind: 'free', seatLimit: 4 }, 1]);
  const ownerMember = await read(owner, `organizations/${orgId}/members/${owner.uid}`);
  assert.deepEqual([ownerMember.role, ownerMember.status, ownerMember.email], ['owner', 'active', owner.email]);
  await owner.call('joinCodeRotate', { organizationId: orgId });
  const code = (await read(owner, `organizations/${orgId}/private/joinCode`)).code;
  assert.match(code, /^[A-Z]{8}$/);
  results.portal = 'sign-up, Free workspace with 4 seats, owner member, company code readable by the owner';

  // Desktop: a Free workspace cannot use SaySpec Cloud; Local and Folder work.
  await rejectsWith(owner.call('projectCreate', { organizationId: orgId, projectId: 'web_cloud', name: 'Cloud app', targetType: 'web', baseUrl: 'https://cloud.example.com/', access: 'all-members', testStorage: 'cloud' }), 'failed-precondition', /Pro plan/);
  await owner.call('projectCreate', { organizationId: orgId, projectId: 'web_app', name: 'Live check web app', targetType: 'web', baseUrl: 'https://app.example.com/', access: 'all-members' });
  record.projects.push(`${orgId}/web_app`); save();
  assert.equal((await read(owner, `organizations/${orgId}/projects/web_app`)).testStorage, 'local');
  await rejectsWith(owner.call('projectSetTestStorage', { organizationId: orgId, projectId: 'web_app', testStorage: 'cloud' }), 'failed-precondition', /Pro plan/);
  await owner.call('projectSetTestStorage', { organizationId: orgId, projectId: 'web_app', testStorage: 'folder' });
  assert.equal((await read(owner, `organizations/${orgId}/projects/web_app`)).testStorage, 'folder');
  results.freePlan = 'Cloud rejected on create and on switch; Web project defaults to Local; switch to Folder works';

  // A second account joins with the company code and sees the project and its storage.
  const tester = await person('tester');
  const joined = await tester.call('joinCodeRedeem', { code: `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}` });
  assert.deepEqual(joined, { organizationId: orgId, name: `Live check ${run} (synthetic)`, role: 'editor', joined: true });
  const scope = await read(tester, `userScopes/${tester.uid}/organizations/${orgId}`);
  assert.deepEqual([scope.role, scope.status], ['editor', 'active']);
  assert.equal((await read(tester, `userScopes/${tester.uid}/organizations/${orgId}/projects/web_app`)).testStorage, 'folder');
  assert.equal((await read(tester, `organizations/${orgId}/projects/web_app`)).testStorage, 'folder');
  assert.equal((await read(owner, `organizations/${orgId}`)).activeMemberCount, 2);
  await denied(getDoc(doc(tester.firestore, `organizations/${orgId}/private/joinCode`)));
  await rejectsWith(tester.call('projectSetTestStorage', { organizationId: orgId, projectId: 'web_app', testStorage: 'local' }), 'permission-denied');
  results.join = 'second account joined as Editor by code; sees the project and its testStorage in both the project and its scope; cannot read the code or switch storage';

  // Tenant isolation and server-owned fields.
  const rival = await person('rival');
  const rivalOrg = `org_live_check_rival_${run}`;
  await rival.call('organizationCreate', { organizationId: rivalOrg, name: `Live check rival ${run} (synthetic)` });
  record.organizations.push(rivalOrg); save();
  await denied(getDoc(doc(rival.firestore, `organizations/${orgId}`)));
  await denied(getDocs(collection(rival.firestore, `organizations/${orgId}/members`)));
  await denied(getDoc(doc(rival.firestore, `organizations/${orgId}/projects/web_app`)));
  await denied(getDoc(doc(rival.firestore, `userScopes/${owner.uid}/organizations/${orgId}`)));
  await rejectsWith(rival.call('joinCodeRotate', { organizationId: orgId }), 'permission-denied');
  await rejectsWith(rival.call('projectSetTestStorage', { organizationId: orgId, projectId: 'web_app', testStorage: 'local' }), 'permission-denied');
  await denied(updateDoc(doc(owner.firestore, `organizations/${orgId}`), { 'plan.kind': 'beta' }));
  await denied(setDoc(doc(owner.firestore, `organizations/${orgId}/members/${rival.uid}`), { uid: rival.uid, role: 'owner', status: 'active' }));
  await denied(getDocs(collection(owner.firestore, 'joinCodes')));
  results.isolation = 'rival cannot read the workspace, members, project or scopes, nor rotate the code or switch storage; the owner cannot write plan, members or code lookups directly';

  results.organizationId = orgId;
  console.log(`LIVE_CHECK=${JSON.stringify(results)}`);
} finally {
  await Promise.all(apps.map((app) => deleteApp(app)));
}
