import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from '@playwright/test';
import { FlutterCaptureStore } from '../electron/flutter/capture-store.ts';
import { FlutterCaptureSessionManager } from '../electron/flutter/session-manager.ts';
import { resolveTool, runFile } from '../electron/setup/environment.ts';

/**
 * E07 built-Electron acceptance on the qualified Android emulator.
 *
 * The fixture CLI is deliberately not provider evidence. It drives the same
 * interactive PTY/submission boundary so the product can be tested without
 * exporting the local fixture source to an external provider.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = promisify(execFile);
const desktop = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const source = new URL('../../../fixtures/flutter_sample_app', import.meta.url).pathname.replace(/\/$/, '');
// Keep the PTY workspace on a canonical path. macOS reports its temp root as
// /var/folders to the parent but canonicalizes it to /private/var/folders in a
// child process; sandbox-exec treats those literals differently. /private/tmp
// avoids that fixture-only alias mismatch.
const root = await mkdtemp('/private/tmp/sayspec-e07-electron-');
const userData = path.join(root, 'user-data');
const fakeCli = path.join(root, 'fixture-codex');
const audioAiff = path.join(root, 'expectation.aiff');
const audioWav = path.join(root, 'expectation.wav');
const installedModels = path.join(process.env.HOME, 'Library', 'Application Support', '@sayspec', 'desktop', 'transcription-models');
const catalogPath = path.join(source, 'lib', 'catalog.dart');
const originalCatalog = await readFile(catalogPath, 'utf8');
let electronApp;
let bootSessions;

async function adb(serial, args) {
  const tool = await resolveTool({ name: 'adb' });
  return runFile(tool.path, ['-s', serial, ...args], { timeoutMs: 60_000 });
}

async function tap(serial, x, y) {
  await adb(serial, ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  await sleep(800);
}

async function dumpNodes(serial) {
  const dump = await adb(serial, ['shell', 'uiautomator', 'dump', '--compressed', '/sdcard/sayspec-e07.xml']);
  if (!/dumped to/i.test(dump.stdout)) throw new Error(`uiautomator dump failed: ${dump.stdout}${dump.stderr}`);
  const xml = await adb(serial, ['shell', 'cat', '/sdcard/sayspec-e07.xml']);
  return [...xml.stdout.matchAll(/<node\s[^>]*>/g)].map((match) => {
    const attribute = (name) => new RegExp(`${name}="([^"]*)"`).exec(match[0])?.[1] ?? '';
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(match[0]);
    return {
      text: attribute('text'), contentDesc: attribute('content-desc'), clickable: attribute('clickable'),
      center: bounds ? { x: (Number(bounds[1]) + Number(bounds[3])) / 2, y: (Number(bounds[2]) + Number(bounds[4])) / 2 } : undefined,
    };
  }).filter((node) => node.center);
}

async function tapNode(serial, label) {
  let seen = [];
  for (let attempt = 0; attempt < 45; attempt += 1) {
    seen = await dumpNodes(serial).catch(() => []);
    const candidates = seen.filter((node) => (node.contentDesc || node.text) === label);
    const node = candidates.find((item) => item.clickable === 'true') ?? candidates[0];
    if (node) { await tap(serial, node.center.x, node.center.y); return; }
    await sleep(1_000);
  }
  throw new Error(`${label} was not present; saw ${JSON.stringify(seen.map((node) => node.contentDesc || node.text).filter(Boolean).slice(0, 30))}`);
}

async function type(serial, value) {
  await adb(serial, ['shell', 'input', 'text', value.replaceAll(' ', '%s')]);
  await sleep(350);
}

async function readyDevice() {
  const store = new FlutterCaptureStore(path.join(root, 'boot-captures')); await store.initialize();
  bootSessions = new FlutterCaptureSessionManager({ store, onLifecycle: () => undefined });
  const name = process.env.SAYSPEC_E04_AVD ?? 'Slim_1';
  let devices = await bootSessions.devices();
  let device = devices.find((item) => item.platform === 'android' && item.name === name && item.state === 'ready');
  if (device) return device;
  const installed = devices.find((item) => item.platform === 'android' && item.name === name);
  assert.ok(installed, `No installed Android emulator named ${name}.`);
  await bootSessions.ensureDevice(installed);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    devices = await bootSessions.devices();
    device = devices.find((item) => item.platform === 'android' && item.name === name && item.state === 'ready');
    if (device) return device;
    await sleep(2_000);
  }
  throw new Error(`${name} did not become ready.`);
}

async function prepareUserData() {
  await mkdir(path.join(userData, 'transcription-models'), { recursive: true });
  const modelSource = path.join(installedModels, 'ggml-small-q5_1.bin');
  const modelDestination = path.join(userData, 'transcription-models', 'ggml-small-q5_1.bin');
  try { await link(modelSource, modelDestination); }
  catch (error) {
    if (!['EPERM', 'EXDEV', 'EACCES'].includes(error?.code)) throw error;
    await copyFile(modelSource, modelDestination);
  }
  await writeFile(path.join(userData, 'transcription-models', 'state.json'), JSON.stringify({ schemaVersion: 1, state: 'installed', downloadedBytes: 190085487 }));
  await writeFile(path.join(userData, 'coding-agent-preference.json'), JSON.stringify({ schemaVersion: 1, provider: 'codex', updatedAt: new Date().toISOString() }));
  await run('/usr/bin/say', ['-o', audioAiff, 'When I place the order, the receipt total should be twelve dollars.']);
  await run('/opt/homebrew/bin/ffmpeg', ['-y', '-i', audioAiff, '-ac', '1', '-ar', '48000', audioWav]);
  const fixtureAgent = String.raw`#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessions = path.join(process.cwd(), 'sessions');
let names = [];
for (let i = 0; i < 100; i += 1) { names = (await readdir(sessions).catch(() => [])).filter((name) => name.startsWith('generation-')).sort(); if (names.length) break; await sleep(100); }
if (!names.length) throw new Error('generation session was not created');
const directory = path.join(sessions, names.at(-1));
const capture = JSON.parse(await readFile(path.join(directory, 'capture', 'capture.json'), 'utf8'));
const transcript = JSON.parse(await readFile(path.join(directory, 'capture', 'transcript.json'), 'utf8'));
const context = JSON.parse(await readFile(path.join(directory, 'capture', 'context.json'), 'utf8'));
const evidenceEventIds = capture.events.filter((event) => event.kind === 'action' && event.widget).map((event) => event.id);
const source = ${JSON.stringify(`// SAYSPEC_GENERATED
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patrol/patrol.dart';
import 'package:flutter_sample_app/catalog.dart';
import 'package:flutter_sample_app/main.dart' as app;

/** Local-only builds open the local workspace directly; builds with a cloud backend first offer "Continue as guest". */
async function enterLocalWorkspace(page) {
  const guest = page.getByTestId('continue-guest');
  await guest.or(page.getByTestId('local-project-gate')).or(page.locator('nav')).first().waitFor();
  if (await guest.isVisible()) await guest.click();
}
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
`)};
await writeFile(path.join(directory, 'submission.json'), JSON.stringify({ title: 'Receipt total is twelve dollars', framework: 'patrol', relativePath: 'patrol_test/e07_receipt_test.dart', source, dependencies: context.dependencies, transcriptSegmentIds: transcript.segments.map((segment) => segment.id), evidenceEventIds }, null, 2));
process.stdout.write('fixture submission written\\n');
for (let i = 0; i < 1800; i += 1) { try { const result = JSON.parse(await readFile(path.join(directory, 'submission-result.json'), 'utf8')); process.stdout.write(JSON.stringify(result) + '\\n'); process.exit(result.status === 'saved' ? 0 : 2); } catch {} await sleep(500); }
throw new Error('submission result timed out');
`;
  await writeFile(fakeCli, fixtureAgent);
  await chmod(fakeCli, 0o755);
}

function launchEnvironment() {
  return {
    ...process.env,
    SAYSPEC_TEST_MODE: '1',
    SAYSPEC_RECORDING_SMOKE: '1',
    // Chromium's macOS utility sandbox cannot read an arbitrary temporary
    // fake-microphone WAV. This is the same test-only relaxation used by the
    // established built-Electron transcription smoke; product processes and
    // real microphone capture keep their normal sandbox.
    SAYSPEC_TRANSCRIPTION_SMOKE: '1',
    SAYSPEC_TEST_USER_DATA: userData,
    SAYSPEC_TEST_SOURCE_DIRECTORY: source,
    SAYSPEC_TEST_AUDIO_FILE: audioWav,
    SAYSPEC_CODEX_CLI: fakeCli,
  };
}

async function launch() {
  electronApp = await electron.launch({ args: ['.'], cwd: desktop, env: launchEnvironment(), timeout: 120_000 });
  electronApp.process().stdout?.on('data', (chunk) => process.stdout.write(`[electron] ${chunk}`));
  electronApp.process().stderr?.on('data', (chunk) => process.stderr.write(`[electron] ${chunk}`));
  const page = await electronApp.firstWindow();
  page.on('pageerror', (error) => process.stderr.write(`[renderer-error] ${error.message}\n`));
  page.setDefaultTimeout(180_000);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function closeApp() {
  if (!electronApp) return;
  const current = electronApp; electronApp = undefined;
  await current.close().catch(() => undefined);
}

async function projectScope(page) {
  return page.evaluate(async () => {
    const workspace = await window.sayspec.getLocalWorkspace();
    const project = workspace.projects.find((item) => item.targetType === 'flutter');
    if (!project) throw new Error('Flutter project is missing.');
    return { projectId: project.id, organizationId: 'local' };
  });
}

async function latestAttempt(page, scope, testId) {
  return page.evaluate(async ({ scope: value, testId: id }) => {
    const attempts = await window.sayspec.listPatrolAttempts({ ...value, testId: id });
    return attempts.at(-1);
  }, { scope, testId });
}

async function runFromUi(page, scope, testId, expected, previousCount) {
  // The first visit creates a test run with every saved test; later calls run it again.
  const create = page.getByTestId('create-patrol-run');
  const button = page.getByTestId('run-patrol-run');
  await assert.doesNotReject(() => create.or(button).waitFor({ state: 'visible' }));
  if (await create.isVisible()) {
    await page.getByRole('checkbox', { name: 'Select all' }).check();
    await create.click();
  }
  await assert.doesNotReject(() => button.waitFor({ state: 'visible' }));
  await button.click();
  for (let poll = 0; poll < 1_800; poll += 1) {
    const attempt = await latestAttempt(page, scope, testId);
    if (attempt && attempt.state === expected) {
      const count = await page.evaluate(async ({ scope: value, testId: id }) => (await window.sayspec.listPatrolAttempts({ ...value, testId: id })).length, { scope, testId });
      if (count > previousCount) return attempt;
    }
    await sleep(500);
  }
  throw new Error(`Patrol run did not reach ${expected}.`);
}

try {
  await prepareUserData();
  const device = await readyDevice();
  await adb(device.id, ['shell', 'pm', 'clear', 'dev.sayspec.flutter_sample_app']);
  let page = await launch();
  await enterLocalWorkspace(page);
  await page.getByLabel('Project name').fill('E07 Flutter app');
  await page.getByLabel('Project technology').selectOption('flutter');
  await page.getByRole('button', { name: 'Choose folder' }).click();
  await page.getByTestId('local-project-create').click();
  await page.getByTestId('onboarding-finish').click();
  await page.getByRole('heading', { name: 'Record', exact: true }).waitFor();
  await page.getByLabel('Application ID').fill('dev.sayspec.flutter_sample_app');
  await page.getByLabel('Recording title').fill('Narrated receipt expectation');
  await page.getByRole('button', { name: 'Start Flutter recording' }).click();
  await page.getByRole('button', { name: 'Stop and review' }).waitFor({ timeout: 600_000 });

  let firstScreen = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const nodes = await dumpNodes(device.id).catch(() => []);
    if (nodes.some((node) => (node.contentDesc || node.text) === 'Sign in')) { firstScreen = true; break; }
    await sleep(1_000);
  }
  assert.equal(firstScreen, true, 'instrumented fixture did not show Sign in');
  const density = Number(/(\d+)/.exec((await adb(device.id, ['shell', 'wm', 'density'])).stdout)?.[1]) / 160;
  const sizeMatch = /(\d+)x(\d+)/.exec((await adb(device.id, ['shell', 'wm', 'size'])).stdout);
  assert.ok(sizeMatch && density > 0);
  const centerX = Math.round(Number(sizeMatch[1]) / 2); const dp = (value) => Math.round(value * density);
  await tap(device.id, centerX, dp(24 + 56 + 24 + 28)); await type(device.id, 'fixture@sayspec.local');
  await tap(device.id, centerX, dp(24 + 56 + 24 + 56 + 12 + 28)); await type(device.id, 'fixture-password');
  await tapNode(device.id, 'Sign in'); await tapNode(device.id, 'Add'); await tapNode(device.id, 'Cart'); await tapNode(device.id, 'Place order');
  await page.getByRole('button', { name: 'Stop and review' }).click();
  await page.getByTestId('flutter-capture-review').waitFor({ timeout: 180_000 });
  await page.getByRole('button', { name: 'Transcribe narration' }).click();
  await page.getByText(/receipt total should be (?:twelve dollars|\$12)/i).first().waitFor({ timeout: 300_000 });

  const scope = await projectScope(page);
  const captureBeforeGeneration = await page.evaluate(async (projectId) => {
    const captures = await window.sayspec.listFlutterCaptures({ projectId }); const capture = await window.sayspec.getFlutterCapture({ projectId, captureId: captures[0].id });
    return { id: capture.summary.id, narrationHash: capture.narration?.sha256, transcriptSegments: capture.transcript?.segments.length, events: capture.events.length };
  }, scope.projectId);
  assert.ok(captureBeforeGeneration.narrationHash && captureBeforeGeneration.transcriptSegments > 0 && captureBeforeGeneration.events >= 5);
  await page.getByRole('button', { name: 'Generate tests' }).click();
  await page.getByRole('heading', { name: 'Generate Patrol test' }).waitFor();
  process.stdout.write(`E07_STAGE=generation-open preference=${JSON.stringify(await page.evaluate(() => window.sayspec.getCodingAgentPreference()))}\n`);
  let published;
  for (let poll = 0; poll < 1_800; poll += 1) {
    published = await page.evaluate(async (value) => (await window.sayspec.listPatrolTests(value)).find((item) => item.state === 'published'), scope);
    if (published) break;
    const terminalError = await page.locator('.patrol-generation [role="alert"]').textContent({ timeout: 100 }).catch(() => '');
    if (terminalError) throw new Error(`Patrol generation terminal failed: ${terminalError}`);
    const terminalText = poll % 4 === 0 ? await page.locator('.patrol-generation .xterm-rows').textContent({ timeout: 100 }).catch(() => '') : '';
    if (terminalText?.includes('Coding agent exited')) throw new Error(`Fixture coding agent exited before publication: ${terminalText.slice(-2_000)}`);
    if (poll % 40 === 0) process.stdout.write(`E07_STAGE=generation-wait poll=${poll} terminal=${JSON.stringify(terminalText?.slice(-800))}\n`);
    await sleep(500);
  }
  assert.ok(published, 'the exact passing Patrol submission was not published');
  assert.equal(published.state, 'published');
  await page.getByRole('heading', { name: 'Generate Patrol test' }).locator('xpath=../..').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Tests', exact: true }).click();
  await page.getByText('Receipt total is twelve dollars', { exact: true }).waitFor();
  await closeApp();

  page = await launch();
  await enterLocalWorkspace(page);
  await page.getByRole('button', { name: 'Tests', exact: true }).click();
  await page.getByText('Receipt total is twelve dollars', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page.getByRole('button', { name: 'Choose source folder' }).click();
  const attemptsBeforeReplay = await page.evaluate(async ({ scope: value, testId }) => (await window.sayspec.listPatrolAttempts({ ...value, testId })).length, { scope, testId: published.id });
  const replay = await runFromUi(page, scope, published.id, 'passed', attemptsBeforeReplay);
  assert.equal(replay.versionId, published.versionId);
  assert.equal(replay.testContentHash, published.contentHash);

  await writeFile(catalogPath, originalCatalog.replace("priceCents: 1200", "priceCents: 700"));
  const failed = await runFromUi(page, scope, published.id, 'failed', attemptsBeforeReplay + 1);
  assert.equal(failed.versionId, published.versionId);
  assert.ok(failed.artifacts.some((artifact) => artifact.relativePath === 'patrol-run.log'));
  await writeFile(catalogPath, originalCatalog);
  const retried = await runFromUi(page, scope, published.id, 'passed', attemptsBeforeReplay + 2);
  assert.notEqual(retried.id, failed.id);
  const reopenedAttempts = await page.evaluate(async ({ scope: value, testId }) => window.sayspec.listPatrolAttempts({ ...value, testId }), { scope, testId: published.id });
  assert.equal(reopenedAttempts.find((item) => item.id === failed.id)?.state, 'failed');
  assert.equal(reopenedAttempts.find((item) => item.id === retried.id)?.state, 'passed');
  // Remount Runs to prove the saved history, not only the just-finished local
  // component state, presents both outcomes.
  await page.getByRole('button', { name: 'Tests', exact: true }).click();
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  const attemptHistoryText = await page.getByRole('list', { name: 'Patrol attempts' }).textContent();
  assert.match(attemptHistoryText ?? '', /failed/i);
  assert.match(attemptHistoryText ?? '', /passed/i);

  await closeApp();
  page = await launch(); await enterLocalWorkspace(page);
  const restart = await page.evaluate(async ({ scope: value, testId, captureId }) => ({
    tests: await window.sayspec.listPatrolTests(value),
    attempts: await window.sayspec.listPatrolAttempts({ ...value, testId }),
    capture: await window.sayspec.getFlutterCapture({ projectId: value.projectId, captureId }),
  }), { scope, testId: published.id, captureId: captureBeforeGeneration.id });
  assert.equal(restart.tests[0].contentHash, published.contentHash);
  assert.equal(restart.capture.narration.sha256, captureBeforeGeneration.narrationHash);
  assert.equal(restart.capture.transcript.status, 'ready');
  assert.equal(restart.attempts.find((item) => item.id === failed.id)?.state, 'failed');
  assert.equal(restart.attempts.find((item) => item.id === retried.id)?.state, 'passed');
  process.stdout.write(`E07_ELECTRON_RESULT=${JSON.stringify({ device: `${device.name} (${device.id})`, apiLevel: device.apiLevel, capture: captureBeforeGeneration, testId: published.id, versionId: published.versionId, version: published.version, sourceSha256: published.contentHash, validationAttemptId: published.validationAttemptId, replayAttemptId: replay.id, failedAttemptId: failed.id, retryAttemptId: retried.id, failureArtifacts: failed.artifacts.map((item) => item.relativePath), preservedAcrossRestart: true, providerBoundary: 'deterministic-fixture-cli', microphoneBoundary: 'chromium-fake-device-with-spoken-wav', transcriptText: restart.capture.transcript.segments.map((item) => item.text).join(' ') })}\n`);
} finally {
  await writeFile(catalogPath, originalCatalog).catch(() => undefined);
  await rm(path.join(source, 'patrol_test', 'e07_receipt_test.dart'), { force: true }).catch(() => undefined);
  await closeApp();
  await bootSessions?.shutdown().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
