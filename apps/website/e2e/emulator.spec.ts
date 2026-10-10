// REAL FIREBASE SUITE (local emulators, demo-sayspec-local). Uses the actual
// Auth emulator, Firestore Rules, and the organizationCreate, memberChange,
// joinCode* and memberDirectorySync callables, served through the Firebase
// Hosting emulator.
// No real users are created and no real email is sent.
import { expect, test, type Page } from '@playwright/test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
// The real trusted command behind the organizationCreate callable (built by run-e2e.mjs).
import { changeMemberRole, createOrganization } from '../../../firebase/functions/lib/commands.js';

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'local-only-password';
const admin = initializeApp({ projectId: 'demo-sayspec-local' }, `website-e2e-${Date.now()}`);
test.afterAll(async () => { await deleteApp(admin); });
test.beforeAll(() => {
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run through scripts/run-e2e.mjs so emulator hosts are set.');
});

async function signIn(page: Page, email: string, password = PASSWORD, path = '/portal/account') {
  await page.goto(`/sign-in?next=${encodeURIComponent(path)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(path);
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page).toHaveURL('/sign-in?reason=signed-out');
}

test('Hosting: landing CTAs point to /get-app and marketing content is intact', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Still testing by hand?');
  await expect(page.getByText(/Download for Mac|Download Mac app/)).toHaveCount(0);
  const ctas = page.getByRole('link', { name: 'Get SaySpec app' });
  await expect(ctas).toHaveCount(3);
  for (const href of await ctas.evaluateAll((links) => links.map((link) => link.getAttribute('href')))) expect(href).toBe('/get-app');
  await expect(page.locator('[data-download-link]')).toHaveCount(0);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Welcome to the AI era/);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
  await ctas.first().click();
  await expect(page).toHaveURL('/get-app');
  await expect(page.getByRole('heading', { name: 'Get SaySpec app' })).toBeVisible();
});

test('Hosting: direct loads and refreshes of every route; assets unaffected', async ({ page, request }) => {
  const routes: Array<[string, string]> = [
    ['/get-app', 'Get SaySpec app'], ['/sign-in', 'Sign in'], ['/sign-up', 'Create account'], ['/reset-password', 'Reset password'],
    ['/portal', 'Sign in'], ['/portal/account', 'Sign in'], ['/portal/billing', 'Sign in'], ['/portal/team', 'Sign in'],
  ];
  for (const [path, heading] of routes) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
  await page.goto('/portal/does-not-exist');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  for (const asset of ['/favicon.svg', '/social-preview.png', '/brands/claude.svg']) expect((await request.get(asset)).status(), asset).toBe(200);
  const portal = await request.get('/portal/team');
  expect(portal.headers()['x-robots-tag']).toBe('noindex');
  // Hosting serves the rewrite for a trailing slash; the app router normalises it.
  await page.goto('/portal/team/');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fportal%2Fteam$/);
});

test('/get-app: honest desktop placeholder and portal actions', async ({ page }) => {
  await page.goto('/get-app');
  await expect(page.getByRole('button', { name: 'Download coming soon' })).toBeDisabled();
  await expect(page.getByText('The Mac download is not available yet.')).toBeVisible();
  await expect(page.locator('a[download], a[href*="example.com"], a[href$=".dmg"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sign in' }).last()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/sign-up');
  await expect(page.getByText('Local Firebase emulator · demo-sayspec-local')).toBeVisible();
});

test('unauthorized portal routes redirect to sign-in with a safe return path', async ({ page }) => {
  await page.goto('/portal/team');
  await expect(page).toHaveURL('/sign-in?next=%2Fportal%2Fteam');
  // Arbitrary redirect targets are ignored.
  await page.goto('/sign-in?next=https%3A%2F%2Fevil.example%2Fportal');
  await page.getByLabel('Email').fill('tester@sayspec.local');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('The email or password is incorrect.')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/portal/account');
});

test('sign-in, persisted session, owner views, workspace switching and tester page', async ({ page, browser }) => {
  // Give the seeded owner a second workspace they own; they are only a viewer (tester) in Rival Labs.
  await createOrganization(getFirestore(admin), { uid: 'user_tester', email: 'tester@sayspec.local' }, { organizationId: 'org_tester_side', name: 'Tester Side QA (synthetic)' });

  await signIn(page, 'tester@sayspec.local', PASSWORD, '/portal/team');
  const workspaceSelect = page.getByRole('combobox', { name: 'Workspace', exact: true });
  // Only workspaces the user owns or administers are offered; Rival Labs (viewer) is not.
  await expect(workspaceSelect.locator('option')).toHaveText(['Northstar QA (synthetic) · Owner', 'Tester Side QA (synthetic) · Owner']);
  const self = page.getByRole('row', { name: /You/ });
  await expect(self).toContainText('tester@sayspec.local');
  await expect(self).toContainText('Last owner · protected');
  await expect(self.getByRole('button', { name: /Remove|Change role/ })).toHaveCount(0);
  await expect(page.getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('row', { name: /…viewer/ })).toContainText('Reviewer');

  // Persisted auth: a reload restores the session without visiting sign-in.
  await page.reload();
  await expect(page).toHaveURL('/portal/team');
  await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();

  await workspaceSelect.selectOption({ label: 'Tester Side QA (synthetic) · Owner' });
  await expect(page.getByText('People in Tester Side QA (synthetic).')).toBeVisible();
  await expect(page.getByText('You are the only member of this workspace.')).toBeVisible();
  await expect(page.getByRole('row', { name: /…viewer/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Account' }).click();
  await expect(page.getByText('Selected workspace').locator('..')).toContainText('Tester Side QA (synthetic)');
  await workspaceSelect.selectOption({ label: 'Northstar QA (synthetic) · Owner' });
  await expect(page.getByText('Selected workspace').locator('..')).toContainText('Northstar QA (synthetic)');

  // A tester (reviewer role only) is sent to the desktop app instead of the dashboard.
  const testerContext = await browser.newContext();
  const tester = await testerContext.newPage();
  await signIn(tester, 'reviewer@sayspec.local', PASSWORD, '/portal/team');
  await expect(tester.getByRole('heading', { level: 1, name: 'Use the SaySpec desktop app' })).toBeVisible();
  await expect(tester.getByText('Northstar QA (synthetic)')).toBeVisible();
  await expect(tester.getByRole('navigation', { name: 'Portal' })).toHaveCount(0);
  await expect(tester.getByRole('table')).toHaveCount(0);
  await testerContext.close();
});

test('real memberChange: role change round-trip through Functions and Firestore', async ({ page }) => {
  await signIn(page, 'tester@sayspec.local', PASSWORD, '/portal/team');
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Northstar QA (synthetic) · Owner' });
  const reviewer = page.getByRole('row', { name: /…viewer/ });
  await reviewer.getByRole('button', { name: /Change role/ }).click();
  const dialog = page.getByRole('dialog', { name: /Change role for/ });
  await dialog.getByLabel(/Editor/).check();
  await dialog.getByRole('button', { name: 'Save role' }).click();
  await expect(reviewer).toContainText('Editor');
  const doc = await getFirestore(admin).doc('organizations/org_northstar/members/user_reviewer').get();
  expect(doc.data()?.role).toBe('editor');
  expect(doc.data()?.changedByUid).toBe('user_tester');
  await reviewer.getByRole('button', { name: /Change role/ }).click();
  await dialog.getByLabel(/Reviewer/).check();
  await dialog.getByRole('button', { name: 'Save role' }).click();
  await expect(reviewer).toContainText('Reviewer');
});

test('company code: generate, copy, rotate, joining off/on and removal with rotation through the real callables', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const db = getFirestore(admin);
  await signIn(page, 'tester@sayspec.local', PASSWORD, '/portal/team');
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Northstar QA (synthetic) · Owner' });
  await expect(page.getByRole('meter', { name: 'Seats used' })).toHaveAttribute('aria-valuetext', '2 of 4 seats used');
  const panel = page.locator('section[aria-labelledby="code-heading"]');
  await expect(panel.getByText('Company codes are not connected yet.')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Generate company code' }).click();
  const output = panel.locator('output.join-code');
  await expect(output).toHaveText(/^[A-HJ-NP-Z]{4}-[A-HJ-NP-Z]{4}$/);
  const first = (await db.doc('organizations/org_northstar/private/joinCode').get()).data();
  expect(first?.enabled).toBe(true);
  await expect(output).toHaveText(`${first?.code.slice(0, 4)}-${first?.code.slice(4)}`);
  await panel.getByRole('button', { name: 'Copy' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first?.code);

  await panel.getByRole('button', { name: 'Generate new code' }).click();
  await page.getByRole('dialog', { name: 'Generate a new company code?' }).getByRole('button', { name: 'Generate new code' }).click();
  await expect(page.getByText('A new company code is ready. The previous code no longer works.')).toBeVisible();
  const second = (await db.doc('organizations/org_northstar/private/joinCode').get()).data();
  expect(second?.code).not.toBe(first?.code);
  expect((await db.doc(`joinCodes/${first?.code}`).get()).exists).toBe(false);
  expect((await db.doc(`joinCodes/${second?.code}`).get()).data()?.organizationId).toBe('org_northstar');
  await expect(output).toHaveText(`${second?.code.slice(0, 4)}-${second?.code.slice(4)}`);

  await panel.getByRole('button', { name: 'Turn off joining' }).click();
  await expect(panel.getByText('Joining off')).toBeVisible();
  expect((await db.doc('organizations/org_northstar/private/joinCode').get()).data()?.enabled).toBe(false);
  await expect(panel.getByRole('button', { name: /^Cop(y|ied)$/ })).toBeDisabled();
  await panel.getByRole('button', { name: 'Turn on joining' }).click();
  await expect(panel.getByText('Joining on')).toBeVisible();
  expect((await db.doc('organizations/org_northstar/private/joinCode').get()).data()?.enabled).toBe(true);

  // Removal offers rotation; the result reports both operations.
  await page.getByRole('row', { name: /…viewer/ }).getByRole('button', { name: /Remove/ }).click();
  const remove = page.getByRole('dialog', { name: /Remove/ });
  await expect(remove.getByText('They could join again with the current company code.')).toBeVisible();
  await remove.getByLabel(/generate a new company code/).check();
  await remove.getByRole('button', { name: /Remove from Northstar/ }).click();
  await expect(page.getByText(/was removed from Northstar QA \(synthetic\)\. A new company code was generated\./)).toBeVisible();
  const third = (await db.doc('organizations/org_northstar/private/joinCode').get()).data();
  expect(third?.code).not.toBe(second?.code);
  expect((await db.doc(`joinCodes/${second?.code}`).get()).exists).toBe(false);
  await expect(page.getByRole('meter', { name: 'Seats used' })).toHaveAttribute('aria-valuetext', '1 of 4 seats used');
  // Restore the seeded reviewer for later tests (owner reactivation is server-side capacity checked).

  await changeMemberRole(db, { uid: 'user_tester' }, { organizationId: 'org_northstar', uid: 'user_reviewer', status: 'active' });
  await expect(page.getByRole('meter', { name: 'Seats used' })).toHaveAttribute('aria-valuetext', '2 of 4 seats used');

  // Server-written plan fields only; no billing state.
  const org = (await db.doc('organizations/org_northstar').get()).data() ?? {};
  expect(org.plan).toEqual({ kind: 'free', seatLimit: 4 });
  expect(org.activeMemberCount).toBe(2);
  expect(Object.keys(org).some((key) => /billing|subscription|checkout|price/i.test(key))).toBe(false);
});

test('a live demotion clears the company code and the admin view immediately', async ({ page }) => {
  const db = getFirestore(admin);
  await changeMemberRole(db, { uid: 'user_tester' }, { organizationId: 'org_northstar', uid: 'user_reviewer', role: 'admin' });
  await signIn(page, 'reviewer@sayspec.local', PASSWORD, '/portal/team');
  const code = page.locator('section[aria-labelledby="code-heading"] output.join-code');
  await expect(code).toHaveText(/^[A-HJ-NP-Z]{4}-[A-HJ-NP-Z]{4}$/);
  await changeMemberRole(db, { uid: 'user_tester' }, { organizationId: 'org_northstar', uid: 'user_reviewer', role: 'reviewer' });
  await expect(code).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: /Use the SaySpec desktop app|Access changed/ })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('server plan (Free, Beta, Pro) without prices; directory names from Firebase Auth', async ({ page }) => {
  await signIn(page, 'tester@sayspec.local', PASSWORD, '/portal/team');
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Northstar QA (synthetic) · Owner' });
  // memberDirectorySync backfilled the seeded (legacy) memberships from Auth.
  await expect(page.getByRole('row', { name: /…viewer/ })).toContainText('reviewer@sayspec.local');
  await expect(page.getByText('Names and emails of other members are not available yet')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Add user|Reset password/ })).toHaveCount(0);

  await page.goto('/portal/billing?checkout=success&session_id=cs_live_fake&plan=paid');
  const plan = page.locator('section[aria-labelledby="plan-heading"]');
  const paid = page.locator('section[aria-labelledby="paid-heading"]');
  await expect(plan.getByRole('heading', { name: 'Free plan' })).toBeVisible();
  await expect(plan).toContainText('Beta adds Pro features such as SaySpec Cloud test storage.');
  await expect(page.getByRole('meter', { name: 'Seats used' })).toHaveAttribute('aria-valuetext', '2 of 4 seats used');
  await expect(paid.getByText('Coming soon', { exact: true })).toBeVisible();
  await expect(page.getByText('Demo data')).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toMatch(/[€$]\s?\d/);
  await expect(page.getByRole('button', { name: /Upgrade|Checkout|Manage subscription|Payments/ })).toHaveCount(0);

  // An operator plan change (set-plan.mjs) shows up live.
  const organization = getFirestore(admin).doc('organizations/org_northstar');
  await organization.update({ 'plan.kind': 'beta' });
  await expect(plan.getByRole('heading', { name: /Beta plan/ })).toContainText('Pro features');
  await expect(plan).toContainText('SaySpec Cloud test storage for Web projects');
  await expect(paid.getByText('Coming soon', { exact: true })).toBeVisible();
  // Pro is modeled but not offered: no prices or checkout, and no paid-plan teaser.
  await organization.update({ 'plan.kind': 'pro' });
  await expect(plan.getByRole('heading', { name: 'Pro plan' })).toBeVisible();
  await expect(plan).toContainText('SaySpec Cloud test storage for Web projects');
  await expect(paid).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toMatch(/[€$]\s?\d/);
  await page.getByRole('link', { name: 'Team' }).click();
  await expect(page.locator('section[aria-labelledby="seats-heading"]').getByRole('link', { name: 'Pro plan' })).toBeVisible();
  await organization.update({ 'plan.kind': 'free' });

  const org = (await organization.get()).data() ?? {};
  expect(Object.keys(org).some((key) => /billing|subscription|checkout/i.test(key))).toBe(false);
});

test('sign-up creates one Auth identity and one workspace via organizationCreate', async ({ page }) => {
  const email = `owner-${Date.now()}@sayspec.local`;
  await page.goto('/sign-up');
  await page.getByLabel('Password', { exact: true }).fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Use at least 8 characters.')).toBeVisible();
  await page.getByLabel('Your name').fill('Owen Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('a-new-owner-password');
  await page.getByLabel('Workspace name').fill('Owen QA');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/portal/account');
  await expect(page.getByText('Selected workspace').locator('..')).toContainText('Owen QA');
  await expect(page.getByText('Your role').locator('..')).toContainText('Owner');
  await expect(page.getByText('Workspace owner').locator('..')).toContainText('You');

  const user = await getAuth(admin).getUserByEmail(email);
  expect(user.displayName).toBe('Owen Owner');
  const scopes = await getFirestore(admin).collection(`userScopes/${user.uid}/organizations`).get();
  expect(scopes.size).toBe(1);
  expect(scopes.docs[0].data()).toMatchObject({ name: 'Owen QA', role: 'owner', status: 'active' });
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain('a-new-owner-password');

  await signOut(page);
  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('another-password');
  await page.getByLabel('Workspace name').fill('Duplicate');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('An account may already use this email.')).toBeVisible();
  expect((await getFirestore(admin).collection(`userScopes/${user.uid}/organizations`).get()).size).toBe(1);
});

test('password recovery uses a neutral response for known and unknown emails', async ({ page }) => {
  for (const email of ['tester@sayspec.local', 'nobody-here@sayspec.local']) {
    await page.goto('/reset-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('If an account exists for that email, a password reset link is on its way.')).toBeVisible();
  }
});

test('profile edit, password change with reauthentication, sign-out and sign-in again', async ({ page }) => {
  const email = `profile-${Date.now()}@sayspec.local`;
  await getAuth(admin).createUser({ email, password: 'first-password-1', displayName: 'Pia Profile' });
  await signIn(page, email, 'first-password-1');
  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible();
  await page.getByLabel('Workspace name').fill('Pia Space');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByText('Selected workspace').locator('..')).toContainText('Pia Space');

  await page.getByLabel('Name', { exact: true }).fill('Pia Renamed');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByText('Name saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Pia Renamed');
  expect((await getAuth(admin).getUserByEmail(email)).displayName).toBe('Pia Renamed');

  await page.getByLabel('Current password').fill('not-my-password');
  await page.getByLabel('New password', { exact: true }).fill('second-password-2');
  await page.getByLabel('Confirm new password').fill('second-password-2');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Your current password is incorrect.')).toBeVisible();
  await expect(page.getByLabel('Current password')).toHaveValue('');
  await page.getByLabel('Current password').fill('first-password-1');
  await page.getByLabel('New password', { exact: true }).fill('second-password-2');
  await page.getByLabel('Confirm new password').fill('second-password-2');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed.')).toBeVisible();

  await signOut(page);
  await page.goto('/portal/account');
  await expect(page).toHaveURL('/sign-in?next=%2Fportal%2Faccount');
  await signIn(page, email, 'second-password-2');
  await expect(page.getByText('Selected workspace').locator('..')).toContainText('Pia Space');
});

test('disabled account and revoked membership states', async ({ page }) => {
  const email = `disabled-${Date.now()}@sayspec.local`;
  await getAuth(admin).createUser({ email, password: 'disabled-password', disabled: true });
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('disabled-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('This account has been disabled.')).toBeVisible();

  // The reviewer (a tester) is signed in while the owner removes them through memberChange.
  const reviewer = await page.context().browser()!.newContext();
  const reviewerPage = await reviewer.newPage();
  await signIn(reviewerPage, 'reviewer@sayspec.local', PASSWORD, '/portal/team');
  await expect(reviewerPage.getByRole('listitem').filter({ hasText: 'Northstar QA (synthetic)' })).toBeVisible();

  await signIn(page, 'tester@sayspec.local', PASSWORD, '/portal/team');
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Northstar QA (synthetic) · Owner' });
  await page.getByRole('row', { name: /…viewer/ }).getByRole('button', { name: /Remove/ }).click();
  await page.getByRole('dialog', { name: /Remove/ }).getByRole('button', { name: /Remove from Northstar/ }).click();
  await expect(page.getByRole('row', { name: /…viewer/ })).toContainText('Removed');
  await expect(page.getByRole('meter', { name: 'Seats used' })).toHaveAttribute('aria-valuetext', '1 of 4 seats used');

  // Their live workspace list drops Northstar; with no memberships left they see the setup state.
  await expect(reviewerPage.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible();
  await expect(reviewerPage.getByRole('listitem').filter({ hasText: 'Northstar QA (synthetic)' })).toHaveCount(0);
  // The global identity still exists.
  expect((await getAuth(admin).getUserByEmail('reviewer@sayspec.local')).disabled).toBe(false);
  await reviewer.close();
});
