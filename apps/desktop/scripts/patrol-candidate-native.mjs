import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PatrolRunStore } from '../electron/flutter/patrol-store.ts';
import { PatrolRunner } from '../electron/flutter/patrol-runner.ts';
import { FlutterCaptureStore } from '../electron/flutter/capture-store.ts';
import { FlutterCaptureSessionManager } from '../electron/flutter/session-manager.ts';

const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-candidate-'));
const sourcePath = new URL('../../../fixtures/flutter_sample_app', import.meta.url).pathname.replace(/\/$/, '');
const relativePath = 'patrol_test/sayspec_generation_candidate_test.dart';
const source = `// SAYSPEC_GENERATED
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

async function readyAndroid(sessions) {
  const name = process.env.SAYSPEC_E04_AVD ?? 'Slim_1';
  const find = async () => (await sessions.devices()).find((item) => item.platform === 'android' && item.name === name && item.state === 'ready');
  let device = await find(); if (device) return device;
  const installed = (await sessions.devices()).find((item) => item.platform === 'android' && item.name === name);
  assert.ok(installed, `No installed Android emulator named ${name}.`); await sessions.ensureDevice(installed);
  for (let attempt = 0; attempt < 90; attempt += 1) { device = await find(); if (device) return device; await new Promise((resolve) => setTimeout(resolve, 2_000)); }
  throw new Error(`${name} did not become ready.`);
}

try {
  await rm(path.join(sourcePath, relativePath), { force: true });
  const store = new PatrolRunStore(path.join(root, 'patrol')); await store.initialize();
  const captures = new FlutterCaptureStore(path.join(root, 'captures')); await captures.initialize();
  const sessions = new FlutterCaptureSessionManager({ store: captures, onLifecycle: () => undefined });
  const device = await readyAndroid(sessions);
  const runner = new PatrolRunner({ store, captures: sessions });
  const attempt = await runner.runCandidate({ organizationId: 'local', projectId: 'project_sample', deviceId: device.id }, sourcePath, { title: 'Receipt total', relativePath, source });
  assert.equal(attempt.state, 'passed', `${attempt.summary} ${attempt.detail}`);
  assert.equal(attempt.passed, 1);
  assert.equal(store.listTests('project_sample', 'local').length, 0, 'an unsaved candidate cannot enter the test library');
  await assert.rejects(access(path.join(sourcePath, relativePath)), /ENOENT/, 'candidate source must be removed after validation');
  assert.equal(attempt.runtime.testFileHashes[relativePath], attempt.testContentHash);
  const published = await store.saveTest({ projectId: 'project_sample', organizationId: 'local', title: 'Receipt total', relativePath, source, recordingCaptureId: 'flutter_capture_acceptance', dependencies: { patrol: '4.10.0' }, validationAttemptId: attempt.id, validatedRuntime: attempt.runtime, state: 'published' });
  const reopened = new PatrolRunStore(path.join(root, 'patrol')); await reopened.initialize();
  const frozen = reopened.test(published.id, published.versionId);
  assert.equal(frozen.contentHash, attempt.testContentHash);
  const replayRunner = new PatrolRunner({ store: reopened, captures: sessions });
  const replay = await replayRunner.run({ organizationId: 'local', projectId: 'project_sample', testId: published.id, versionId: published.versionId, deviceId: device.id }, sourcePath);
  assert.equal(replay.state, 'passed', `${replay.summary} ${replay.detail}`);
  assert.equal(replay.versionId, published.versionId);
  assert.equal(replay.testContentHash, published.contentHash);
  assert.equal(createHash('sha256').update(await readFile(path.join(sourcePath, relativePath))).digest('hex'), published.contentHash);
  const restarted = new PatrolRunStore(path.join(root, 'patrol')); await restarted.initialize();
  assert.equal(restarted.attempt(replay.id)?.testContentHash, published.contentHash);
  assert.ok((await restarted.readArtifact({ organizationId: replay.organizationId, projectId: replay.projectId, testId: replay.testId, attemptId: replay.id, relativePath: 'patrol-run.log' })).bytes.byteLength > 0);
  process.stdout.write(`M10_PATROL_CANDIDATE_RESULT=${JSON.stringify({ validationAttemptId: attempt.id, validationState: attempt.state, versionId: published.versionId, version: published.version, sourceSha256: published.contentHash, replayAttemptId: replay.id, replayState: replay.state, runtime: replay.runtime, savedTestsBeforePublish: 0, candidateSourceRestored: true, replayRestartVerified: true })}\n`);
  await replayRunner.shutdown(); await runner.shutdown(); await sessions.shutdown();
} finally { await rm(path.join(sourcePath, relativePath), { force: true }); await rm(root, { recursive: true, force: true }); }
