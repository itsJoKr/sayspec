import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initializeApp as initializeClient, deleteApp as deleteClient } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, updateProfile } from 'firebase/auth';
import { collection, connectFirestoreEmulator, doc, getDoc, getDocs, getFirestore as getClientFirestore, setDoc, updateDoc } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { redeemJoinCode } from '../functions/lib/membership.js';

// Company codes, seat capacity, directory and Rules against the Auth,
// Firestore and Functions emulators with real identities and callables.
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Run through firebase emulators:exec.');
const projectId = 'demo-sayspec-local';
const config = { apiKey: 'demo-api-key', authDomain: `${projectId}.firebaseapp.com`, projectId, appId: '1:123:web:demo' };
const admin = initializeApp({ projectId }, `membership-admin-${Date.now()}`);
const db = getFirestore(admin);
const run = Date.now().toString(36);
const apps = [];

async function person(label, displayName = `${label} (synthetic)`) {
  const app = initializeClient(config, `${label}-${run}`); apps.push(app);
  const auth = getAuth(app); const firestore = getClientFirestore(app); const functions = getFunctions(app, 'europe-west1');
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  const credential = await createUserWithEmailAndPassword(auth, `${label}.${run}@sayspec.local`, 'local-only-password');
  if (displayName) { await updateProfile(credential.user, { displayName }); await credential.user.getIdToken(true); }
  const call = (name, data) => httpsCallable(functions, name)(data).then((result) => result.data);
  return { label, uid: credential.user.uid, email: credential.user.email, auth, firestore, call };
}
async function rejectsWith(promise, code, pattern) {
  try { await promise; } catch (error) {
    assert.equal(String(error.code).replace(/^functions\//, ''), code, `${error.code}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`Expected ${code}`);
}
const denied = (promise) => assert.rejects(promise, /permission|PERMISSION_DENIED|insufficient/i);
const resetRateLimits = async () => { const items = await db.collection('rateLimits').get(); await Promise.all(items.docs.map((item) => item.ref.delete())); };
const activeCount = async (orgId) => (await db.collection(`organizations/${orgId}/members`).where('status', '==', 'active').get()).size;
const results = {};

try {
  // 1. Owner creates a workspace with directory and plan fields from the server.
  const owner = await person('owner', 'Olive Owner');
  const orgId = `org_m12_${run}`;
  await owner.call('organizationCreate', { organizationId: orgId, name: 'Beta Team (synthetic)' });
  const ownerMember = (await db.doc(`organizations/${orgId}/members/${owner.uid}`).get()).data();
  assert.deepEqual([ownerMember.displayName, ownerMember.email, ownerMember.joinedVia], ['Olive Owner', owner.email, 'owner']);
  const organization = (await db.doc(`organizations/${orgId}`).get()).data();
  assert.deepEqual([organization.plan, organization.activeMemberCount], [{ kind: 'free', seatLimit: 4 }, 1]);
  await owner.call('projectCreate', { organizationId: orgId, projectId: 'project_open', name: 'Open app', targetType: 'web', baseUrl: 'https://open.example.test/', access: 'all-members' });
  await owner.call('projectCreate', { organizationId: orgId, projectId: 'project_private', name: 'Private app', targetType: 'web', baseUrl: 'https://private.example.test/', access: 'restricted' });

  // 2. Code generation, private read, server-only lookup.
  const joinBefore = await rejectsWith(owner.call('joinCodeSetEnabled', { organizationId: orgId, enabled: false }), 'failed-precondition');
  assert.ok(joinBefore);
  await owner.call('joinCodeRotate', { organizationId: orgId });
  const code1 = (await getDoc(doc(owner.firestore, `organizations/${orgId}/private/joinCode`))).data();
  assert.match(code1.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/); assert.equal(code1.enabled, true); assert.equal(code1.role, 'editor');
  await denied(getDoc(doc(owner.firestore, `joinCodes/${code1.code}`)));
  await denied(getDocs(collection(owner.firestore, 'joinCodes')));
  await denied(getDocs(collection(owner.firestore, `organizations/${orgId}/private`)));
  results.codeFormat = 'eight-letter, owner-readable, lookup server-only';

  // 3. A tester joins as Editor with case/space/hyphen normalization.
  const tester1 = await person('tester1', 'Tess Tester');
  const displayed = `${code1.code.slice(0, 4).toLowerCase()} - ${code1.code.slice(4)}`;
  const joined = await tester1.call('joinCodeRedeem', { code: displayed, role: 'owner', organizationId: 'org_forged' });
  assert.deepEqual(joined, { organizationId: orgId, name: 'Beta Team (synthetic)', role: 'editor', joined: true });
  const member1 = (await db.doc(`organizations/${orgId}/members/${tester1.uid}`).get()).data();
  assert.deepEqual([member1.role, member1.status, member1.joinedVia, member1.displayName, member1.email], ['editor', 'active', 'join-code', 'Tess Tester', tester1.email]);
  const scope1 = (await getDoc(doc(tester1.firestore, `userScopes/${tester1.uid}/organizations/${orgId}`))).data();
  assert.deepEqual([scope1.organizationId, scope1.name, scope1.role, scope1.status], [orgId, 'Beta Team (synthetic)', 'editor', 'active']);
  const projectScopes = (await getDocs(collection(tester1.firestore, `userScopes/${tester1.uid}/organizations/${orgId}/projects`))).docs.map((item) => item.id);
  assert.deepEqual(projectScopes, ['project_open']);
  await denied(getDoc(doc(tester1.firestore, `organizations/${orgId}/projects/project_private`)));
  assert.equal((await getDoc(doc(tester1.firestore, `organizations/${orgId}/projects/project_open`))).exists(), true);
  await denied(getDoc(doc(tester1.firestore, `organizations/${orgId}/private/joinCode`)));
  assert.equal((await tester1.call('joinCodeRedeem', { code: code1.code })).joined, false);
  await rejectsWith(tester1.call('joinCodeRotate', { organizationId: orgId }), 'permission-denied');
  results.join = 'editor, complete scope, all-members projects only, idempotent retry';

  // 3b. Test storage follows the plan: a Free workspace cannot use SaySpec Cloud, a Beta workspace can,
  // only managers switch storage, and a switch reaches every member's project scope.
  assert.equal((await db.doc(`organizations/${orgId}/projects/project_open`).get()).data().testStorage, 'local', 'Free workspaces default to Local');
  await rejectsWith(owner.call('projectCreate', { organizationId: orgId, projectId: 'project_cloud_free', name: 'Cloud app', targetType: 'web', baseUrl: 'https://cloud.example.test/', access: 'restricted', testStorage: 'cloud' }), 'failed-precondition', /Pro plan/);
  await rejectsWith(owner.call('projectSetTestStorage', { organizationId: orgId, projectId: 'project_open', testStorage: 'cloud' }), 'failed-precondition', /Pro plan/);
  await rejectsWith(tester1.call('projectSetTestStorage', { organizationId: orgId, projectId: 'project_open', testStorage: 'folder' }), 'permission-denied');
  // The operator moves the workspace to Beta by its owner's email; the dry run writes nothing.
  const { execFileSync: runPlan } = await import('node:child_process');
  const setPlan = (...args) => JSON.parse(runPlan(process.execPath, [new URL('./set-plan.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' }).trim().split('\n').at(-1));
  assert.deepEqual(setPlan('--owner', owner.email, 'beta'), { organizationId: orgId, from: 'free', to: 'beta', applied: false });
  assert.equal((await db.doc(`organizations/${orgId}`).get()).data().plan.kind, 'free', 'set-plan dry run writes nothing');
  assert.deepEqual(setPlan('--owner', owner.email, 'beta', '--apply'), { organizationId: orgId, from: 'free', to: 'beta', applied: true });
  await owner.call('projectSetTestStorage', { organizationId: orgId, projectId: 'project_open', testStorage: 'cloud' });
  assert.equal((await getDoc(doc(tester1.firestore, `userScopes/${tester1.uid}/organizations/${orgId}/projects/project_open`))).data().testStorage, 'cloud');
  await rejectsWith(owner.call('projectCreate', { organizationId: orgId, projectId: 'project_cloud_flutter', name: 'Mobile app', targetType: 'flutter', access: 'restricted', testStorage: 'cloud' }), 'failed-precondition', /Web projects/);
  await owner.call('projectCreate', { organizationId: orgId, projectId: 'project_cloud_default', name: 'Default app', targetType: 'web', baseUrl: 'https://default.example.test/', access: 'restricted' });
  assert.equal((await db.doc(`organizations/${orgId}/projects/project_cloud_default`).get()).data().testStorage, 'cloud', 'Beta workspaces default Web projects to SaySpec Cloud');
  // Pro (paid, not offered yet) is operator-set and has the same Pro features as Beta.
  assert.deepEqual(setPlan('--owner', owner.email, 'pro', '--apply'), { organizationId: orgId, from: 'beta', to: 'pro', applied: true });
  await owner.call('projectCreate', { organizationId: orgId, projectId: 'project_cloud_pro', name: 'Pro app', targetType: 'web', baseUrl: 'https://pro.example.test/', access: 'restricted' });
  assert.equal((await db.doc(`organizations/${orgId}/projects/project_cloud_pro`).get()).data().testStorage, 'cloud', 'Pro workspaces default Web projects to SaySpec Cloud');
  assert.deepEqual(setPlan('--owner', owner.email, 'beta', '--apply'), { organizationId: orgId, from: 'pro', to: 'beta', applied: true });
  results.testStorage = 'Free: Local default, Cloud rejected; Beta and Pro: Cloud allowed for Web; manager-only switch reaches member scopes';

  // 4. Seats: fill four, reject a fifth, idempotent retry at capacity keeps privileges.
  const tester2 = await person('tester2'); const tester3 = await person('tester3');
  await tester2.call('joinCodeRedeem', { code: code1.code }); await tester3.call('joinCodeRedeem', { code: code1.code });
  // Joining after a storage switch carries the project's storage into the new scope.
  assert.equal((await getDoc(doc(tester2.firestore, `userScopes/${tester2.uid}/organizations/${orgId}/projects/project_open`))).data().testStorage, 'cloud');
  assert.equal(await activeCount(orgId), 4);
  const fifth = await person('fifth');
  const full = await rejectsWith(fifth.call('joinCodeRedeem', { code: code1.code }), 'failed-precondition', /no free seats/);
  assert.equal(full.details?.reason, 'seats-full');
  await owner.call('memberChange', { organizationId: orgId, uid: tester1.uid, role: 'reviewer' });
  assert.deepEqual(await tester1.call('joinCodeRedeem', { code: code1.code }), { organizationId: orgId, name: 'Beta Team (synthetic)', role: 'reviewer', joined: false });
  assert.equal((await db.doc(`organizations/${orgId}/members/${tester1.uid}`).get()).data().role, 'reviewer');
  assert.equal((await db.doc(`organizations/${orgId}`).get()).data().activeMemberCount, 4);
  assert.equal((await db.doc(`organizations/${orgId}`).get()).data().plan.kind, 'beta', 'seat changes keep the plan');
  results.capacity = 'fifth rejected (seats-full); active member retry at capacity keeps reviewer role';

  // 5. Concurrent claims for the last seat yield exactly one new member.
  await owner.call('memberChange', { organizationId: orgId, uid: tester3.uid, status: 'revoked' });
  assert.equal(await activeCount(orgId), 3);
  const racers = await Promise.all(['racer1', 'racer2', 'racer3', 'racer4', 'racer5'].map((label) => person(label)));
  const outcomes = await Promise.allSettled(racers.map((racer) => racer.call('joinCodeRedeem', { code: code1.code })));
  const winners = outcomes.filter((item) => item.status === 'fulfilled');
  assert.equal(winners.length, 1, JSON.stringify(outcomes.map((item) => item.status === 'fulfilled' ? 'joined' : item.reason.message)));
  assert.ok(outcomes.filter((item) => item.status === 'rejected').every((item) => item.reason.details?.reason === 'seats-full'));
  assert.equal(await activeCount(orgId), 4);
  assert.equal((await db.doc(`organizations/${orgId}`).get()).data().activeMemberCount, 4);
  const winner = racers[outcomes.findIndex((item) => item.status === 'fulfilled')];
  // The same race as truly parallel transactions in one process, independent of emulator worker scheduling.
  await owner.call('memberChange', { organizationId: orgId, uid: winner.uid, status: 'revoked' });
  const direct = await Promise.allSettled(Array.from({ length: 8 }, (_item, index) => redeemJoinCode(db, { uid: `direct_racer_${run}_${index}`, email: `direct${index}@sayspec.local` }, { code: code1.code })));
  assert.equal(direct.filter((item) => item.status === 'fulfilled').length, 1, JSON.stringify(direct.map((item) => item.status === 'fulfilled' ? 'joined' : item.reason.message)));
  assert.equal(await activeCount(orgId), 4);
  const directWinner = direct.findIndex((item) => item.status === 'fulfilled');
  await owner.call('memberChange', { organizationId: orgId, uid: `direct_racer_${run}_${directWinner}`, status: 'revoked' });
  await owner.call('memberChange', { organizationId: orgId, uid: winner.uid, status: 'active' });
  assert.equal(await activeCount(orgId), 4);
  results.concurrentLastSeat = `${outcomes.length} simultaneous callable claims → 1 member; ${direct.length} parallel transactions → 1 member`;

  // 6. Reactivation and invitations obey the same capacity rule.
  const reactivate = await rejectsWith(owner.call('memberChange', { organizationId: orgId, uid: tester3.uid, status: 'active' }), 'failed-precondition');
  assert.equal(reactivate.details?.reason, 'seats-full');
  const invitee = await person('invitee');
  await owner.call('invitationCreate', { organizationId: orgId, invitationId: `invite_${run}`, email: invitee.email, role: 'viewer', tokenHash: 'd'.repeat(64), expiresAt: new Date(Date.now() + 600_000).toISOString() });
  await rejectsWith(invitee.call('invitationAccept', { organizationId: orgId, invitationId: `invite_${run}`, tokenHash: 'd'.repeat(64) }), 'failed-precondition', /no free seats/);
  // Remove a member (frees a seat) and reactivate the earlier one with complete scope data.
  await owner.call('memberChange', { organizationId: orgId, uid: winner.uid, status: 'revoked' });
  await owner.call('memberChange', { organizationId: orgId, uid: tester3.uid, status: 'active' });
  const reactivatedScope = (await getDoc(doc(tester3.firestore, `userScopes/${tester3.uid}/organizations/${orgId}`))).data();
  assert.deepEqual([reactivatedScope.organizationId, reactivatedScope.name, reactivatedScope.role, reactivatedScope.status], [orgId, 'Beta Team (synthetic)', 'editor', 'active']);
  assert.equal(await activeCount(orgId), 4);
  results.reactivation = 'capacity enforced; complete scope written (organizationId, name, role, status)';

  // 7. Removal with rotation; stale and disabled codes fail neutrally; removed members rejoin as Editor without old grants.
  await owner.call('projectGrantSet', { organizationId: orgId, projectId: 'project_private', uid: tester2.uid, access: 'editor' });
  assert.equal((await getDoc(doc(tester2.firestore, `organizations/${orgId}/projects/project_private`))).exists(), true);
  await owner.call('memberChange', { organizationId: orgId, uid: tester2.uid, status: 'revoked' });
  assert.equal((await db.doc(`organizations/${orgId}/projects/project_private/grants/${tester2.uid}`).get()).exists, false);
  await denied(getDoc(doc(tester2.firestore, `organizations/${orgId}/members/${tester2.uid}`)));
  assert.equal((await getDoc(doc(tester2.firestore, `userScopes/${tester2.uid}/organizations/${orgId}`))).exists(), false);
  await owner.call('joinCodeRotate', { organizationId: orgId });
  const code2 = (await getDoc(doc(owner.firestore, `organizations/${orgId}/private/joinCode`))).data().code;
  assert.notEqual(code2, code1.code);
  assert.equal((await db.doc(`joinCodes/${code1.code}`).get()).exists, false);
  await resetRateLimits();
  const stale = await rejectsWith(tester2.call('joinCodeRedeem', { code: code1.code }), 'not-found', /not valid/);
  const unknown = await rejectsWith(tester2.call('joinCodeRedeem', { code: 'ZZZZZZZZ' }), 'not-found', /not valid/);
  await owner.call('joinCodeSetEnabled', { organizationId: orgId, enabled: false });
  const disabled = await rejectsWith(tester2.call('joinCodeRedeem', { code: code2 }), 'not-found', /not valid/);
  assert.equal(new Set([stale.message, unknown.message, disabled.message]).size, 1, 'no oracle between unknown, rotated and disabled');
  await resetRateLimits();
  await owner.call('joinCodeSetEnabled', { organizationId: orgId, enabled: true });
  assert.equal((await tester2.call('joinCodeRedeem', { code: code2 })).role, 'editor');
  assert.deepEqual((await getDocs(collection(tester2.firestore, `userScopes/${tester2.uid}/organizations/${orgId}/projects`))).docs.map((item) => item.id), ['project_open']);
  await denied(getDoc(doc(tester2.firestore, `organizations/${orgId}/projects/project_private`)));
  results.rotation = 'old code deleted, stale/unknown/disabled share one neutral error, rejoin as Editor without stale grants';

  // 8. Last-owner protection and elevated-role rules.
  await rejectsWith(owner.call('memberChange', { organizationId: orgId, uid: owner.uid, status: 'revoked' }), 'failed-precondition', /last owner/);
  await rejectsWith(owner.call('memberChange', { organizationId: orgId, uid: tester1.uid, role: 'superuser' }), 'invalid-argument');
  await rejectsWith(tester1.call('memberChange', { organizationId: orgId, uid: tester1.uid, role: 'owner' }), 'permission-denied');
  results.lastOwner = 'protected; forged role rejected';

  // 9. Direct Rules writes and forged plan/seat fields are denied.
  await denied(setDoc(doc(tester1.firestore, `organizations/${orgId}/members/${tester1.uid}`), { role: 'owner', status: 'active' }));
  await denied(updateDoc(doc(owner.firestore, `organizations/${orgId}`), { plan: { kind: 'free-beta', seatLimit: 99 } }));
  await denied(setDoc(doc(fifth.firestore, `organizations/${orgId}/members/${fifth.uid}`), { uid: fifth.uid, role: 'editor', status: 'active' }));
  await denied(setDoc(doc(fifth.firestore, `userScopes/${fifth.uid}/organizations/${orgId}`), { organizationId: orgId, name: 'x', role: 'owner', status: 'active' }));
  await denied(setDoc(doc(owner.firestore, `organizations/${orgId}/private/joinCode`), { code: 'AAAAAAAA', enabled: true }));
  await denied(setDoc(doc(fifth.firestore, 'joinCodes/AAAAAAAA'), { organizationId: orgId }));
  await denied(getDocs(collection(owner.firestore, 'rateLimits')));
  await denied(getDocs(collection(owner.firestore, `organizations/${orgId}/audit`)));
  results.directWrites = 'members, scopes, plan fields, codes, lookups, audit and rate limits denied';

  // 10. Cross-tenant isolation.
  const rival = await person('rival');
  const rivalOrg = `org_rival_${run}`;
  await rival.call('organizationCreate', { organizationId: rivalOrg, name: 'Rival (synthetic)' });
  await rival.call('joinCodeRotate', { organizationId: rivalOrg });
  await denied(getDocs(collection(tester1.firestore, `organizations/${rivalOrg}/members`)));
  await denied(getDoc(doc(owner.firestore, `organizations/${rivalOrg}/private/joinCode`)));
  await rejectsWith(owner.call('joinCodeRotate', { organizationId: rivalOrg }), 'permission-denied');
  await rejectsWith(owner.call('memberChange', { organizationId: rivalOrg, uid: rival.uid, status: 'revoked' }), 'permission-denied');
  await denied(getDocs(collection(rival.firestore, `organizations/${orgId}/members`)));
  results.crossTenant = 'denied';

  // 11. Rate limits and backoff (per account and per hashed address).
  await resetRateLimits();
  const guesser = await person('guesser');
  for (const guess of ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC']) await rejectsWith(guesser.call('joinCodeRedeem', { code: guess }), 'not-found');
  const backoff = await rejectsWith(guesser.call('joinCodeRedeem', { code: 'DDDDDDDD' }), 'resource-exhausted', /Too many/);
  assert.ok(backoff.details?.retryAfterSeconds > 0);
  // The block applies even to the valid code while backing off.
  await rejectsWith(guesser.call('joinCodeRedeem', { code: code2 }), 'resource-exhausted');
  const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 40);
  const ipKey = (await db.collection('rateLimits').get()).docs.map((item) => item.id).find((id) => id.startsWith('joinRedeem_ip_'));
  assert.ok(ipKey, 'per-address counter exists');
  await db.doc(`rateLimits/joinRedeem_uid_${hash(guesser.uid)}`).set({ windowStart: Date.now(), attempts: 12, failures: 10, consecutiveFailures: 0, lastFailureAt: 0 });
  await rejectsWith(guesser.call('joinCodeRedeem', { code: code2 }), 'resource-exhausted');
  await resetRateLimits();
  await db.doc(`rateLimits/${ipKey}`).set({ windowStart: Date.now(), attempts: 40, failures: 30, consecutiveFailures: 0, lastFailureAt: 0 });
  const ipBlocked = await rejectsWith(fifth.call('joinCodeRedeem', { code: code2 }), 'resource-exhausted');
  assert.ok(ipBlocked, 'per-address cap applies across accounts');
  const counters = (await db.collection('rateLimits').get()).docs.map((item) => item.id);
  assert.ok(counters.every((id) => !/127\.0\.0\.1|::1/.test(id) && !id.includes(guesser.uid) && !id.includes(fifth.uid)), 'addresses and uids are hashed');
  await resetRateLimits();
  results.rateLimit = 'backoff after 3 failures, per-account and per-address caps, hashed keys';

  // 12. Directory backfill from Auth for legacy memberships, scoped visibility.
  await db.doc(`organizations/${orgId}/members/${tester3.uid}`).update({ displayName: FieldValue.delete(), email: FieldValue.delete() });
  await tester3.call('memberDirectorySync', { organizationId: orgId });
  const afterSelf = (await db.doc(`organizations/${orgId}/members/${tester3.uid}`).get()).data();
  assert.equal(afterSelf.email, tester3.email);
  await db.doc(`organizations/${orgId}/members/${owner.uid}`).update({ displayName: FieldValue.delete(), email: FieldValue.delete() });
  await tester3.call('memberDirectorySync', { organizationId: orgId });
  assert.equal((await db.doc(`organizations/${orgId}/members/${owner.uid}`).get()).data().email, undefined, 'non-managers refresh only themselves');
  const sync = await owner.call('memberDirectorySync', { organizationId: orgId });
  assert.equal(sync.seatLimit, 4); assert.equal(sync.activeMemberCount, 4);
  assert.equal((await db.doc(`organizations/${orgId}/members/${owner.uid}`).get()).data().email, owner.email);
  await rejectsWith(rival.call('memberDirectorySync', { organizationId: orgId }), 'permission-denied');
  results.directory = 'Auth-sourced backfill; managers refresh workspace, members only themselves; outsiders denied';

  // 13. Over-limit legacy workspace keeps everyone and rejects new joins.
  const legacyOrg = `org_legacy_${run}`;
  await db.doc(`organizations/${legacyOrg}`).set({ id: legacyOrg, name: 'Legacy (synthetic)', ownerUids: ['legacy_0'] });
  for (let index = 0; index < 5; index += 1) await db.doc(`organizations/${legacyOrg}/members/legacy_${index}`).set({ uid: `legacy_${index}`, organizationId: legacyOrg, role: index ? 'editor' : 'owner', status: 'active' });
  await db.doc(`organizations/${legacyOrg}/private/joinCode`).set({ organizationId: legacyOrg, code: 'LEGACYAB', enabled: true, role: 'editor' });
  await db.doc('joinCodes/LEGACYAB').set({ organizationId: legacyOrg });
  await rejectsWith(fifth.call('joinCodeRedeem', { code: 'LEGACYAB' }), 'failed-precondition', /no free seats/);
  assert.equal(await activeCount(legacyOrg), 5);
  const { execFileSync } = await import('node:child_process');
  const dryRun = JSON.parse(execFileSync(process.execPath, [new URL('./backfill-membership.mjs', import.meta.url).pathname], { encoding: 'utf8' }).trim().split('\n').at(-1));
  assert.equal(dryRun.apply, false);
  assert.equal((await db.doc(`organizations/${legacyOrg}`).get()).data().plan, undefined, 'dry run writes nothing');
  const backfill = JSON.parse(execFileSync(process.execPath, [new URL('./backfill-membership.mjs', import.meta.url).pathname, '--apply'], { encoding: 'utf8' }).trim().split('\n').at(-1));
  assert.ok(backfill.overLimit.includes(legacyOrg));
  const legacy = (await db.doc(`organizations/${legacyOrg}`).get()).data();
  assert.deepEqual([legacy.plan, legacy.activeMemberCount], [{ kind: 'beta', seatLimit: 4 }, 5]);
  assert.equal(await activeCount(legacyOrg), 5);
  results.overLimitLegacy = 'five existing members kept, new join rejected; backfill dry-run wrote nothing, --apply wrote plan fields and reported over-limit without evicting';

  // 14. Audit trail exists and never contains a plaintext code.
  const audit = (await db.collection(`organizations/${orgId}/audit`).get()).docs.map((item) => JSON.stringify(item.data()));
  assert.ok(audit.some((item) => item.includes('member.joined-with-code')) && audit.some((item) => item.includes('join-code.rotated')));
  assert.ok(audit.every((item) => !item.includes(code1.code) && !item.includes(code2)));
  results.audit = `${audit.length} events, no codes`;

  console.log(`M12_MEMBERSHIP=${JSON.stringify(results)}`);
} finally {
  await Promise.all(apps.map((app) => deleteClient(app)));
  await deleteApp(admin);
}
