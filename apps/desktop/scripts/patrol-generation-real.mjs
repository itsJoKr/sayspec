import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FlutterCaptureStore } from '../electron/flutter/capture-store.ts';
import { FlutterCaptureSessionManager } from '../electron/flutter/session-manager.ts';
import { PatrolRunStore } from '../electron/flutter/patrol-store.ts';
import { PatrolRunner } from '../electron/flutter/patrol-runner.ts';
import { SavedWebTestStore } from '../electron/execution/saved-web-tests.ts';
import { ProjectAgentWorkspaceManager } from '../electron/coding-agent/project-agent-workspace.ts';
import { CodingAgentAdapters } from '../electron/coding-agent/adapters.ts';
import { PatrolGenerationTerminalManager } from '../electron/flutter/patrol-generation-terminal.ts';

const run = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-generation-'));
const sourcePath = new URL('../../../fixtures/flutter_sample_app', import.meta.url).pathname.replace(/\/$/, '');
let terminal;

async function readyAndroid(sessions) {
  const name = process.env.SAYSPEC_E04_AVD ?? 'Slim_1';
  const find = async () => (await sessions.devices()).find((item) => item.platform === 'android' && item.name === name && item.state === 'ready');
  let device = await find();
  if (device) return device;
  const installed = (await sessions.devices()).find((item) => item.platform === 'android' && item.name === name);
  assert.ok(installed, `No installed Android emulator named ${name}.`);
  await sessions.ensureDevice(installed);
  for (let attempt = 0; attempt < 90; attempt += 1) { device = await find(); if (device) return device; await new Promise((resolve) => setTimeout(resolve, 2_000)); }
  throw new Error(`${name} did not become ready.`);
}

try {
  const captures = new FlutterCaptureStore(path.join(root, 'captures')); await captures.initialize();
  const draft = await captures.create({ organizationId: 'local', projectId: 'project_sample', title: 'Narrated receipt total', deviceId: 'emulator-5554', deviceName: 'Slim_1', platform: 'android', appId: 'dev.sayspec.flutter_sample_app', recorderSdkVersion: '0.9.0', recorderSchemaVersion: 1 });
  await captures.appendBatch(draft, { envelope: { schemaVersion: 1, clock: { offsetMs: 10_000, roundTripMs: 10, samples: 3, uncertaintyMs: 5 }, sdk: { version: '0.9.0' } }, events: [
    { id: 'event_sign_in_email', seq: 1, kind: 'action', monotonicMs: 200, route: '/', widget: { widgetType: 'TextField', key: 'sign_in_email', candidates: [{ kind: 'key', value: 'sign_in_email', confidence: 'high' }] }, payload: { action: 'enterText' } },
    { id: 'event_sign_in_password', seq: 2, kind: 'action', monotonicMs: 400, route: '/', widget: { widgetType: 'TextField', key: 'sign_in_password', candidates: [{ kind: 'key', value: 'sign_in_password', confidence: 'high' }] }, payload: { action: 'enterText' } },
    { id: 'event_sign_in_submit', seq: 3, kind: 'action', monotonicMs: 600, route: '/', widget: { widgetType: 'FilledButton', key: 'sign_in_submit', candidates: [{ kind: 'key', value: 'sign_in_submit', confidence: 'high' }] }, payload: { action: 'tap' } },
    { id: 'event_add_coffee', seq: 4, kind: 'action', monotonicMs: 900, route: '/catalog', widget: { widgetType: 'FilledButton', key: 'add_item_coffee', candidates: [{ kind: 'key', value: 'add_item_coffee', confidence: 'high' }] }, payload: { action: 'tap' } },
    { id: 'event_open_cart', seq: 5, kind: 'action', monotonicMs: 1200, route: '/catalog', widget: { widgetType: 'TextButton', key: 'open_cart', candidates: [{ kind: 'key', value: 'open_cart', confidence: 'high' }] }, payload: { action: 'tap' } },
    { id: 'event_place_order', seq: 6, kind: 'action', monotonicMs: 1500, route: '/cart', widget: { widgetType: 'FilledButton', key: 'cart_place_order', candidates: [{ kind: 'key', value: 'cart_place_order', confidence: 'high' }] }, payload: { action: 'tap' } },
    { id: 'event_receipt_total', seq: 7, kind: 'action', monotonicMs: 1900, route: '/receipt', widget: { widgetType: 'Text', key: 'receipt_total', text: 'Total paid $12.00', candidates: [{ kind: 'key', value: 'receipt_total', confidence: 'high' }] }, payload: { action: 'observe' } },
  ] });
  const audioPath = path.join(root, 'expectation.aiff');
  await run('/usr/bin/say', ['-o', audioPath, 'When I place the order, the receipt total should be twelve dollars.']);
  const audio = await readFile(audioPath);
  await captures.beginNarration(draft, 'audio/aiff', 10_000);
  await captures.appendNarration(draft, 'audio/aiff', audio);
  await captures.finishNarration(draft, 13_211);
  await captures.setStatus(draft, 'ready');
  await captures.writeTranscript(draft.id, { schemaVersion: 1, recordingId: draft.id, status: 'ready', provider: { kind: 'local', runtime: 'whisper.cpp', runtimeVersion: '1.8.3', modelId: 'whisper-small-q5_1', modelSha256: '5'.repeat(64), translated: false }, segments: [{ id: 'transcript_receipt_total', recordingSegmentId: 'flutter_narration', startMs: 0, endMs: 3211, timingUncertaintyMs: 5, originalText: 'When I place the order, the receipt total should be $12.', text: 'When I place the order, the receipt total should be $12.', revisions: [], evidenceEventIds: ['event_place_order', 'event_receipt_total'] }], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), warnings: [] });

  const patrol = new PatrolRunStore(path.join(root, 'patrol')); await patrol.initialize();
  const baseline = `import 'package:flutter_test/flutter_test.dart';\nimport 'package:patrol/patrol.dart';\nvoid main(){ patrolTest('baseline example', (\$) async { expect(true, isTrue); }); }\n`;
  await patrol.saveTest({ organizationId: 'local', projectId: 'project_sample', title: 'Existing Patrol example', relativePath: 'patrol_test/existing_example_test.dart', source: baseline, state: 'execution-validated' });
  const sessions = new FlutterCaptureSessionManager({ store: captures, onLifecycle: () => undefined });
  const device = await readyAndroid(sessions);
  const runner = new PatrolRunner({ store: patrol, captures: sessions });
  const web = new SavedWebTestStore(path.join(root, 'web')); await web.initialize();
  const workspaces = new ProjectAgentWorkspaceManager(path.join(root, 'workspaces'), web, patrol);
  const adapters = new CodingAgentAdapters();
  let resolveSaved; let rejectSaved;
  const saved = new Promise((resolve, reject) => { resolveSaved = resolve; rejectSaved = reject; });
  const output = [];
  terminal = new PatrolGenerationTerminalManager({ workspaces, captures, runs: patrol, runner, adapters,
    onEvent(event) { if (event.data) output.push(event.data); if (event.kind === 'exit' && !patrol.listTests('project_sample', 'local').some((item) => item.recordingCaptureId === draft.id)) rejectSaved(new Error(`Codex exited before saving.\n${output.join('').slice(-8_000)}`)); },
    async onSaved(test) { resolveSaved(test); },
  });
  await terminal.start({ projectId: 'project_sample', sessionId: draft.id, sourcePath, deviceId: device.id, appId: 'dev.sayspec.flutter_sample_app', provider: 'codex', cols: 120, rows: 36 });
  const timeout = setTimeout(() => rejectSaved(new Error(`Timed out waiting for Codex Patrol generation.\n${output.join('').slice(-8_000)}`)), 12 * 60_000);
  const test = await saved; clearTimeout(timeout);
  const attempt = patrol.attempt(test.validationAttemptId);
  assert.equal(test.state, 'execution-validated');
  assert.equal(attempt?.state, 'passed');
  assert.equal(test.contentHash, attempt?.testContentHash);
  assert.equal(test.provider, 'codex');
  assert.equal(test.dependencies?.patrol, '4.10.0');
  assert.match(test.source, /receipt|Total paid/i);
  assert.equal(await readFile(path.join(sourcePath, test.relativePath), 'utf8').then(() => false).catch(() => true), true, 'candidate source must be restored after validation');
  process.stdout.write(`M10_PATROL_GENERATION_RESULT=${JSON.stringify({ provider: test.provider, testId: test.id, captureId: draft.id, attemptId: attempt.id, sourceSha256: test.contentHash, dependencyManifest: test.dependencies, runtime: attempt.runtime, outcome: attempt.state, sourceRestored: true })}\n`);
  await terminal.close(draft.id); await runner.shutdown(); await sessions.shutdown(); await web.shutdown();
} finally {
  await terminal?.shutdown().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
