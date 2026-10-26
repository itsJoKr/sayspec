import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronBinary from 'electron';
import { SavedWebTestStore } from '../electron/execution/saved-web-tests.ts';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const cwd = new URL('..', import.meta.url).pathname;
const root = await mkdtemp(path.join(tmpdir(), 'sayspec-app-fix-web-'));
const profile = path.join(root, 'profile'); const sourcePath = path.join(root, 'web-source');
await cp(new URL('../../../fixtures/web_sample_app', import.meta.url).pathname, sourcePath, { recursive: true });
const fixtureCli = path.join(root, 'fixture-claude.mjs');
await writeFile(fixtureCli, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Local-only builds open the local workspace directly; builds with a cloud backend first offer "Continue as guest". */
async function enterLocalWorkspace(page) {
  const guest = page.getByTestId('continue-guest');
  await guest.or(page.getByTestId('local-project-gate')).or(page.locator('nav')).first().waitFor();
  if (await guest.isVisible()) await guest.click();
}
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('claude 2.1.269'); process.exit(0); }
if (args[0] === 'auth') { console.log('{"loggedIn":true}'); process.exit(0); }
const match = args[0]?.match(/Read (sessions\\/[^/]+\\/SKILL\\.md)/);
if (!match || args.includes('--safe-mode')) process.exit(11);
const directory = path.dirname(match[1]);
const context = JSON.parse(readFileSync(path.join(directory, 'source-context.json'), 'utf8'));
const staged = path.join(context.contextDirectory, 'app.js');
const base = readFileSync(staged, 'utf8');
const patched = base.replace('correctSubtotal - 500', 'correctSubtotal');
if (patched === base) process.exit(12);
let outsideDenied = false;
try { writeFileSync(${JSON.stringify(path.join(sourcePath, 'unauthorized-probe.txt'))}, 'should not write'); } catch { outsideDenied = true; }
if (!outsideDenied) process.exit(13);
try { writeFileSync(staged, 'should not write'); process.exit(14); } catch { /* staged source is read only */ }
writeFileSync(path.join(directory, 'proposal.json'), JSON.stringify({ rationale: 'Remove the intentional cart subtraction so the retained $12 assertion can pass.', changes: [{ relativePath: 'app.js', text: patched }] }));
console.log('DETERMINISTIC_APPLICATION_PROPOSAL_STAGED OUTSIDE_WRITE_DENIED');
setTimeout(() => process.exit(0), 4000);
`); await chmod(fixtureCli, 0o755);
const freePort = async () => { const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; };
const port = await freePort(); const baseUrl = `http://127.0.0.1:${port}/`;
const child = spawn('node', ['server.mjs'], { cwd: sourcePath, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
for (let i = 0; i < 60; i++) { try { if ((await fetch(baseUrl)).ok) break; } catch { /* starting */ } await new Promise((resolve) => setTimeout(resolve, 100)); }
const source = `import { test, expect } from '@playwright/test';\ntest('cart total remains twelve dollars', async ({ page }) => { await page.goto('/?bug=cart-total'); await page.getByTestId('add-to-cart-coffee').click(); await page.getByTestId('cart-button').click(); await expect(page.getByTestId('cart-total')).toHaveText('$12.00'); });`;
const steps = [{ id: 'step_cart_total', instruction: 'Add coffee to the basket', assertion: 'Total is $12.00', intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }];
const files = [{ id: 'file_cart', relativePath: 'tests/cart.spec.ts', text: source, sha256: sha(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' }];
const runtime = { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: files[0].relativePath, dependencies: { '@playwright/test': '1.63.0' }, requirements: ['Node.js >=22.12.0', 'Playwright Chromium installed'] };
const bundle = { schemaVersion: 1, kind: 'sayspec-playwright-bundle', exportedAt: new Date().toISOString(), original: { testId: 'source_cart', versionId: 'version_cart', contentHash: sha(canonical({ steps, files, runtime })), state: 'execution-validated' }, title: 'Cart total', steps, files, runtime, secretPlaceholders: ['BASE_URL'], provenance: { provider: 'claude-code', cliVersion: 'deterministic-fixture', inputRevisionHash: 'a'.repeat(64), generatedAt: new Date().toISOString() } };
async function launch() { const app = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd, env: { ...process.env, SAYSPEC_TEST_MODE: '1', SAYSPEC_TEST_USER_DATA: profile, SAYSPEC_TEST_SOURCE_DIRECTORY: sourcePath, SAYSPEC_CLAUDE_CLI: fixtureCli }, timeout: 30_000 }); return { app, page: await app.firstWindow() }; }
let instance;
try {
  instance = await launch(); let { app, page } = instance;
  await enterLocalWorkspace(page);
  await page.locator('#field-project-name').fill('App fix Web fixture'); await page.locator('#field-base-url').fill(baseUrl); await page.getByTestId('local-project-create').click(); await page.getByTestId('onboarding-finish').click();
  await page.evaluate(() => window.sayspec.selectCodingAgentProvider({ provider: 'claude-code' }));
  await page.locator('nav button', { hasText: 'Runs' }).click();
  await page.locator('.saved-runs input[type=file]').setInputFiles({ name: 'cart.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
  await page.getByRole('button', { name: 'Import as new test' }).click();
  await page.getByText('Imported as a new generated test.', { exact: false }).waitFor();
  await page.locator('nav button', { hasText: 'Tests' }).click();
  await page.locator('.test-table tbody input[type=checkbox]').first().check(); await page.getByTestId('create-test-run').click();
  await page.getByRole('dialog').getByLabel('Web base URL').fill(baseUrl); await page.getByRole('dialog').getByRole('button', { name: 'Create run' }).click();
  await page.getByRole('button', { name: 'Start test run' }).click();
  let first;
  for (let i = 0; i < 240; i++) { first = await page.evaluate(async () => { const ws = await window.sayspec.getLocalWorkspace(); const projectId = ws.projects[0].id; const version = (await window.sayspec.listProjectWebTestVersions({ organizationId: 'local', projectId }))[0]; const attempts = await window.sayspec.listSavedWebTestAttempts({ organizationId: 'local', projectId, testId: version.testId }); return { projectId, version, attempt: attempts[0] }; }); if (first?.attempt && !['preparing', 'running'].includes(first.attempt.state)) break; await page.waitForTimeout(500); }
  assert.equal(first.attempt.state, 'failed', first.attempt.detail);
  const originalSource = await readFile(path.join(sourcePath, 'app.js'), 'utf8');
  await app.close();
  const store = new SavedWebTestStore(path.join(profile, 'saved-web-tests')); await store.initialize();
  await store.saveFailureAnalysis({ schemaVersion: 1, id: 'analysis_application_fixture', organizationId: 'local', projectId: first.projectId, testId: first.version.testId, attemptId: first.attempt.id, versionId: first.version.id, testVersionHash: first.version.contentHash, inputHash: 'b'.repeat(64), createdAt: new Date().toISOString(), status: 'complete', provider: 'claude-code', expected: '$12.00', actual: '$7.00', category: 'application', explanation: 'The app subtracts $5 from the visible cart total while the saved assertion expects the catalog price.', limitations: 'Deterministic fixture diagnosis tied to a real Playwright failure.', nextStep: 'Review the cart calculation source.', evidenceIds: ['e01'], evidence: [{ id: 'e01', kind: 'framework', label: 'Failed cart assertion', text: first.attempt.summary + ' ' + first.attempt.detail.slice(0, 1500) }] });
  instance = await launch(); ({ app, page } = instance); await enterLocalWorkspace(page);
  await page.locator('nav button', { hasText: 'Runs' }).click(); await page.locator('.run-attempt').first().locator(':scope > summary').click();
  try { await page.getByRole('button', { name: 'Propose application fix' }).click({ timeout: 15000 }); } catch (error) { console.error('ANALYSIS_UI_DEBUG', (await page.locator('body').innerText()).slice(-6000)); throw error; }
  await page.getByRole('button', { name: 'Choose source folder' }).click();
  try { await page.getByRole('button', { name: 'Approve exact application patch' }).waitFor({ timeout: 45_000 }); } catch (error) { console.error('APPLICATION_FIX_UI_DEBUG', (await page.locator('body').innerText()).slice(-6000)); console.error('APPLICATION_FIX_WORKSPACE_DEBUG', await page.evaluate(async () => ({ proposals: await window.sayspec.listApplicationFixProposals({ organizationId: 'local', projectId: (await window.sayspec.getLocalWorkspace()).projects[0].id, target: 'web' }) }))); throw error; }
  assert.equal(await readFile(path.join(sourcePath, 'app.js'), 'utf8'), originalSource, 'proposal must not edit source');
  await page.getByRole('button', { name: 'Approve exact application patch' }).click();
  await page.getByRole('button', { name: 'Apply approved patch' }).click();
  await page.getByRole('button', { name: 'Rerun unchanged saved test on patched application' }).click();
  await page.getByText('Before:', { exact: false }).waitFor({ timeout: 90_000 });
  const after = await page.evaluate(async ({ projectId, testId }) => window.sayspec.listSavedWebTestAttempts({ organizationId: 'local', projectId, testId }), { projectId: first.projectId, testId: first.version.testId });
  assert.deepEqual(after.map((item) => item.state), ['failed', 'passed']);
  assert.equal(after[1].versionId, first.version.id); assert.equal(after[1].applicationPatch.originatingAttemptId, first.attempt.id); assert.match(after[1].applicationPatch.runtimeHash, /^[a-f0-9]{64}$/);
  await page.locator('nav button', { hasText: 'Runs' }).click();
  await page.locator('.run-attempt').first().locator(':scope > summary').click(); await page.getByText('Application patch', { exact: false }).waitFor({ timeout: 20_000 });
  await app.close(); instance = await launch(); ({ app, page } = instance); await enterLocalWorkspace(page);
  await page.locator('nav button', { hasText: 'Runs' }).click(); await page.locator('.run-attempt').first().locator(':scope > summary').click(); await page.getByText('Application patch', { exact: false }).waitFor({ timeout: 20_000 });
  const reopened = await page.evaluate(async ({ projectId, testId }) => window.sayspec.listSavedWebTestAttempts({ organizationId: 'local', projectId, testId }), { projectId: first.projectId, testId: first.version.testId });
  assert.deepEqual(reopened.map((item) => item.state), ['failed', 'passed']);
  console.log(`M11_WEB_APPLICATION_FIX=${JSON.stringify({ before: first.attempt.state, after: after[1].state, versionUnchanged: after[1].versionId === first.version.id, receiptId: after[1].applicationPatch.receiptId, runtimeHash: after[1].applicationPatch.runtimeHash, restarted: true, provider: 'deterministic-pty-fixture' })}`);
} finally { try { await instance?.app.close(); } catch { /* already closed */ } if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited */ } } await rm(root, { recursive: true, force: true }); }
