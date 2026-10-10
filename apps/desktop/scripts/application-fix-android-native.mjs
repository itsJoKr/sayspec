import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronBinary from 'electron';
import { PatrolRunStore } from '../electron/flutter/patrol-store.ts';
import { PatrolRunner } from '../electron/flutter/patrol-runner.ts';
import { FlutterCaptureStore } from '../electron/flutter/capture-store.ts';
import { FlutterCaptureSessionManager } from '../electron/flutter/session-manager.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const desktop = new URL('..', import.meta.url).pathname;
const sourcePath = new URL('../../../fixtures/flutter_sample_app', import.meta.url).pathname.replace(/\/$/, '');
const root = await mkdtemp('/private/tmp/sayspec-app-fix-android-');
const profile = path.join(root, 'profile'); const cli = path.join(root, 'fixture-claude.mjs');
const catalogPath = path.join(sourcePath, 'lib/catalog.dart'); const originalCatalog = await readFile(catalogPath, 'utf8');
const relativePath = 'patrol_test/sayspec_application_fix_test.dart';
const testSource = `// SAYSPEC_GENERATED
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
  await \$(\$(AppKeys.addFirstItem)).tap();
  await \$(\$(AppKeys.openCart)).tap();
  await \$(\$(AppKeys.cartPlaceOrder)).tap();
  expect(\$(\$(AppKeys.receiptTotal)).text, 'Total paid \\$12.00');
}); }
`;
await writeFile(cli, `#!/usr/bin/env node
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
const staged = path.join(context.contextDirectory, 'lib/catalog.dart');
const base = readFileSync(staged, 'utf8');
const patched = base.replace('priceCents: 700', 'priceCents: 1200');
if (patched === base) process.exit(12);
let outsideDenied = false;
try { writeFileSync(${JSON.stringify(path.join(sourcePath, 'lib', 'unauthorized-probe.txt'))}, 'should not write'); } catch { outsideDenied = true; }
if (!outsideDenied) process.exit(13);
try { writeFileSync(staged, 'should not write'); process.exit(14); } catch { /* read only */ }
writeFileSync(path.join(directory, 'proposal.json'), JSON.stringify({ rationale: 'Restore the catalog price so the unchanged receipt assertion can pass.', changes: [{ relativePath: 'lib/catalog.dart', text: patched }] }));
console.log('DETERMINISTIC_ANDROID_APPLICATION_PROPOSAL_STAGED OUTSIDE_WRITE_DENIED');
setTimeout(() => process.exit(0), 4000);
`); await chmod(cli, 0o755);
async function launch() { const app = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd: desktop, env: { ...process.env, SAYSPEC_TEST_MODE: '1', SAYSPEC_TEST_USER_DATA: profile, SAYSPEC_TEST_SOURCE_DIRECTORY: sourcePath, SAYSPEC_CLAUDE_CLI: cli }, timeout: 120_000 }); const page = await app.firstWindow(); page.setDefaultTimeout(120_000); return { app, page }; }
let instance; let sessions; let runner;
try {
  assert.match(originalCatalog, /priceCents: 1200/);
  instance = await launch(); let { app, page } = instance;
  await enterLocalWorkspace(page);
  await page.getByLabel('Project name').fill('Android app fix fixture');
  await page.getByLabel('Project technology').selectOption('flutter');
  await page.getByRole('button', { name: 'Choose folder' }).click();
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
  runner = new PatrolRunner({ store, captures: sessions }); console.log('M11_ANDROID_STAGE=validation-build');
  const validation = await runner.runCandidate({ organizationId: 'local', projectId, deviceId: device.id }, sourcePath, { title: 'Receipt total', relativePath, source: testSource });
  assert.equal(validation.state, 'passed', `${validation.summary} ${validation.detail}`);
  const saved = await store.saveTest({ organizationId: 'local', projectId, title: 'Receipt total', relativePath, source: testSource, validationAttemptId: validation.id, validatedRuntime: validation.runtime, dependencies: { patrol: '4.10.0' }, state: 'published' });
  console.log('M11_ANDROID_STAGE=validation-passed'); await writeFile(catalogPath, originalCatalog.replace('priceCents: 1200', 'priceCents: 700'));
  const failed = await runner.run({ organizationId: 'local', projectId, testId: saved.id, versionId: saved.versionId, deviceId: device.id }, sourcePath);
  assert.equal(failed.state, 'failed', `${failed.summary} ${failed.detail}`);
  console.log('M11_ANDROID_STAGE=defect-failed'); await store.saveFailureAnalysis({ schemaVersion: 1, id: 'analysis_android_application_fixture', organizationId: 'local', projectId, testId: saved.id, attemptId: failed.id, versionId: saved.versionId, testVersionHash: saved.contentHash, inputHash: 'b'.repeat(64), createdAt: new Date().toISOString(), status: 'complete', provider: 'claude-code', expected: 'Total paid $12.00', actual: 'Total paid $7.00', category: 'application', explanation: 'The fixture catalog price changed to $7 while the saved receipt assertion expects $12.', limitations: 'Deterministic fixture diagnosis tied to a real Android Patrol failure.', nextStep: 'Review the catalog price source.', evidenceIds: ['e01'], evidence: [{ id: 'e01', kind: 'framework', label: 'Failed Patrol assertion', text: failed.summary + ' ' + failed.detail.slice(0, 1500) }] });
  await runner.shutdown(); runner = undefined; await sessions.shutdown(); sessions = undefined;
  console.log('M11_ANDROID_STAGE=review-ui'); instance = await launch(); ({ app, page } = instance); await enterLocalWorkspace(page);
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page.getByRole('list', { name: 'Patrol attempts' }).getByRole('listitem').filter({ hasText: 'failed' }).click();
  await page.getByRole('button', { name: 'Propose application fix' }).click();
  await page.getByRole('button', { name: 'Choose source folder' }).click();
  try { await page.getByRole('button', { name: 'Approve exact application patch' }).waitFor({ timeout: 45_000 }); } catch (error) { console.error('ANDROID_FIX_UI_DEBUG', (await page.locator('body').innerText()).slice(-4000)); throw error; }
  assert.equal(await readFile(catalogPath, 'utf8'), originalCatalog.replace('priceCents: 1200', 'priceCents: 700'));
  await page.getByRole('button', { name: 'Approve exact application patch' }).click();
  await page.getByRole('button', { name: 'Apply approved patch' }).click();
  console.log('M11_ANDROID_STAGE=patch-applied'); await page.getByRole('button', { name: 'Rerun unchanged saved test on patched application' }).click();
  await page.getByText('Before:', { exact: false }).waitFor({ timeout: 900_000 });
  const attempts = await page.evaluate(async ({ projectId, testId }) => window.sayspec.listPatrolAttempts({ organizationId: 'local', projectId, testId }), { projectId, testId: saved.id });
  const after = attempts.at(-1);
  assert.deepEqual(attempts.map((item) => item.state).slice(-2), ['failed', 'passed']);
  assert.equal(after.versionId, saved.versionId); assert.equal(after.applicationPatch.originatingAttemptId, failed.id); assert.match(after.applicationPatch.buildArtifactHash, /^[a-f0-9]{64}$/);
  await app.close(); instance = await launch(); ({ app, page } = instance); await enterLocalWorkspace(page);
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  const reopened = await page.evaluate(async ({ projectId, testId }) => window.sayspec.listPatrolAttempts({ organizationId: 'local', projectId, testId }), { projectId, testId: saved.id });
  assert.deepEqual(reopened.map((item) => item.state).slice(-2), ['failed', 'passed']);
  assert.match(await page.getByRole('list', { name: 'Patrol attempts' }).innerText(), /failed/i);
  assert.match(await page.getByRole('list', { name: 'Patrol attempts' }).innerText(), /passed/i);
  console.log(`M11_ANDROID_APPLICATION_FIX=${JSON.stringify({ emulator: device.name, validation: validation.state, before: failed.state, after: after.state, sourceHash: saved.contentHash, versionUnchanged: after.versionId === saved.versionId, receiptId: after.applicationPatch.receiptId, buildArtifactHash: after.applicationPatch.buildArtifactHash, restarted: true, provider: 'deterministic-pty-fixture' })}`);
} finally { await writeFile(catalogPath, originalCatalog).catch(() => undefined); await rm(path.join(sourcePath, relativePath), { force: true }).catch(() => undefined); await rm(path.join(sourcePath, 'lib', 'unauthorized-probe.txt'), { force: true }).catch(() => undefined); await runner?.shutdown().catch(() => undefined); await sessions?.shutdown().catch(() => undefined); try { await instance?.app.close(); } catch { /* closed */ } await rm(root, { recursive: true, force: true }); }
