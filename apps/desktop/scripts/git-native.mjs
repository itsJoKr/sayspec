import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronBinary from 'electron';
import { SavedWebTestStore } from '../electron/execution/saved-web-tests.ts';

/**
 * Git end to end in the built app, on a throwaway repository whose pushes go
 * to a local bare repository: an applied Web application fix is committed to a
 * new SaySpec branch, pushed and opened as a pull request (browser, then the
 * GitHub CLI stand-in); test files in a Folder-storage folder inside the same
 * repository are committed from the library; Settings shows the repository.
 * The coding agent is a deterministic fixture; nothing reaches a real remote.
 */
const sha = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const git = (cwd, ...args) => execFileSync('git', args, { cwd }).toString().trim();
const cwd = new URL('..', import.meta.url).pathname;
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sayspec-git-native-')));
const profile = path.join(root, 'profile'); const sourcePath = path.join(root, 'web-shop'); const remote = path.join(root, 'web-shop.git');
const testsPath = path.join(sourcePath, 'e2e'); const opened = path.join(root, 'opened-urls.txt'); const ghLog = path.join(root, 'gh.log');
await cp(new URL('../../../fixtures/web_sample_app', import.meta.url).pathname, sourcePath, { recursive: true });
await mkdir(testsPath); await writeFile(opened, '');
git(root, 'init', '-q', '--bare', '-b', 'main', remote);
git(sourcePath, 'init', '-q', '-b', 'main');
for (const [key, value] of [['user.name', 'Dev Person'], ['user.email', 'dev@example.com'], ['commit.gpgsign', 'false']]) git(sourcePath, 'config', key, value);
git(sourcePath, 'add', '.'); git(sourcePath, 'commit', '-q', '-m', 'Web shop');
// Fetches name GitHub (for the pull request page); pushes go to the local bare repository.
git(sourcePath, 'remote', 'add', 'origin', remote); git(sourcePath, 'push', '-q', '-u', 'origin', 'main');
git(sourcePath, 'remote', 'set-url', 'origin', 'https://github.com/acme/web-shop.git'); git(sourcePath, 'remote', 'set-url', '--push', 'origin', remote);

const fixtureCli = path.join(root, 'fixture-claude.mjs');
await writeFile(fixtureCli, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('claude 2.1.269'); process.exit(0); }
if (args[0] === 'auth') { console.log('{"loggedIn":true}'); process.exit(0); }
const testFix = args[0]?.match(/Read (sessions\\/[^/]+)\\/\\.claude\\/skills\\/fix-managed-web-test\\/SKILL\\.md/);
if (testFix) {
  const base = readFileSync(path.join(testFix[1], 'base', 'tests', 'cart.spec.ts'), 'utf8');
  const text = base.replace('cart total remains twelve dollars', 'cart total stays at twelve dollars');
  if (text === base) process.exit(21);
  writeFileSync(path.join(testFix[1], 'proposal.json'), JSON.stringify({ rationale: 'Name the test after what it checks.', changes: [{ relativePath: 'tests/cart.spec.ts', text }] }));
  console.log('DETERMINISTIC_TEST_PROPOSAL_STAGED');
  setTimeout(() => process.exit(0), 4000);
} else {
const match = args[0]?.match(/Read (sessions\\/[^/]+\\/SKILL\\.md)/);
if (!match || args.includes('--safe-mode')) process.exit(11);
const directory = path.dirname(match[1]);
const context = JSON.parse(readFileSync(path.join(directory, 'source-context.json'), 'utf8'));
const base = readFileSync(path.join(context.contextDirectory, 'app.js'), 'utf8');
const patched = base.replace('correctSubtotal - 500', 'correctSubtotal');
if (patched === base) process.exit(12);
writeFileSync(path.join(directory, 'proposal.json'), JSON.stringify({ rationale: 'The cart subtracted five dollars from the subtotal. Show the catalog price so the $12 assertion holds.', changes: [{ relativePath: 'app.js', text: patched }] }));
console.log('DETERMINISTIC_APPLICATION_PROPOSAL_STAGED');
setTimeout(() => process.exit(0), 4000);
}
`); await chmod(fixtureCli, 0o755);
const fakeGh = path.join(root, 'gh');
await writeFile(fakeGh, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\ncase "$2" in create) echo "https://github.com/acme/web-shop/pull/42";; esac\n`); await chmod(fakeGh, 0o755);

/** Local-only builds open the local workspace directly; builds with a cloud backend first offer "Continue as guest". */
async function enterLocalWorkspace(page) {
  const guest = page.getByTestId('continue-guest');
  await guest.or(page.getByTestId('local-project-gate')).or(page.locator('nav')).first().waitFor();
  if (await guest.isVisible()) await guest.click();
}
const freePort = async () => { const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; };
const port = await freePort(); const baseUrl = `http://127.0.0.1:${port}/`;
const child = spawn('node', ['server.mjs'], { cwd: sourcePath, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
for (let i = 0; i < 60; i++) { try { if ((await fetch(baseUrl)).ok) break; } catch { /* starting */ } await new Promise((resolve) => setTimeout(resolve, 100)); }
const source = `import { test, expect } from '@playwright/test';\ntest('cart total remains twelve dollars', async ({ page }) => { await page.goto('/?bug=cart-total'); await page.getByTestId('add-to-cart-coffee').click(); await page.getByTestId('cart-button').click(); await expect(page.getByTestId('cart-total')).toHaveText('$12.00'); });`;
const steps = [{ id: 'step_cart_total', instruction: 'Add coffee to the basket', assertion: 'Total is $12.00', intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }];
const files = [{ id: 'file_cart', relativePath: 'tests/cart.spec.ts', text: source, sha256: sha(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' }];
const runtime = { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: files[0].relativePath, dependencies: { '@playwright/test': '1.63.0' }, requirements: ['Node.js >=22.12.0', 'Playwright Chromium installed'] };
const bundle = { schemaVersion: 1, kind: 'sayspec-playwright-bundle', exportedAt: new Date().toISOString(), original: { testId: 'source_cart', versionId: 'version_cart', contentHash: sha(canonical({ steps, files, runtime })), state: 'execution-validated' }, title: 'Cart total', steps, files, runtime, secretPlaceholders: ['BASE_URL'], provenance: { provider: 'claude-code', cliVersion: 'deterministic-fixture', inputRevisionHash: 'a'.repeat(64), generatedAt: new Date().toISOString() } };
async function launch(extra = {}) { const app = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd, env: { ...process.env, SAYSPEC_TEST_MODE: '1', SAYSPEC_TEST_USER_DATA: profile, SAYSPEC_TEST_SOURCE_DIRECTORY: sourcePath, SAYSPEC_TEST_STORAGE_DIRECTORY: testsPath, SAYSPEC_TEST_OPENED_URLS: opened, SAYSPEC_CLAUDE_CLI: fixtureCli, ...extra }, timeout: 30_000 }); return { app, page: await app.firstWindow() }; }
// SAYSPEC_GIT_SCREENSHOTS=<folder> keeps pictures of the Git panels for review.
const shot = async (locator, name) => { if (process.env.SAYSPEC_GIT_SCREENSHOTS) await locator.screenshot({ path: path.join(process.env.SAYSPEC_GIT_SCREENSHOTS, `${name}.png`) }); };
const status = (page, text) => page.getByRole('status').filter({ hasText: text }).first().waitFor({ timeout: 60_000 });
let instance;
try {
  instance = await launch(); let { app, page } = instance;
  await enterLocalWorkspace(page);
  await page.locator('#field-project-name').fill('Git fixture'); await page.locator('#field-base-url').fill(baseUrl);
  await page.locator('input[type=radio][value=folder]').check();
  await page.getByText('e2e', { exact: true }).waitFor();
  await page.getByTestId('local-project-create').click(); await page.getByTestId('onboarding-finish').click();
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
  await app.close();
  const store = new SavedWebTestStore(path.join(profile, 'saved-web-tests')); await store.initialize();
  await store.saveFailureAnalysis({ schemaVersion: 1, id: 'analysis_application_fixture', organizationId: 'local', projectId: first.projectId, testId: first.version.testId, attemptId: first.attempt.id, versionId: first.version.id, testVersionHash: first.version.contentHash, inputHash: 'b'.repeat(64), createdAt: new Date().toISOString(), status: 'complete', provider: 'claude-code', expected: '$12.00', actual: '$7.00', category: 'application', explanation: 'The app subtracts $5 from the visible cart total.', limitations: 'Deterministic fixture diagnosis tied to a real Playwright failure.', nextStep: 'Review the cart calculation source.', evidenceIds: ['e01'], evidence: [{ id: 'e01', kind: 'framework', label: 'Failed cart assertion', text: `${first.attempt.summary} ${first.attempt.detail.slice(0, 1500)}` }] });
  // A second, test-category diagnosis of the same failure, for the managed test fix below.
  await store.saveFailureAnalysis({ schemaVersion: 1, id: 'analysis_test_fixture', organizationId: 'local', projectId: first.projectId, testId: first.version.testId, attemptId: first.attempt.id, versionId: first.version.id, testVersionHash: first.version.contentHash, inputHash: 'c'.repeat(64), createdAt: new Date().toISOString(), status: 'complete', provider: 'claude-code', expected: 'A test name that says what it checks', actual: 'cart total remains twelve dollars', category: 'test', explanation: 'The test name does not describe the check.', limitations: 'Deterministic fixture diagnosis.', nextStep: 'Rename the test.', evidenceIds: ['e01'], evidence: [{ id: 'e01', kind: 'framework', label: 'Failed cart assertion', text: first.attempt.summary }] });

  instance = await launch(); ({ app, page } = instance); await enterLocalWorkspace(page);
  await page.locator('nav button', { hasText: 'Runs' }).click(); await page.locator('.run-attempt').first().locator(':scope > summary').click();
  await page.getByRole('button', { name: 'Propose application fix' }).click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Choose source folder' }).click();
  await page.getByRole('button', { name: 'Approve exact application patch' }).click({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Apply approved patch' }).click();
  await page.getByRole('button', { name: 'Rerun unchanged saved test on patched application' }).click();
  await page.getByText('Before:', { exact: false }).waitFor({ timeout: 90_000 });

  // The applied fix, committed from Fixes.
  const panel = page.getByRole('region', { name: 'Git', exact: true }).first();
  await panel.getByRole('heading', { name: 'Commit the fix to Git' }).waitFor({ timeout: 20_000 });
  assert.match(await panel.innerText(), /web-shop · on main · origin github\.com\/acme\/web-shop/);
  assert.deepEqual(await panel.locator('.git-files code').allInnerTexts(), ['app.js']);
  assert.equal(await panel.locator('.git-files input').count(), 0, 'an applied fix is committed whole');
  const branch = await panel.getByLabel('New branch name').inputValue();
  assert.match(branch, /^sayspec\/fix-the-cart-subtracted-five-dollars-from-[a-z0-9]{6}$/);
  assert.match(await panel.locator('textarea').inputValue(), /^Fix: The cart subtracted five dollars from the subtotal\n\n/);
  await shot(panel, '1-app-fix-before-commit');
  await panel.getByRole('button', { name: 'Commit 1 file' }).click();
  await status(page, `on ${branch}. This checkout is now on ${branch}.`);
  assert.equal(git(sourcePath, 'branch', '--show-current'), branch);
  assert.equal(git(sourcePath, 'show', '--name-only', '--format=', 'HEAD'), 'app.js');
  assert.match(git(sourcePath, 'status', '--porcelain', '--untracked-files=all'), /^\?\? e2e\/.+\.spec\.ts$/m, 'the test file is not part of the fix commit');
  const fixCommit = git(sourcePath, 'rev-parse', 'HEAD');
  await panel.getByRole('button', { name: 'Push to origin' }).click();
  await status(page, `Pushed ${branch} to origin.`);
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), fixCommit);
  await panel.getByRole('button', { name: 'Open pull request page' }).click();
  await status(page, 'Opened the new pull request page in your browser.');
  assert.deepEqual((await readFile(opened, 'utf8')).trim().split('\n'), [`https://github.com/acme/web-shop/compare/main...${branch}?expand=1`]);
  await shot(panel, '2-app-fix-pushed');

  // Test files in the storage folder, committed from the library onto the SaySpec branch.
  await page.locator('nav button', { hasText: 'Tests' }).click();
  const bar = page.getByTestId('git-bar');
  await bar.getByText('1 changed test file not committed').waitFor({ timeout: 20_000 });
  await shot(page.locator('.test-library'), '3-library-bar');
  await bar.getByRole('button', { name: 'Commit…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Commit tests to Git' });
  assert.ok(await dialog.getByRole('radio', { name: new RegExp(`Add to ${branch.replaceAll('/', '\\/')}`) }).isChecked());
  assert.equal(await dialog.locator('textarea').inputValue(), 'Update SaySpec tests');
  await shot(dialog, '4-library-dialog');
  await dialog.getByRole('button', { name: 'Commit 1 file' }).click();
  await dialog.getByRole('status').filter({ hasText: `on ${branch}.` }).waitFor({ timeout: 60_000 });
  assert.match(git(sourcePath, 'show', '--name-only', '--format=', 'HEAD'), /^e2e\/.+\.spec\.ts$/);
  assert.equal(git(sourcePath, 'rev-parse', 'HEAD~1'), fixCommit);
  await dialog.getByRole('button', { name: 'Push to origin' }).click();
  await dialog.getByRole('status').filter({ hasText: `Pushed ${branch} to origin.` }).waitFor({ timeout: 60_000 });
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), git(sourcePath, 'rev-parse', 'HEAD'));
  await dialog.getByRole('button', { name: 'Close' }).click();
  await bar.waitFor({ state: 'detached', timeout: 20_000 }).catch(async () => { assert.match(await bar.innerText(), /ready to push or review/); });

  // A managed test fix: the new version is written to the test's file and committed from the test-fix page.
  // The patched rerun is now the newest attempt; the diagnosis belongs to the original failure.
  await page.locator('nav button', { hasText: 'Runs' }).click(); await page.locator('.run-attempt').last().locator(':scope > summary').click();
  await page.getByRole('button', { name: 'Fix with AI' }).click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Approve exact patch' }).click({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Apply approved patch' }).click();
  await page.getByText('validation:', { exact: false }).waitFor({ timeout: 120_000 });
  const testPanel = page.getByRole('region', { name: 'Git', exact: true }).filter({ has: page.getByRole('heading', { name: 'Commit the new version to Git' }) });
  await testPanel.waitFor({ timeout: 20_000 });
  const testFiles = await testPanel.locator('.git-files code').allInnerTexts();
  assert.equal(testFiles.length, 1); assert.match(testFiles[0], /^e2e\/.+\.spec\.ts$/);
  assert.equal(await testPanel.locator('textarea').inputValue(), 'Update SaySpec test “Cart total”');
  assert.ok(await testPanel.getByRole('radio', { name: new RegExp(`Add to ${branch.replaceAll('/', '\\/')}`) }).isChecked());
  await testPanel.getByRole('button', { name: 'Commit 1 file' }).click();
  await testPanel.getByRole('status').filter({ hasText: `on ${branch}.` }).waitFor({ timeout: 60_000 });
  assert.equal(git(sourcePath, 'show', '--name-only', '--format=', 'HEAD'), testFiles[0]);
  assert.match(git(sourcePath, 'show', `HEAD:${testFiles[0]}`), /cart total stays at twelve dollars/);
  await testPanel.getByRole('button', { name: 'Push to origin' }).click();
  await testPanel.getByRole('status').filter({ hasText: `Pushed ${branch} to origin.` }).waitFor({ timeout: 60_000 });
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), git(sourcePath, 'rev-parse', 'HEAD'));
  await shot(testPanel, '5-test-fix-pushed');

  // Settings recognizes both folders as the repository.
  await page.locator('nav button', { hasText: 'Settings' }).click();
  await page.getByTestId('git-summary').nth(1).waitFor({ timeout: 30_000 }).catch(async (error) => { console.error('SETTINGS_DEBUG', (await page.locator('main').innerText()).slice(0, 4000)); throw error; });
  await shot(page.getByTestId('git-summary').first().locator('xpath=ancestor::section[1]'), '6-settings-source');
  const summaries = await page.getByTestId('git-summary').allInnerTexts();
  assert.ok(summaries.length >= 2, `Git summaries: ${summaries.join(' | ')}`);
  for (const text of summaries) assert.match(text, new RegExp(`Git repository · web-shop · on ${branch.replaceAll('/', '\\/')} · origin github\\.com/acme/web-shop`));
  await app.close();

  // After a restart, the GitHub CLI creates the pull request for the same branch.
  instance = await launch({ SAYSPEC_TEST_GH: fakeGh }); ({ app, page } = instance); await enterLocalWorkspace(page);
  await page.locator('nav button', { hasText: 'Fixes' }).click();
  const reopened = page.getByRole('region', { name: 'Git', exact: true }).filter({ has: page.getByRole('heading', { name: 'Commit the fix to Git' }) });
  await reopened.getByRole('button', { name: 'Create pull request' }).click({ timeout: 30_000 });
  await status(page, 'Pull request: https://github.com/acme/web-shop/pull/42');
  const calls = (await readFile(ghLog, 'utf8')).trim().split('\n');
  assert.match(calls[0], new RegExp(`^pr list --repo acme/web-shop --head ${branch} --state open`));
  assert.match(calls[1], new RegExp(`^pr create --repo acme/web-shop --base main --head ${branch} --title Fix: The cart subtracted five dollars from the subtotal --body`));
  assert.equal((await readFile(opened, 'utf8')).trim().split('\n').at(-1), 'https://github.com/acme/web-shop/pull/42');
  await reopened.getByRole('button', { name: 'Open pull request' }).waitFor();
  // The test fix's commit is on the same branch, so it shares the pull request.
  await page.getByRole('region', { name: 'Git', exact: true }).filter({ has: page.getByRole('heading', { name: 'Commit the new version to Git' }) }).getByRole('button', { name: 'Open pull request' }).waitFor();
  console.log(`GIT_NATIVE=${JSON.stringify({ branch, fixCommit: fixCommit.slice(0, 7), testFixCommit: git(sourcePath, 'rev-parse', '--short', 'HEAD'), commitsOnBranch: Number(git(sourcePath, 'rev-list', '--count', `main..${branch}`)), pushed: true, pullRequestPage: true, githubCli: 'https://github.com/acme/web-shop/pull/42', settings: summaries.length, restarted: true, provider: 'deterministic-pty-fixture' })}`);
} finally { try { await instance?.app.close(); } catch { /* already closed */ } if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited */ } } await rm(root, { recursive: true, force: true }); }
