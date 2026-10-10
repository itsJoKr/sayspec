// FIXTURE-ONLY SUITE. Runs against `vite build --mode fixtures` served by the
// Firebase Hosting emulator. Company-code, member and billing behaviour here
// is development fixture data — it proves UI states, not backend integrations.
import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, email = 'owner@demo.sayspec.test', path = '/portal/account') {
  await page.goto(`/sign-in?next=${encodeURIComponent(path)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('demo-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(path);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page).toHaveURL(/\/sign-in\?reason=signed-out/);
}

async function scenario(page: Page, label: 'Team scenario', value: string) {
  const panel = page.locator('details.demo-panel');
  if (!(await panel.evaluate((node) => (node as HTMLDetailsElement).open))) await panel.locator('summary').click();
  await panel.getByLabel(label).selectOption(value);
}

test('fixture build is visibly labeled as demo data', async ({ page }) => {
  await page.goto('/get-app');
  await expect(page.getByText('Demo data · development fixtures')).toBeVisible();
  await signIn(page);
  await expect(page.getByText('Demo data · development fixtures')).toBeVisible();
});

test('free plan: seat usage, coming soon, no prices, return URLs change nothing', async ({ page }) => {
  await signIn(page, undefined, '/portal/billing');
  const plan = page.locator('section[aria-labelledby="plan-heading"]');
  await expect(plan.getByRole('heading', { name: 'Free plan' })).toBeVisible();
  await expect(plan).toContainText('No payment details are needed.');
  await expect(plan).toContainText('Beta adds Pro features such as SaySpec Cloud test storage.');
  await expect(plan).toContainText('Up to 4 seats, including the owner');
  await expect(plan.getByRole('meter', { name: 'Seats used' })).toHaveAttribute('aria-valuetext', '3 of 4 seats used');
  await expect(plan.getByText('Demo data')).toBeVisible();
  const paid = page.locator('section[aria-labelledby="paid-heading"]');
  await expect(paid.getByText('Coming soon', { exact: true })).toBeVisible();
  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/[€$]\s?\d/);
  await expect(page.getByRole('button', { name: /Upgrade|Checkout|Manage subscription|Payments/ })).toHaveCount(0);
  await expect(page.locator('input[autocomplete^="cc-"], input[name*="card" i]')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Portal' }).getByRole('link', { name: 'Plan' })).toHaveAttribute('aria-current', 'page');

  await page.goto('/portal/billing?checkout=success&session_id=cs_test_fake&status=active&seats=9');
  await expect(plan.getByRole('meter', { name: 'Seats used' })).toHaveAttribute('aria-valuetext', '3 of 4 seats used');
  await expect(plan).toContainText('Up to 4 seats');
  await expect(page.getByText(/renews|Active ·|subscription/i)).toHaveCount(0);
});

test('company code: show, copy, rotate, turn off and on, simulated desktop join', async ({ page }) => {
  await signIn(page, undefined, '/portal/team');
  const panel = page.locator('section[aria-labelledby="code-heading"]');
  await expect(panel.getByText('KXMP-QRTA')).toBeVisible();
  await expect(panel.getByText('Joining on')).toBeVisible();
  await expect(panel).toContainText('join Acme QA (demo) right away as Editor');

  await panel.getByRole('button', { name: 'Generate new code' }).click();
  const confirm = page.getByRole('dialog', { name: 'Generate a new company code?' });
  await expect(confirm).toContainText('The current code stops working immediately.');
  await confirm.getByRole('button', { name: 'Generate new code' }).click();
  await expect(page.getByText('A new company code is ready. The previous code no longer works.')).toBeVisible();
  const code = await panel.locator('output.join-code').textContent();
  expect(code).toMatch(/^[A-HJ-NP-Z]{4}-[A-HJ-NP-Z]{4}$/);
  expect(code).not.toBe('KXMP-QRTA');

  const demo = page.locator('details.demo-panel');
  await demo.locator('summary').click();
  await demo.getByRole('button', { name: 'Simulate a tester joining with the code' }).click();
  const joiner = page.getByRole('row', { name: /New Tester/ });
  await expect(joiner).toContainText('Editor');
  await expect(joiner).toContainText('Joined with company code');
  await expect(page.getByRole('meter', { name: 'Seats used' })).toHaveAttribute('aria-valuetext', '4 of 4 seats used');
  await expect(page.getByText('All 4 seats are in use.')).toBeVisible();
  // The seat limit rejects a fifth member.
  await demo.getByRole('button', { name: 'Simulate a tester joining with the code' }).click();
  await expect(demo.getByText('All seats are used, so the code was rejected.')).toBeVisible();
  await expect(page.getByRole('row', { name: /New Tester/ })).toHaveCount(1);
  await joiner.getByRole('button', { name: /Remove/ }).click();
  await page.getByRole('dialog', { name: /Remove New Tester/ }).getByRole('button', { name: /Remove from/ }).click();
  await expect(page.getByRole('meter', { name: 'Seats used' })).toHaveAttribute('aria-valuetext', '3 of 4 seats used');

  await panel.getByRole('button', { name: 'Turn off joining' }).click();
  await expect(panel.getByText('Joining off')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Copy' })).toBeDisabled();
  await demo.getByRole('button', { name: 'Simulate a tester joining with the code' }).click();
  await expect(demo.getByText('Joining is off, so the code was rejected.')).toBeVisible();
  await expect(page.getByRole('row', { name: /New Tester/ })).toContainText('Removed');
  await panel.getByRole('button', { name: 'Turn on joining' }).click();
  await expect(panel.getByText('Joining on')).toBeVisible();

  // A workspace without a code offers first-time generation.
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Side Project (demo) · Owner' });
  await panel.getByRole('button', { name: 'Generate company code' }).click();
  await expect(panel.locator('output.join-code')).toHaveText(/^[A-HJ-NP-Z]{4}-[A-HJ-NP-Z]{4}$/);
  await expect(page.getByText('You are the only member of this workspace.')).toBeVisible();
});

test('owner protections, role change and removal with code rotation', async ({ page }) => {
  await signIn(page, undefined, '/portal/team');
  await expect(page.getByRole('button', { name: /Add user|Reset password/ })).toHaveCount(0);
  const ownerRow = page.getByRole('row', { name: /Morgan Owner/ });
  await expect(ownerRow).toContainText('Last owner · protected');
  await expect(ownerRow.getByRole('button', { name: /Remove|Change role/ })).toHaveCount(0);

  const sam = page.getByRole('row', { name: /Sam Member/ });
  await sam.getByRole('button', { name: /Change role/ }).click();
  const roleDialog = page.getByRole('dialog', { name: /Change role for Sam Member/ });
  await roleDialog.getByLabel(/Reviewer/).check();
  await roleDialog.getByRole('button', { name: 'Save role' }).click();
  await expect(page.getByText('Sam Member is now Reviewer.')).toBeVisible();
  await expect(sam).toContainText('Reviewer');

  await page.getByRole('row', { name: /Alex Admin/ }).getByRole('button', { name: /Remove/ }).click();
  const remove = page.getByRole('dialog', { name: 'Remove Alex Admin?' });
  await expect(remove).toContainText('Their SaySpec account and any other workspaces they belong to are not affected.');
  await expect(remove).toContainText('They could join again with the current company code.');
  await remove.getByLabel('Also generate a new company code so they cannot rejoin').check();
  await remove.getByRole('button', { name: 'Remove from Acme QA (demo)' }).click();
  await expect(page.getByText('Alex Admin was removed from Acme QA (demo). A new company code was generated.')).toBeVisible();
  await expect(page.getByRole('row', { name: /Alex Admin/ })).toContainText('No seat');
  await expect(page.locator('output.join-code')).not.toHaveText('KXMP-QRTA');
});

test('team empty, loading and failure states', async ({ page }) => {
  await signIn(page, undefined, '/portal/team');
  await scenario(page, 'Team scenario', 'empty');
  await expect(page.getByText('You are the only member of this workspace.')).toBeVisible();
  await scenario(page, 'Team scenario', 'loading');
  await expect(page.getByText('Loading members…')).toBeVisible();
  await scenario(page, 'Team scenario', 'error');
  await expect(page.getByText('Members could not be loaded.')).toBeVisible();
});

test('testers get the desktop-app page; admins manage team but not billing; switching', async ({ page }) => {
  await signIn(page, 'member@demo.sayspec.test', '/portal/team');
  await expect(page.getByRole('heading', { level: 1, name: 'Use the SaySpec desktop app' })).toBeVisible();
  await expect(page.getByText('Acme QA (demo)')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Portal' })).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Get the desktop app' })).toHaveAttribute('href', '/get-app');
  await signOut(page);

  await signIn(page, 'alex@demo.sayspec.test', '/portal/billing');
  await expect(page.getByRole('heading', { name: /Free plan/ })).toBeVisible();
  await expect(page.getByRole('button')).toHaveText(['Sign out']);
  await page.getByRole('link', { name: 'Team' }).click();
  await expect(page.locator('section[aria-labelledby="code-heading"]').getByText('KXMP-QRTA')).toBeVisible();
  await expect(page.getByRole('row', { name: /Morgan Owner/ }).getByRole('button')).toHaveCount(0);
  await signOut(page);

  await signIn(page, 'owner@demo.sayspec.test', '/portal/account');
  const switcher = page.getByRole('combobox', { name: 'Workspace', exact: true });
  // Only managed workspaces are listed; the owner is a tester in Partner Labs.
  await expect(switcher.locator('option')).toHaveText(['Acme QA (demo) · Owner', 'Side Project (demo) · Owner']);
  await expect(page.getByText('Selected workspace').locator('..')).toContainText('Acme QA (demo)');
  await switcher.selectOption({ label: 'Side Project (demo) · Owner' });
  await expect(page.getByText('Selected workspace').locator('..')).toContainText('Side Project (demo)');
  await page.getByRole('link', { name: 'Team' }).click();
  await expect(page.getByRole('row', { name: /Alex Admin/ })).toHaveCount(0);
  await expect(page.getByText('You are the only member of this workspace.')).toBeVisible();
});

test('access changed and session expiry states', async ({ page }) => {
  await signIn(page, undefined, '/portal/account');
  const panel = page.locator('details.demo-panel');
  await panel.locator('summary').click();
  await panel.getByRole('button', { name: 'Revoke my access here' }).click();
  await expect(page.getByRole('heading', { name: 'Access changed' })).toBeVisible();
  await expect(page.getByText('You no longer manage Acme QA (demo).')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Side Project (demo) · Owner' })).toBeVisible();

  await panel.getByRole('button', { name: 'Expire session' }).click();
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fportal%2Faccount&reason=expired/);
  await expect(page.getByText('Your session ended.')).toBeVisible();
});

test('sign-up with failed workspace provisioning recovers through finish setup', async ({ page }) => {
  await signIn(page, 'new@demo.sayspec.test', '/portal/account');
  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible();
  await signOut(page);

  await page.goto('/sign-up');
  await page.getByLabel('Email').fill('owner@demo.sayspec.test');
  await page.getByLabel('Password', { exact: true }).fill('long-enough-pass');
  await page.getByLabel('Workspace name').fill('Duplicate Co');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('An account may already use this email.')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');

  // Arm the provisioning failure through the demo panel on a portal page first.
  await signIn(page, 'new@demo.sayspec.test', '/portal/account');
  const panel = page.locator('details.demo-panel');
  await panel.locator('summary').click();
  await panel.getByLabel('Fail next workspace setup').check();
  await signOut(page);

  await page.goto('/sign-up');
  await page.getByLabel('Your name').fill('Fresh Owner');
  await page.getByLabel('Email').fill('fresh@demo.sayspec.test');
  await page.getByLabel('Password', { exact: true }).fill('long-enough-pass');
  await page.getByLabel('Workspace name').fill('Fresh Co');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Finish setting up' })).toBeVisible();
  await expect(page.getByText('Your account was created, but the workspace could not be set up.')).toBeVisible();
  await expect(page.getByLabel('Workspace name')).toHaveValue('Fresh Co');
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByText('Selected workspace').locator('..')).toContainText('Fresh Co');
  await expect(page.getByText('Your role').locator('..')).toContainText('Owner');
});

test('keyboard navigation and mobile layout', async ({ page }) => {
  await signIn(page, undefined, '/portal/account');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  const teamLink = page.getByRole('navigation', { name: 'Portal' }).getByRole('link', { name: 'Team' });
  await teamLink.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/portal/team');
  await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeFocused();
  await page.getByRole('button', { name: 'Generate new code' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Generate a new company code?' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Generate a new company code?' })).toBeHidden();
  await expect(page.locator('output.join-code')).toHaveText('KXMP-QRTA');

  for (const path of ['/portal/account', '/portal/billing', '/portal/team', '/get-app', '/sign-in']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
