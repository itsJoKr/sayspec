import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronBinary from 'electron';
import { PatrolRunStore } from '../electron/flutter/patrol-store.ts';
import { PatrolRunner } from '../electron/flutter/patrol-runner.ts';
import { FlutterCaptureStore } from '../electron/flutter/capture-store.ts';
import { FlutterCaptureSessionManager } from '../electron/flutter/session-manager.ts';
import { serializeTestFile } from '../electron/test-storage/test-file-format.ts';

// A saved Patrol test whose finder drifted from the app fails in a run; the
// run's report calls it a test bug; "Fix test with Claude" opens a session
// whose (deterministic fixture) agent proposes the corrected test; approval
// and application save version 2, which then passes on the emulator. The
// app source is never changed and version 1 keeps its failure.
// With SAYSPEC_TEST_FIX_GIT=1 the project keeps its tests in a folder that is a
// Git repository (pushing to a local bare one): the fixed version is written to
// the test's file and committed and pushed from the test-fix page.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Local-only builds open the local workspace directly; builds with a cloud backend first offer "Continue as guest". */
async function enterLocalWorkspace(page) {
  const guest = page.getByTestId('continue-guest');
  await guest.or(page.getByTestId('local-project-gate')).or(page.locator('nav')).first().waitFor();
  if (await guest.isVisible()) await guest.click();
}
const desktop = new URL('..', import.meta.url).pathname;
const sourcePath = new URL('../../../fixtures/flutter_sample_app', import.meta.url).pathname.replace(/\/$/, '');
const root = await mkdtemp('/private/tmp/sayspec-test-fix-android-');
const profile = path.join(root, 'profile'); const cli = path.join(root, 'fixture-claude.mjs');
const gitMode = process.env.SAYSPEC_TEST_FIX_GIT === '1';
const testsRepo = path.join(root, 'tests-repo'); const testsRemote = path.join(root, 'tests-repo.git'); const testFile = 'receipt_total_test.dart'; const testId = 'test_receipt_total';
const git = (cwd, ...args) => execFileSync('git', args, { cwd }).toString().trim();
const catalogPath = path.join(sourcePath, 'lib/catalog.dart'); const originalCatalog = await readFile(catalogPath, 'utf8');
// patrol_cli regenerates the bundle for the tests it runs; it is put back afterwards.
const bundlePath = path.join(sourcePath, 'patrol_test/test_bundle.dart'); const originalBundle = await readFile(bundlePath, 'utf8');
const relativePath = 'patrol_test/sayspec_test_fix_test.dart';
const testSource = (key) => `// SAYSPEC_GENERATED
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patrol/patrol.dart';
import 'package:flutter_sample_app/catalog.dart';
import 'package:flutter_sample_app/main.dart' as app;
void main() { patrolTest('receipt total is twelve dollars', (\$) async {
  await \$.pumpWidgetAndSettle(const app.SampleApp());
  await \$(\$(AppKeys.signInEmail)).enterText('fixture@sayspec.local');
  await \$(\$(AppKeys.signInPassword)).enterText('fixture-password');
  await \$(\$(AppKeys.signInSubmit)).tap();
  await \$(const ValueKey<String>('${key}')).tap();
  await \$(\$(AppKeys.openCart)).tap();
  await \$(\$(AppKeys.cartPlaceOrder)).tap();
  expect(\$(\$(AppKeys.receiptTotal)).text, 'Total paid \\$12.00');
}); }
`;
const drifted = testSource('add_coffee');
const corrected = testSource('add_item_coffee');
await writeFile(path.join(root, 'proposal.json'), JSON.stringify({ rationale: 'The add button key is add_item_coffee in the app; the saved test still used the old add_coffee key.', changes: [{ relativePath, text: corrected }] }));
await writeFile(cli, `#!/usr/bin/env node
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('claude 2.1.269'); process.exit(0); }
if (args[0] === 'auth') { console.log('{"loggedIn":true}'); process.exit(0); }
const match = args[0]?.match(/Read (sessions\\/[^/]+)\\/\\.claude\\/skills\\/fix-managed-patrol-test\\/SKILL\\.md/);
if (!match || args.includes('--safe-mode')) process.exit(11);
const directory = match[1];
if (args[args.indexOf('--add-dir') + 1] !== ${JSON.stringify(sourcePath)}) process.exit(12);
const base = readFileSync(path.join(directory, 'base', ${JSON.stringify(relativePath)}), 'utf8');
if (!base.includes("ValueKey<String>('add_coffee')")) process.exit(13);
if (!readFileSync(path.join(${JSON.stringify(sourcePath)}, 'lib', 'catalog.dart'), 'utf8').includes('add_item_coffee')) process.exit(14);
let outsideDenied = false;
try { writeFileSync(${JSON.stringify(path.join(sourcePath, 'lib', 'unauthorized-probe.txt'))}, 'should not write'); } catch { outsideDenied = true; }
if (!outsideDenied) process.exit(15);
copyFileSync(${JSON.stringify(path.join(root, 'proposal.json'))}, path.join(directory, 'proposal.json'));
console.log('DETERMINISTIC_PATROL_TEST_PROPOSAL_STAGED OUTSIDE_WRITE_DENIED');
setTimeout(() => process.exit(0), 4000);
`); await chmod(cli, 0o755);
if (gitMode) {
  await mkdir(testsRepo); git(root, 'init', '-q', '--bare', '-b', 'main', testsRemote); git(testsRepo, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'QA Person'], ['user.email', 'qa@example.com'], ['commit.gpgsign', 'false']]) git(testsRepo, 'config', key, value);
  await writeFile(path.join(testsRepo, testFile), serializeTestFile({ id: testId, title: 'Receipt total', entrypoint: relativePath, steps: [] }, drifted));
  git(testsRepo, 'add', '.'); git(testsRepo, 'commit', '-q', '-m', 'Receipt total test'); git(testsRepo, 'remote', 'add', 'origin', testsRemote); git(testsRepo, 'push', '-q', '-u', 'origin', 'main');
}
async function launch() { const app = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd: desktop, env: { ...process.env, SAYSPEC_TEST_MODE: '1', SAYSPEC_TEST_USER_DATA: profile, SAYSPEC_TEST_SOURCE_DIRECTORY: sourcePath, SAYSPEC_TEST_STORAGE_DIRECTORY: testsRepo, SAYSPEC_CLAUDE_CLI: cli }, timeout: 120_000 }); const page = await app.firstWindow(); page.setDefaultTimeout(120_000); return { app, page }; }
let instance; let sessions; let runner;
try {
  instance = await launch(); let { app, page } = instance;
  await enterLocalWorkspace(page);
  await page.getByLabel('Project name').fill('Android test fix fixture');
  await page.getByLabel('Project technology').selectOption('flutter');
  await page.getByRole('button', { name: 'Choose folder' }).click();
  if (gitMode) { await page.locator('input[type=radio][value=folder]').check(); await page.getByText('tests-repo', { exact: true }).waitFor(); }
  await page.getByTestId('local-project-create').click();
  await page.getByTestId('onboarding-finish').click();
  const projectId = await page.evaluate(async () => (await window.sayspec.getLocalWorkspace()).projects[0].id);
  await page.evaluate(() => window.sayspec.selectCodingAgentProvider({ provider: 'claude-code' }));
  await app.close();
  const store = new PatrolRunStore(path.join(profile, 'patrol-runs')); await store.initialize();
  const captures = new FlutterCaptureStore(path.join(profile, 'flutter-captures')); await captures.initialize();
  sessions = new FlutterCaptureSessionManager({ store: captures, onLifecycle: () => undefined });
  const deviceName = process.env.SAYSPEC_E04_AVD ?? 'Slim_1';
  let device = (await sessions.devices()).find((item) => item.platform === 'android' && item.name === deviceName && item.state === 'ready');
  if (!device) { const installed = (await sessions.devices()).find((item) => item.platform === 'android' && item.name === deviceName); assert.ok(installed, `No emulator ${deviceName}`); await sessions.ensureDevice(installed); for (let i = 0; i < 120; i++) { device = (await sessions.devices()).find((item) => item.platform === 'android' && item.name === deviceName && item.state === 'ready'); if (device) break; await sleep(2000); } }
  assert.ok(device, 'Android emulator did not become ready');
  runner = new PatrolRunner({ store, captures: sessions });
  const saved = await store.saveTest({ organizationId: 'local', projectId, ...(gitMode ? { testId } : {}), title: 'Receipt total', relativePath, source: drifted, dependencies: { patrol: '4.10.0' }, state: 'published' });
  const run = await store.createRun({ organizationId: 'local', projectId, testIds: [saved.id], name: 'Test fix fixture run' });
  console.log('TEST_FIX_STAGE=drifted-run');
  await runner.startRun({ organizationId: 'local', projectId, runId: run.id, deviceId: device.id }, sourcePath);
  for (let i = 0; i < 900 && store.run({ organizationId: 'local', projectId, runId: run.id }).state === 'running'; i++) await sleep(2000);
  const failed = store.runs(projectId, 'local').attempts.find((item) => item.runId === run.id && item.testId === saved.id);
  assert.equal(failed?.state, 'failed', `${failed?.summary} ${failed?.detail}`);
  console.log('TEST_FIX_STAGE=drifted-failed');
  // Stands in for the analysis agent: its analysis.json and report, which SaySpec reads into the run's issues when it starts.
  const analysisDirectory = path.join(profile, 'patrol-run-analysis', run.id);
  await mkdir(analysisDirectory, { recursive: true });
  await writeFile(path.join(analysisDirectory, 'analysis.json'), JSON.stringify({ schema: 1, issues: [{ id: 'i1', tests: ['Receipt total'], testFile: relativePath, verdict: 'bad-test', summary: 'The test taps the add_coffee key, which the app renamed to add_item_coffee.', expected: 'Tap the first catalog item', actual: 'No widget with key add_coffee', evidence: [failed.tests.flatMap((test) => test.errors).join(' ').slice(0, 500) || failed.summary], nextStep: 'Use AppKeys.addFirstItem (add_item_coffee).' }] }));
  await writeFile(path.join(analysisDirectory, 'report.html'), '<!doctype html><title>Fixture report</title><p>Deterministic fixture report.</p>');
  await store.updateRun(run.id, { analysis: { state: 'ready', provider: 'claude-code', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } });
  await runner.shutdown(); runner = undefined; await sessions.shutdown(); sessions = undefined;

  console.log('TEST_FIX_STAGE=review-ui'); instance = await launch(); ({ app, page } = instance); await enterLocalWorkspace(page);
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  const fixTest = page.getByRole('button', { name: 'Fix test with Claude' });
  await fixTest.waitFor();
  assert.match(await page.locator('.patrol-run-issue').innerText(), /Test bug[\s\S]*add_coffee/);
  const chooseSource = page.getByRole('button', { name: 'Choose source folder' });
  if (await chooseSource.isVisible()) await chooseSource.click();
  for (let i = 0; i < 60 && !(await fixTest.isEnabled()); i++) await sleep(500);
  await fixTest.click();
  try { await page.getByRole('button', { name: 'Approve exact patch' }).waitFor({ timeout: 45_000 }); } catch (error) { console.error('TEST_FIX_UI_DEBUG', (await page.locator('body').innerText()).slice(-4000)); throw error; }
  assert.match(await page.locator('.fix-diff').innerText(), /-  await \$\(const ValueKey<String>\('add_coffee'\)\)\.tap\(\);\n\+  await \$\(const ValueKey<String>\('add_item_coffee'\)\)\.tap\(\);/);
  assert.equal(await readFile(catalogPath, 'utf8'), originalCatalog, 'a test fix never changes the app');
  assert.equal(store.versions(projectId, 'local', saved.id).length, 1);
  await page.getByRole('button', { name: 'Approve exact patch' }).click();
  await page.getByRole('button', { name: 'Apply approved patch' }).click();
  console.log('TEST_FIX_STAGE=version-saved');
  await page.getByLabel('Device for the new version').selectOption(device.id);
  await page.getByRole('button', { name: 'Run new version on device' }).click();
  await page.getByText('Version 2 passed.', { exact: false }).or(page.getByText('Version 2 failed.', { exact: false })).or(page.getByText('Version 2 could not run.', { exact: false })).waitFor({ timeout: 900_000 });
  const versions = await page.evaluate(async ({ projectId, testId }) => window.sayspec.listPatrolTestVersions({ organizationId: 'local', projectId, testId }), { projectId, testId: saved.id });
  const attempts = await page.evaluate(async ({ projectId, testId }) => window.sayspec.listPatrolAttempts({ organizationId: 'local', projectId, testId }), { projectId, testId: saved.id });
  const after = attempts.at(-1);
  assert.equal(after.state, 'passed', `${after.summary} ${after.detail}`);
  assert.deepEqual(versions.map((item) => item.version), [2, 1]);
  assert.equal(versions[0].source, corrected); assert.equal(versions[1].source, drifted);
  assert.equal(versions[0].state, 'execution-validated'); assert.equal(after.versionId, versions[0].versionId);
  assert.equal(attempts.find((item) => item.id === failed.id).state, 'failed', 'version 1 keeps its failure');
  let committed;
  if (gitMode) {
    // The new version is in the test's file; it is committed alone to a new SaySpec branch and pushed.
    assert.equal(git(testsRepo, 'status', '--porcelain'), `M ${testFile}`);
    const panel = page.getByRole('region', { name: 'Git', exact: true });
    await panel.getByRole('heading', { name: 'Commit the new version to Git' }).waitFor();
    assert.deepEqual(await panel.locator('.git-files code').allInnerTexts(), [testFile]);
    assert.equal(await panel.locator('textarea').inputValue(), 'Update SaySpec test “Receipt total”');
    const branch = await panel.getByLabel('New branch name').inputValue();
    assert.equal(branch, 'sayspec/test-receipt-total');
    await panel.getByRole('button', { name: 'Commit 1 file' }).click();
    await page.getByRole('status').filter({ hasText: `on ${branch}.` }).waitFor();
    assert.equal(git(testsRepo, 'branch', '--show-current'), branch);
    assert.ok(git(testsRepo, 'show', `HEAD:${testFile}`).includes("ValueKey<String>('add_item_coffee')"));
    assert.equal(git(testsRepo, 'status', '--porcelain'), '');
    await panel.getByRole('button', { name: 'Push to origin' }).click();
    await page.getByRole('status').filter({ hasText: `Pushed ${branch} to origin.` }).waitFor();
    assert.equal(git(testsRemote, 'rev-parse', `refs/heads/${branch}`), git(testsRepo, 'rev-parse', 'HEAD'));
    committed = { branch, commit: git(testsRepo, 'rev-parse', '--short', 'HEAD'), pushed: true };
  }

  await app.close(); instance = await launch(); ({ app, page } = instance); await enterLocalWorkspace(page);
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page.locator('.patrol-run-issue').filter({ hasText: 'Test bug' }).waitFor();
  assert.match(await page.locator('.patrol-run-summary').innerText(), /1\s*failed/);
  await page.getByRole('button', { name: 'Fixes', exact: true }).click();
  await page.getByText('Saved as version 2, which has passed on a device', { exact: false }).waitFor();
  console.log(`PATROL_TEST_FIX=${JSON.stringify({ emulator: device.name, before: failed.state, after: after.state, versions: versions.map((item) => item.version), appUnchanged: true, restarted: true, ...(committed ? { git: committed } : {}), provider: 'deterministic-pty-fixture' })}`);
} finally { await writeFile(catalogPath, originalCatalog).catch(() => undefined); await writeFile(bundlePath, originalBundle).catch(() => undefined); await rm(path.join(sourcePath, relativePath), { force: true }).catch(() => undefined); await rm(path.join(sourcePath, 'lib', 'unauthorized-probe.txt'), { force: true }).catch(() => undefined); await runner?.shutdown().catch(() => undefined); await sessions?.shutdown().catch(() => undefined); try { await instance?.app.close(); } catch { /* closed */ } await rm(root, { recursive: true, force: true }); }
