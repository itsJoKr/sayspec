import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronBinary from 'electron';
import { SavedWebTestStore } from '../electron/execution/saved-web-tests.ts';

/**
 * Built Electron Pro managed-fix acceptance.
 *
 * Runs against the Firebase emulators: real sign-in, real trusted callables for
 * decision and apply authorization, real Chromium failure, visible Claude fix
 * session, explicit approval, an injected mid-apply interruption, and a retry
 * that records the applied-version anchor idempotently.
 *
 * Requires `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST` and the
 * seeded fixtures: see `npm run test:native:managed-fix:pro`.
 */
const sha = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const cwd = new URL('..', import.meta.url).pathname;
const profile = await mkdtemp(path.join(tmpdir(), 'sayspec-fix-pro-'));
const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<h1>Ready</h1>'); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}/`;
const organizationId = 'org_northstar';
const projectId = 'project_storefront';
const source = "import { test, expect } from '@playwright/test';\ntest('ready heading', async ({ page }) => {\n  await page.goto('/');\n  await expect(page.getByRole('heading', { name: 'Old', exact: true })).toBeVisible();\n});";
const steps = [{ id: 'step_one', instruction: 'Open page', assertion: 'Old heading visible', intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }];
const files = [{ id: 'file_one', relativePath: 'tests/ready.spec.ts', text: source, sha256: sha(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' }];
const runtime = { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: files[0].relativePath, dependencies: { '@playwright/test': '1.63.0' }, requirements: ['Node.js >=22.12.0', 'Playwright Chromium installed'] };
const bundle = { schemaVersion: 1, kind: 'sayspec-playwright-bundle', exportedAt: new Date().toISOString(), original: { testId: 'source_test', versionId: 'source_version', contentHash: sha(canonical({ steps, files, runtime })), state: 'execution-validated' }, title: 'Ready heading', steps, files, runtime, secretPlaceholders: ['BASE_URL'], provenance: { provider: 'claude-code', cliVersion: 'fixture', inputRevisionHash: 'a'.repeat(64), generatedAt: new Date().toISOString() } };

async function launch(extraEnv = {}) {
  const app = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd, env: { ...process.env, SAYSPEC_TEST_MODE: '1', SAYSPEC_TEST_USER_DATA: profile, ...extraEnv }, timeout: 30_000 });
  return { app, page: await app.firstWindow() };
}

/** Signs in through the real Auth emulator, then selects the Pro project. */
async function signIn(page) {
  await page.getByRole('button', { name: /Sign in/ }).first().click();
  await page.locator('.auth-form input[type=email]').fill('tester@sayspec.local');
  await page.locator('.auth-form input[type=password]').fill('local-only-password');
  await page.locator('.auth-form button[type=submit]').click();
  await page.locator('nav').waitFor({ timeout: 30_000 });
  await page.locator('.topbar-context, .workspace-switcher').first().waitFor({ timeout: 20_000 }).catch(() => undefined);
}

let instance;
try {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('This acceptance run needs the Firebase emulators (FIRESTORE_EMULATOR_HOST is unset).');
  instance = await launch({ SAYSPEC_TEST_FAIL_APPLIED_RECORD: '1' });
  let { app, page } = instance;
  await signIn(page);

  // Import a managed Web version into the Pro project and fail it for real.
  await page.locator('nav button', { hasText: 'Runs' }).click();
  await page.locator('.saved-runs input[type=file]').waitFor({ timeout: 20_000 });
  await page.locator('.saved-runs input[type=file]').setInputFiles({ name: 'old-heading.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
  await page.getByRole('button', { name: 'Import as new test' }).click();
  await page.getByText('Imported as a new generated test.', { exact: false }).waitFor({ timeout: 30_000 });
  const imported = await page.evaluate(async ({ organizationId, projectId }) => {
    const versions = await window.sayspec.listProjectWebTestVersions({ organizationId, projectId });
    return versions.at(-1);
  }, { organizationId, projectId });
  assert.ok(imported, 'the imported version must be addressable through the bridge');
  await page.locator('nav button', { hasText: 'Tests' }).click();
  const checkbox = page.locator('.test-table tbody input[type=checkbox]').first();
  await checkbox.waitFor({ timeout: 20_000 });
  await checkbox.check();
  await page.getByTestId('create-test-run').click();
  await page.getByRole('dialog').getByLabel('Web base URL').fill(baseUrl);
  await page.getByRole('dialog').getByRole('button', { name: 'Create Test Run' }).click();
  await page.locator('.run-detail-panel').waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Start test run' }).click();
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const state = await page.evaluate(async ({ organizationId, projectId, testId }) => (await window.sayspec.listSavedWebTestAttempts({ organizationId, projectId, testId }))[0]?.state ?? null, { organizationId, projectId, testId: imported.testId });
    if (state && !['preparing', 'running'].includes(state)) { assert.equal(state, 'failed'); break; }
    await page.waitForTimeout(500);
  }
  const firstAttempt = await page.evaluate(async ({ organizationId, projectId, testId }) => (await window.sayspec.listSavedWebTestAttempts({ organizationId, projectId, testId }))[0], { organizationId, projectId, testId: imported.testId });
  assert.equal(firstAttempt.state, 'failed');
  await app.close();

  // Seed a complete test-category analysis, mirroring what a real provider run
  // produces, then reopen so the fix session starts from a frozen attempt.
  const store = new SavedWebTestStore(path.join(profile, 'saved-web-tests')); await store.initialize();
  await store.saveFailureAnalysis({
    schemaVersion: 1, id: 'analysis_pro_fix', organizationId, projectId, testId: imported.testId, attemptId: firstAttempt.id,
    versionId: firstAttempt.versionId, testVersionHash: firstAttempt.testVersionHash, inputHash: 'c'.repeat(64), createdAt: new Date().toISOString(),
    status: 'complete', provider: 'claude-code', expected: 'Old heading', actual: 'Ready heading', category: 'test',
    explanation: 'The saved selector still names Old while the page displays Ready.', limitations: 'Pro acceptance fixture for this failed attempt.',
    nextStep: 'Review a selector update.', evidenceIds: ['e01'], evidence: [{ id: 'e01', kind: 'framework', label: 'Failed Playwright attempt', text: firstAttempt.summary }],
  });

  instance = await launch({ SAYSPEC_TEST_FAIL_APPLIED_RECORD: '1' });
  ({ app, page } = instance);
  await signIn(page);
  await page.locator('nav button', { hasText: 'Runs' }).click();
  await page.locator('.run-attempt').first().locator(':scope > summary').click();
  await page.getByRole('button', { name: 'Fix with AI' }).waitFor({ timeout: 30_000 });
  await page.evaluate(() => { window.__fixEvents = []; window.sayspec.onManagedFixTerminalEvent((event) => { if (event.kind === 'data') window.__fixEvents.push(event.data ?? ''); }); });
  await page.getByRole('button', { name: 'Fix with AI' }).click();
  // Claude Code's workspace-trust prompt is a human decision. This script hands
  // it back rather than synthesising keystrokes into the TUI, unless
  // SAYSPEC_FIX_DRIVE_CLAUDE=1 is set deliberately.
  const trustSeen = await page.waitForFunction(() => /trust this folder/i.test((window.__fixEvents ?? []).join('')), null, { timeout: 90_000 }).then(() => true).catch(() => false);
  if (trustSeen && process.env.SAYSPEC_FIX_DRIVE_CLAUDE !== '1') {
    const tail = await page.evaluate(() => (window.__fixEvents ?? []).join('').slice(-1_500));
    process.stdout.write(`MANUAL_CLAUDE_PROMPT_REQUIRED=${JSON.stringify({
      stage: 'workspace-trust',
      workspace: /(\/[^\s\u001b]*fix-attempt[^\s\u001b]*)/.exec(tail)?.[1],
      instruction: 'Answer the workspace-trust prompt in the Fixes terminal, then rerun this script to continue through approval, the injected receipt interruption and recovery.',
      verifiedBeforePrompt: ['Pro sign-in', 'real Chromium failed attempt synchronized to Pro', 'analysis seeded', 'Pro startManagedFixSession authorized', 'Claude Code TUI rendered'],
    })}\n`);
    await app.close();
    process.exit(0);
  }
  if (trustSeen) {
    await page.locator('.fix-terminal__screen').click();
    await page.waitForTimeout(500);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3_000);
  }
  await page.getByRole('button', { name: 'Approve exact patch' }).waitFor({ timeout: 300_000 });
  await page.getByRole('button', { name: 'Approve exact patch' }).click();
  try {
    await page.getByRole('button', { name: 'Apply approved patch' }).waitFor({ timeout: 30_000 });
  } catch (error) {
    process.stderr.write(`PRO_APPROVAL_TAIL=${JSON.stringify(await page.evaluate(() => (window.__fixEvents ?? []).join('').slice(-2_000)))}\n`);
    throw error;
  }
  await page.getByRole('button', { name: 'Apply approved patch' }).click();

  // Injected interruption: the local version exists, the Pro receipt fails.
  await page.getByText('injected interruption', { exact: false }).waitFor({ timeout: 60_000 });
  const afterInterruption = await page.evaluate(async ({ organizationId, projectId, testId }) => ({
    versions: await window.sayspec.listProjectWebTestVersions({ organizationId, projectId }),
    attempts: await window.sayspec.listSavedWebTestAttempts({ organizationId, projectId, testId }),
    proposals: await window.sayspec.listManagedFixProposals({ organizationId, projectId, testId }),
  }), { organizationId, projectId, testId: imported.testId });
  assert.equal(afterInterruption.versions.filter((version) => version.testId === imported.testId).length, 2, 'the local immutable version must exist despite the failed receipt');
  assert.equal(afterInterruption.proposals.find((item) => item.status === 'applied') !== undefined, true);
  assert.ok(afterInterruption.attempts.length >= 1);

  // Retry sync and validation records the same anchor and reruns the version.
  await page.getByRole('button', { name: 'Retry sync and validation' }).click();
  await page.getByText('validation:', { exact: false }).waitFor({ timeout: 120_000 });
  const recovered = await page.evaluate(async ({ organizationId, projectId, testId }) => ({
    attempts: await window.sayspec.listSavedWebTestAttempts({ organizationId, projectId, testId }),
    proposals: await window.sayspec.listManagedFixProposals({ organizationId, projectId, testId }),
  }), { organizationId, projectId, testId: imported.testId });
  assert.deepEqual(recovered.attempts.map((item) => item.state).slice(0, 2), ['failed', 'passed']);
  assert.equal(recovered.proposals.filter((item) => item.status === 'applied').length, 1);
  assert.equal(await page.evaluate(async ({ organizationId, projectId, testId }) => {
    const versions = await window.sayspec.listProjectWebTestVersions({ organizationId, projectId });
    return versions.filter((version) => version.testId === testId).length;
  }, { organizationId, projectId, testId: imported.testId }), 2);
  await app.close();

  instance = await launch();
  ({ app, page } = instance);
  await signIn(page);
  await page.locator('nav button', { hasText: 'Fixes' }).click();
  await page.getByText('Applied as version', { exact: false }).waitFor({ timeout: 30_000 });
  console.log(`PRO_FIX_RESULT=${JSON.stringify({
    organizationId, projectId, testId: imported.testId,
    attempts: recovered.attempts.map((item) => item.state),
    appliedProposals: recovered.proposals.filter((item) => item.status === 'applied').length,
    versionCount: 2, versionAnchor: recovered.proposals.find((item) => item.status === 'applied')?.appliedVersionId,
    interruptedReceiptRecovered: true, reopened: true,
  })}`);
} finally {
  try { await instance?.app.close(); } catch { /* already closed */ }
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
