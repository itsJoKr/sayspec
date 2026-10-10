import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, chromium } from 'playwright';
import electronBinary from 'electron';
import { deleteApp as deleteClient, initializeApp as initializeClient } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth as getClientAuth, updateProfile } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

/**
 * Milestone 12 connected Beta acceptance (run through firebase/scripts/run-connected-beta.mjs).
 *
 * One Auth pool for the portal and the built desktop app: an owner signs up in
 * the portal and generates a company code; a tester creates an account in the
 * desktop app and joins as Editor; the portal shows the real member and seats;
 * seats fill, a fifth is rejected, a removal with rotation frees a seat and
 * invalidates the old code, and a live removal reaches the open desktop app.
 * Admin SDK access is used only to read back server state, never to set it up.
 */
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Run through firebase/scripts/run-connected-beta.mjs.');
const cwd = new URL('..', import.meta.url).pathname;
const portal = 'http://127.0.0.1:5002';
const projectId = 'demo-sayspec-local';
const run = Date.now().toString(36);
const password = 'connected-beta-password';
const email = (label) => `${label}.${run}@sayspec.local`;
const admin = initializeApp({ projectId }, `connected-admin-${run}`);
const db = getFirestore(admin);
const results = {};
const cleanup = [];
const step = (name) => console.log(`M12_CONNECTED_STAGE=${name}`);
const evidence = new URL('../../../tmp/evidence/m12/', import.meta.url).pathname;
const shot = (page, name) => page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: name.startsWith('portal') }).catch((error) => console.log(`M12_SCREENSHOT_FAILED=${name}:${error.message}`));

async function launchDesktop(profile) {
  const app = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd, env: { ...process.env, SAYSPEC_TEST_MODE: '1', SAYSPEC_TEST_USER_DATA: profile }, timeout: 30_000 });
  const page = await app.firstWindow();
  return { app, page };
}
async function newProfile(label) { const dir = await mkdtemp(path.join(tmpdir(), `sayspec-m12-${label}-`)); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir; }
async function desktopCreateAccount(page, { name, address, code }) {
  await page.getByTestId('create-account').click();
  const form = page.getByTestId('create-account-form');
  await form.getByLabel('Your name').fill(name);
  await form.getByLabel('Email').fill(address);
  await form.getByLabel('Password', { exact: true }).fill(password);
  if (code) await form.getByLabel('Company code (optional)').fill(code);
  await form.getByRole('button', { name: 'Create account' }).click();
}
/** A real extra identity joining through the same callable the desktop uses. */
async function sdkTester(label) {
  const app = initializeClient({ apiKey: 'demo-api-key', authDomain: `${projectId}.firebaseapp.com`, projectId, appId: '1:1:web:demo' }, `${label}-${run}`);
  cleanup.push(() => deleteClient(app));
  const auth = getClientAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const functions = getFunctions(app, 'europe-west1'); connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  const credential = await createUserWithEmailAndPassword(auth, email(label), password);
  await updateProfile(credential.user, { displayName: `${label} (synthetic)` });
  return { uid: credential.user.uid, redeem: (code) => httpsCallable(functions, 'joinCodeRedeem')({ code }).then((result) => result.data), call: (name, data) => httpsCallable(functions, name)(data).then((result) => result.data) };
}
const activeMembers = async (orgId) => (await db.collection(`organizations/${orgId}/members`).where('status', '==', 'active').get()).docs.map((item) => item.id);
async function portalCode(page) { const text = (await page.locator('output.join-code').textContent())?.trim() ?? ''; assert.match(text, /^[A-HJ-NP-Z]{4}-[A-HJ-NP-Z]{4}$/); return text; }

let browser; const desktops = [];
await mkdir(evidence, { recursive: true });
try {
  // 1. Owner signs up in the portal, creates the workspace and generates a company code.
  step('portal-owner-sign-up');
  browser = await chromium.launch({ channel: 'chrome' });
  const ownerContext = await browser.newContext({ baseURL: portal });
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto('/sign-up');
  await ownerPage.getByLabel('Your name').fill('Olive Owner');
  await ownerPage.getByLabel('Email').fill(email('owner'));
  await ownerPage.getByLabel('Password', { exact: true }).fill(password);
  await ownerPage.getByLabel('Workspace name').fill('Beta Team (synthetic)');
  await ownerPage.getByRole('button', { name: 'Create account' }).click();
  await ownerPage.waitForURL('**/portal/account');
  const owner = await getAuth(admin).getUserByEmail(email('owner'));
  const ownerScopes = await db.collection(`userScopes/${owner.uid}/organizations`).get();
  assert.equal(ownerScopes.size, 1);
  const orgId = ownerScopes.docs[0].id;
  await ownerPage.goto('/portal/team');
  await ownerPage.getByRole('button', { name: 'Generate company code' }).click();
  const code1 = await portalCode(ownerPage);
  await ownerPage.getByRole('meter', { name: 'Seats used' }).and(ownerPage.locator('[aria-valuetext="1 of 4 seats used"]')).waitFor();
  results.owner = { portalSignUp: true, workspace: orgId, codeShown: true };

  // The owner uses the same identity in the desktop app and creates a restricted project there.
  step('desktop-owner-project');
  const ownerDesktop = await launchDesktop(await newProfile('owner')); desktops.push(ownerDesktop);
  await ownerDesktop.page.getByRole('button', { name: /^Sign in/ }).click();
  await ownerDesktop.page.locator('.auth-form input[type=email]').fill(email('owner'));
  await ownerDesktop.page.locator('.auth-form input[type=password]').fill(password);
  await ownerDesktop.page.locator('.auth-form button[type=submit]').click();
  await ownerDesktop.page.getByTestId('project-gate').waitFor({ timeout: 30_000 });
  await ownerDesktop.page.getByLabel('Project name').fill('Private app');
  await ownerDesktop.page.getByLabel('Base URL').fill('https://private.example.test/');
  await ownerDesktop.page.getByTestId('project-create').click();
  await ownerDesktop.page.getByTestId('onboarding-finish').click();
  await ownerDesktop.page.locator('nav').waitFor({ timeout: 30_000 });
  // A project shared with all members (no desktop UI chooses all-members yet): same owner identity, real callable.
  const ownerSdk = initializeClient({ apiKey: 'demo-api-key', authDomain: `${projectId}.firebaseapp.com`, projectId, appId: '1:1:web:demo' }, `owner-sdk-${run}`);
  cleanup.push(() => deleteClient(ownerSdk));
  const ownerAuth = getClientAuth(ownerSdk); connectAuthEmulator(ownerAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const { signInWithEmailAndPassword } = await import('firebase/auth');
  await signInWithEmailAndPassword(ownerAuth, email('owner'), password);
  const ownerFunctions = getFunctions(ownerSdk, 'europe-west1'); connectFunctionsEmulator(ownerFunctions, '127.0.0.1', 5001);
  await httpsCallable(ownerFunctions, 'projectCreate')({ organizationId: orgId, projectId: `project_team_${run}`, name: 'Team app', targetType: 'web', baseUrl: 'https://team.example.test/', access: 'all-members' });
  results.ownerDesktop = 'same identity signed in; restricted project created in desktop';

  // 2. A tester creates an account in the desktop app with the code (typed lowercase) and joins as Editor.
  step('desktop-tester-sign-up-join');
  const testerProfile = await newProfile('tester');
  let tester = await launchDesktop(testerProfile); desktops.push(tester);
  await desktopCreateAccount(tester.page, { name: 'Tess Tester', address: email('tester'), code: code1.toLowerCase() });
  await tester.page.locator('nav').waitFor({ timeout: 30_000 });
  const organizationSelect = tester.page.getByLabel('Organization', { exact: true });
  await assert.doesNotReject(organizationSelect.locator('option', { hasText: 'Beta Team (synthetic) · editor' }).waitFor({ state: 'attached' }));
  const projectOptions = await tester.page.getByLabel('Project', { exact: true }).locator('option').allTextContents();
  assert.deepEqual(projectOptions, ['Team app · web']);
  const testerUser = await getAuth(admin).getUserByEmail(email('tester'));
  const testerMember = (await db.doc(`organizations/${orgId}/members/${testerUser.uid}`).get()).data();
  assert.deepEqual([testerMember.role, testerMember.joinedVia, testerMember.displayName], ['editor', 'join-code', 'Tess Tester']);
  assert.equal((await db.collection(`userScopes/${testerUser.uid}/organizations`).get()).size, 1, 'no personal workspace was created');
  results.testerJoin = { role: 'editor', visibleProjects: projectOptions, restrictedHidden: true };
  await shot(tester.page, 'desktop-tester-joined');

  // 3. The portal shows the real identity and seat usage; the desktop survives a restart.
  step('portal-directory-restart');
  await ownerPage.reload();
  const testerRow = ownerPage.getByRole('row', { name: /Tess Tester/ });
  await testerRow.waitFor();
  assert.match(await testerRow.innerText(), new RegExp(email('tester').replace('.', '\\.')));
  assert.match(await testerRow.innerText(), /Joined with company code/);
  await ownerPage.locator('[aria-valuetext="2 of 4 seats used"]').waitFor();
  await shot(ownerPage, 'portal-team-connected');
  await tester.app.close(); desktops.splice(desktops.indexOf(tester), 1);
  tester = await launchDesktop(testerProfile); desktops.push(tester);
  await tester.page.locator('nav').waitFor({ timeout: 30_000 });
  assert.equal(await tester.page.getByLabel('Organization', { exact: true }).inputValue(), orgId);
  assert.deepEqual(await tester.page.getByLabel('Project', { exact: true }).locator('option').allTextContents(), ['Team app · web']);
  results.restart = 'session and Editor membership restored';

  // 4. Fill four seats, reject a fifth in the desktop app, idempotent retry at capacity.
  step('capacity');
  const third = await sdkTester('third'); const fourth = await sdkTester('fourth');
  await third.redeem(code1); await fourth.redeem(code1);
  assert.equal((await activeMembers(orgId)).length, 4);
  await ownerPage.locator('[aria-valuetext="4 of 4 seats used"]').waitFor();
  const fifthProfile = await newProfile('fifth');
  const fifth = await launchDesktop(fifthProfile); desktops.push(fifth);
  await desktopCreateAccount(fifth.page, { name: 'Fifi Fifth', address: email('fifth'), code: code1 });
  await fifth.page.locator('[data-join-failure="seats-full"]').waitFor({ timeout: 30_000 });
  assert.match(await fifth.page.getByTestId('no-workspace').innerText(), /no free seats/);
  await shot(fifth.page, 'desktop-seats-full');
  const fifthUser = await getAuth(admin).getUserByEmail(email('fifth'));
  assert.equal((await db.collection(`userScopes/${fifthUser.uid}/organizations`).get()).size, 0, 'the account is kept without a workspace');
  // The tester retries the current code at capacity from the Join workspace dialog on the Account page.
  await tester.page.getByTestId('open-account').click();
  await tester.page.getByRole('button', { name: 'Join workspace' }).click();
  const joinDialog = tester.page.getByRole('dialog', { name: 'Join another workspace' });
  await joinDialog.getByLabel('Company code').fill(code1);
  await joinDialog.getByRole('button', { name: 'Join workspace' }).click();
  await joinDialog.getByTestId('join-success').waitFor();
  assert.match(await joinDialog.getByTestId('join-success').innerText(), /already a member .*Editor/);
  await joinDialog.getByRole('button', { name: 'Close' }).click();
  assert.equal((await db.doc(`organizations/${orgId}/members/${testerUser.uid}`).get()).data().role, 'editor');
  assert.equal((await activeMembers(orgId)).length, 4);
  results.capacity = 'fifth rejected in desktop (account kept, no workspace); active retry at capacity succeeded without changes';

  // Concurrent claims for a freed last seat: the desktop retry races two other identities.
  step('concurrent-last-seat');
  const racerA = await sdkTester('racer-a'); const racerB = await sdkTester('racer-b');
  await ownerPage.getByRole('row', { name: /fourth \(synthetic\)/ }).getByRole('button', { name: /Remove/ }).click();
  await ownerPage.getByRole('dialog', { name: /Remove/ }).getByRole('button', { name: /Remove from/ }).click();
  await ownerPage.locator('[aria-valuetext="3 of 4 seats used"]').waitFor();
  const race = await Promise.allSettled([
    fifth.page.getByRole('button', { name: 'Try again' }).click().then(() => fifth.page.locator('[data-join-failure], [data-testid="join-success"], nav').first().waitFor({ timeout: 30_000 })),
    racerA.redeem(code1), racerB.redeem(code1),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const afterRace = await activeMembers(orgId);
  assert.equal(afterRace.length, 4, 'exactly one of the concurrent claims took the seat');
  const raceWinner = [fifthUser.uid, racerA.uid, racerB.uid].filter((uid) => afterRace.includes(uid));
  assert.equal(raceWinner.length, 1);
  assert.ok(race.slice(1).filter((item) => item.status === 'rejected').every((item) => item.reason?.details?.reason === 'seats-full'));
  results.concurrentLastSeat = { claimants: 3, joined: 1 };

  // 5. Remove with rotation: seat freed, old code fails, disabled code fails, new code works.
  step('rotation-disable');
  const loser = [fifthUser.uid, racerA.uid, racerB.uid].find((uid) => !afterRace.includes(uid) && uid === fifthUser.uid) ? fifth : null;
  const winnerName = raceWinner[0] === fifthUser.uid ? 'Fifi Fifth' : raceWinner[0] === racerA.uid ? 'racer-a (synthetic)' : 'racer-b (synthetic)';
  await ownerPage.getByRole('row', { name: new RegExp(winnerName.replace(/[()]/g, '\\$&')) }).getByRole('button', { name: /Remove/ }).click();
  const removeDialog = ownerPage.getByRole('dialog', { name: /Remove/ });
  await removeDialog.getByLabel(/generate a new company code/).check();
  await removeDialog.getByRole('button', { name: /Remove from/ }).click();
  await ownerPage.getByText(/A new company code was generated\./).waitFor();
  await ownerPage.locator('[aria-valuetext="3 of 4 seats used"]').waitFor();
  const code2 = await portalCode(ownerPage);
  assert.notEqual(code2, code1);
  const late = await sdkTester('late');
  await assert.rejects(late.redeem(code1), (error) => error.details?.reason === 'invalid-code');
  await ownerPage.getByRole('button', { name: 'Turn off joining' }).click();
  await ownerPage.getByText('Joining off').waitFor();
  await assert.rejects(late.redeem(code2), (error) => error.details?.reason === 'invalid-code');
  await ownerPage.getByRole('button', { name: 'Turn on joining' }).click();
  await ownerPage.getByText('Joining on').waitFor();
  // The desktop that lost the race (or a fresh one) joins with the new code.
  const joiner = loser ?? fifth;
  const joinerForm = joiner.page.getByTestId('join-workspace-form');
  if (await joinerForm.count()) {
    await joinerForm.getByLabel('Company code').fill(code1);
    await joinerForm.getByRole('button', { name: 'Join workspace' }).click();
    await joiner.page.locator('[data-join-failure="invalid-code"]').waitFor();
    await joinerForm.getByLabel('Company code').fill(code2);
    await joinerForm.getByRole('button', { name: 'Join workspace' }).click();
    await joiner.page.getByTestId('no-project-access').or(joiner.page.locator('nav')).first().waitFor({ timeout: 30_000 });
    results.rejoin = 'desktop: stale code rejected in UI, new code joined';
  } else {
    await late.redeem(code2);
    results.rejoin = 'new code joined (desktop winner already inside)';
  }
  await ownerPage.locator('[aria-valuetext="4 of 4 seats used"]').waitFor();
  results.rotation = 'removal freed a seat; rotated and disabled codes rejected neutrally; new code works';

  // Live revocation reaches the open desktop app; the last owner stays protected.
  step('live-revocation');
  await ownerPage.getByRole('row', { name: /Tess Tester/ }).getByRole('button', { name: /Remove/ }).click();
  await ownerPage.getByRole('dialog', { name: /Remove/ }).getByRole('button', { name: /Remove from/ }).click();
  await tester.page.getByTestId('no-workspace').waitFor({ timeout: 30_000 });
  assert.match(await tester.page.getByTestId('no-workspace').innerText(), /Workspace access changed[\s\S]*Access to the active organization was revoked/);
  await shot(tester.page, 'desktop-access-revoked');
  await shot(ownerPage, 'portal-team-after-removal');
  const ownerRow = ownerPage.getByRole('row', { name: /Olive Owner/ });
  assert.match(await ownerRow.innerText(), /Last owner · protected/);
  assert.equal(await ownerRow.getByRole('button', { name: /Remove|Change role/ }).count(), 0);
  await assert.rejects(third.call('memberChange', { organizationId: orgId, uid: owner.uid, status: 'revoked' }), /permission|owner or admin/i);
  results.revocation = 'open desktop moved to the access-changed state; last owner protected';

  // Joining another workspace from that screen: no project is shared yet, and the app explains why instead of broadening access.
  step('empty-project-access');
  const secondOwner = await sdkTester('second-owner');
  const secondOrg = `org_second_${run}`;
  await secondOwner.call('organizationCreate', { organizationId: secondOrg, name: 'Second Team (synthetic)' });
  await secondOwner.call('projectCreate', { organizationId: secondOrg, projectId: `project_restricted_${run}`, name: 'Restricted app', targetType: 'web', baseUrl: 'https://restricted.example.test/', access: 'restricted' });
  await secondOwner.call('joinCodeRotate', { organizationId: secondOrg });
  const secondCode = (await db.doc(`organizations/${secondOrg}/private/joinCode`).get()).data().code; // read back only; the owner sees it in the portal
  const revokedForm = tester.page.getByTestId('join-workspace-form');
  await revokedForm.getByLabel('Company code').fill(secondCode);
  await revokedForm.getByRole('button', { name: 'Join workspace' }).click();
  await tester.page.getByTestId('no-project-access').waitFor({ timeout: 30_000 });
  assert.match(await tester.page.getByTestId('no-project-access').innerText(), /an Editor in Second Team \(synthetic\)[\s\S]*does not open every project/);
  assert.equal(await tester.page.getByTestId('project-create').count(), 0);
  await shot(tester.page, 'desktop-editor-no-projects');
  results.emptyProjectAccess = 'joined a second workspace from the access-changed screen; restricted project hidden with an explanation';

  const finalOrg = (await db.doc(`organizations/${orgId}`).get()).data();
  assert.deepEqual(finalOrg.plan, { kind: 'free', seatLimit: 4 });
  assert.equal(finalOrg.activeMemberCount, (await activeMembers(orgId)).length);
  console.log(`M12_CONNECTED_BETA=${JSON.stringify(results)}`);
} finally {
  for (const desktop of desktops) await desktop.app.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  for (const task of cleanup.reverse()) await task().catch(() => undefined);
  await deleteApp(admin);
}
