import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronBinary from 'electron';
import { SavedWebTestStore } from '../electron/execution/saved-web-tests.ts';

/** Local-only builds open the local workspace directly; builds with a cloud backend first offer "Continue as guest". */
async function enterLocalWorkspace(page) {
  const guest = page.getByTestId('continue-guest');
  await guest.or(page.getByTestId('local-project-gate')).or(page.locator('nav')).first().waitFor();
  if (await guest.isVisible()) await guest.click();
}

const sha = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const cwd = new URL('..', import.meta.url).pathname;
const profile = await mkdtemp(path.join(tmpdir(), 'sayspec-fix-native-'));
const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<h1>Ready</h1>'); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const source = "import { test, expect } from '@playwright/test';\ntest('ready heading', async ({ page }) => {\n  await page.goto('/');\n  await expect(page.getByRole('heading', { name: 'Old', exact: true })).toBeVisible();\n});";
const steps = [{ id: 'step_one', instruction: 'Open page', assertion: 'Old heading visible', intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }];
const files = [{ id: 'file_one', relativePath: 'tests/ready.spec.ts', text: source, sha256: sha(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' }];
const runtime = { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: files[0].relativePath, dependencies: { '@playwright/test': '1.63.0' }, requirements: ['Node.js >=22.12.0', 'Playwright Chromium installed'] };
const bundle = { schemaVersion: 1, kind: 'sayspec-playwright-bundle', exportedAt: new Date().toISOString(), original: { testId: 'source_test', versionId: 'source_version', contentHash: sha(canonical({ steps, files, runtime })), state: 'execution-validated' }, title: 'Ready heading', steps, files, runtime, secretPlaceholders: ['BASE_URL'], provenance: { provider: 'claude-code', cliVersion: 'fixture', inputRevisionHash: 'a'.repeat(64), generatedAt: new Date().toISOString() } };
async function launch() { const app = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd, env: { ...process.env, SAYSPEC_TEST_MODE: '1', SAYSPEC_TEST_USER_DATA: profile }, timeout: 30_000 }); return { app, page: await app.firstWindow() }; }

/** Imports the fixture bundle, then creates and starts a single-test saved run. */
async function importAndRun(page, baseUrl) {
  await page.getByTestId('local-project-gate').waitFor({ timeout: 20_000 });
  await page.locator('#field-project-name').fill('Fix review');
  await page.locator('#field-base-url').fill(baseUrl);
  await page.getByTestId('local-project-create').click();
  await page.getByTestId('onboarding-finish').click();
  await page.locator('nav button', { hasText: 'Runs' }).click();
  await page.locator('.saved-runs input[type=file]').waitFor({ timeout: 20_000 });
  await page.locator('.saved-runs input[type=file]').setInputFiles({ name: 'old-heading.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
  await page.getByRole('button', { name: 'Import as new test' }).click();
  await page.getByText('Imported as a new generated test.', { exact: false }).waitFor({ timeout: 20_000 });
  await page.locator('nav button', { hasText: 'Tests' }).click();
  const checkbox = page.locator('.test-table tbody input[type=checkbox]').first();
  await checkbox.waitFor({ timeout: 20_000 });
  await checkbox.check();
  await page.getByTestId('create-test-run').click();
  await page.getByRole('dialog').getByLabel('Web base URL').fill(baseUrl);
  await page.getByRole('dialog').getByRole('button', { name: 'Create run' }).click();
  await page.locator('.run-detail-panel').waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Start test run' }).click();
}

/** Waits for the first attempt of the newest run to reach a terminal state. */
async function waitForAttempt(page) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const state = await page.evaluate(async () => {
      const ws = await window.sayspec.getLocalWorkspace();
      const runs = await window.sayspec.listSavedWebRuns({ organizationId: 'local', projectId: ws.projects[0].id });
      const run = runs.at(-1);
      if (!run || !run.items.length) return null;
      const attempts = await window.sayspec.listSavedWebTestAttempts({ organizationId: 'local', projectId: ws.projects[0].id, testId: run.items[0].testId });
      return attempts[0]?.state ?? null;
    });
    if (state && !['preparing', 'running'].includes(state)) return state;
    await page.waitForTimeout(500);
  }
  throw new Error('The saved run did not finish.');
}

let instance;
try {
  instance = await launch(); let { app, page } = instance;
  await enterLocalWorkspace(page);
  await page.evaluate(() => window.sayspec.selectCodingAgentProvider({ provider: 'claude-code' }));
  await importAndRun(page, `http://127.0.0.1:${address.port}/`);
  const attemptState = await waitForAttempt(page);
  assert.equal(attemptState, 'failed');
  const first = await page.evaluate(async () => {
    const ws = await window.sayspec.getLocalWorkspace(); const projectId = ws.projects[0].id;
    const version = (await window.sayspec.listProjectWebTestVersions({ organizationId: 'local', projectId }))[0];
    const attempt = (await window.sayspec.listSavedWebTestAttempts({ organizationId: 'local', projectId, testId: version.testId }))[0];
    return { projectId, version, attempt };
  });
  assert.equal(first.attempt.state, 'failed'); await app.close();
  const store = new SavedWebTestStore(path.join(profile, 'saved-web-tests')); await store.initialize();
  await store.saveFailureAnalysis({ schemaVersion: 1, id: 'analysis_native_fix', organizationId: 'local', projectId: first.projectId, testId: first.version.testId, attemptId: first.attempt.id, versionId: first.version.id, testVersionHash: first.version.contentHash,
    inputHash: 'b'.repeat(64), createdAt: new Date().toISOString(), status: 'complete', provider: 'claude-code', expected: 'Old heading', actual: 'Ready heading', category: 'test', explanation: 'The saved selector still names Old while the current page displays Ready.', limitations: 'Fixture review of this failed attempt.', nextStep: 'Review a selector update.', evidenceIds: ['e01'], evidence: [{ id: 'e01', kind: 'framework', label: 'Failed Playwright attempt', text: first.attempt.summary }] });
  instance = await launch(); ({ app, page } = instance); await enterLocalWorkspace(page);
  await page.locator('nav button', { hasText: 'Runs' }).click();
  await page.locator('.run-attempt').first().locator(':scope > summary').click();
  await page.getByRole('button', { name: 'Fix with AI' }).waitFor({ timeout: 20_000 });
  await page.evaluate(() => { window.__fixEvents = []; window.sayspec.onManagedFixTerminalEvent((event) => { if (event.kind === 'data') window.__fixEvents.push(event.data ?? ''); }); });
  await page.getByRole('button', { name: 'Fix with AI' }).click();
  const terminalTail = async () => page.evaluate(() => (window.__fixEvents ?? []).join('').slice(-3_000));
  /** Answers Claude Code's workspace-trust prompt, then waits for the TUI to settle. */
  /**
   * Claude Code's workspace-trust prompt is a human decision.
   *
   * SaySpec launches a real interactive Claude session on purpose, so this
   * script watches for the prompt and hands control back with the exact
   * instruction instead of synthesising keystrokes into the TUI. Set
   * SAYSPEC_FIX_DRIVE_CLAUDE=1 only if you deliberately want the script to
   * answer it for you.
   */
  async function handOffIfClaudeAsksForTrust() {
    const seen = await page.waitForFunction(() => /trust this folder/i.test((window.__fixEvents ?? []).join('')), null, { timeout: 90_000 }).then(() => true).catch(() => false);
    if (!seen) return false;
    if (process.env.SAYSPEC_FIX_DRIVE_CLAUDE === '1') {
      await page.locator('.fix-terminal__screen').click();
      await page.waitForTimeout(500);
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(400);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3_000);
      return false;
    }
    const tail = await page.evaluate(() => (window.__fixEvents ?? []).join('').slice(-1_500));
    const workspace = /(\/[^\s\u001b]*fix-attempt[^\s\u001b]*)/.exec(tail)?.[1];
    process.stdout.write(`MANUAL_CLAUDE_PROMPT_REQUIRED=${JSON.stringify({
      stage: 'workspace-trust',
      workspace,
      instruction: 'Claude Code is waiting for the workspace-trust answer in the Fixes terminal. Answer it there (arrow down to "Yes, I trust this folder", then Enter); the session continues and SaySpec records the proposal when Claude submits it.',
      verifiedBeforePrompt: ['real Chromium failure attempt', 'failure analysis with Fix with AI', 'visible Claude fix session started', 'Claude Code TUI rendered'],
    })}\n`);
    return true;
  }
  if (await handOffIfClaudeAsksForTrust()) {
    await app.close();
    process.exitCode = 0;
    process.exit(0);
  }
  try {
    await page.getByRole('button', { name: 'Approve exact patch' }).waitFor({ timeout: 300_000 });
  } catch (error) {
    process.stderr.write(`FIX_TERMINAL_TAIL=${JSON.stringify(await terminalTail())}\n`);
    throw error;
  }
  await page.getByRole('button', { name: 'Approve exact patch' }).click();
  await page.getByRole('button', { name: 'Apply approved patch' }).waitFor();
  await page.getByRole('button', { name: 'Apply approved patch' }).click();
  await page.getByText('validation: passed', { exact: false }).waitFor({ timeout: 90_000 });
  const result = await page.evaluate(async (projectId) => {
    const versions = await window.sayspec.listProjectWebTestVersions({ organizationId: 'local', projectId });
    const attempts = await window.sayspec.listSavedWebTestAttempts({ organizationId: 'local', projectId, testId: versions[0].testId });
    const proposals = await window.sayspec.listManagedFixProposals({ organizationId: 'local', projectId, testId: versions[0].testId });
    return { versions, attempts, proposals };
  }, first.projectId);
  assert.equal(result.versions.length, 2); assert.deepEqual(result.attempts.map((item) => item.state), ['failed', 'passed']);
  assert.equal(result.proposals[0].status, 'applied'); assert.equal(result.versions[0].files[0].text, source);
  await app.close(); instance = await launch(); ({ app, page } = instance); await enterLocalWorkspace(page);
  await page.locator('nav button', { hasText: 'Fixes' }).click();
  await page.getByText('Applied as version', { exact: false }).waitFor();
  console.log(`NATIVE_FIX_RESULT=${JSON.stringify({ attempts: result.attempts.map((item) => item.state), versions: result.versions.map((item) => item.version), proposalStatus: result.proposals[0].status, trustAnswered: false, reopened: true })}`);
} finally { try { await instance?.app.close(); } catch { /* already closed */ } await new Promise((resolve) => server.close(resolve)); await rm(profile, { recursive: true, force: true }); }
