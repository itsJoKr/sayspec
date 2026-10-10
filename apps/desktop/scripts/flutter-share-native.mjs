import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { FlutterCaptureStore } from '../electron/flutter/capture-store.ts';
import { PatrolRunStore, environmentHash } from '../electron/flutter/patrol-store.ts';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Flutter Pro native sharing requires the Firebase emulator environment.');
const root = await mkdtemp('/private/tmp/sayspec-flutter-share-native-');
const userData = path.join(root, 'user-data');
const desktop = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const organizationId = 'org_rival'; const projectId = 'project_rival'; const createdByUid = 'user_outsider';
const captureStore = new FlutterCaptureStore(path.join(userData, 'flutter-captures'));
const runStore = new PatrolRunStore(path.join(userData, 'patrol-runs'));
let electronApp;
let adminApp;

try {
  await captureStore.initialize(); await runStore.initialize();
  const capture = await captureStore.create({ organizationId, projectId, title: 'Pro narrated receipt', deviceId: 'emulator-5554', deviceName: 'Slim_1', platform: 'android', appId: 'dev.sayspec.flutter_sample_app', recorderSdkVersion: '0.9.0', recorderSchemaVersion: 1 });
  await captureStore.appendBatch(capture, { envelope: { schemaVersion: 1, clock: { offsetMs: 1_000, roundTripMs: 10, samples: 3, uncertaintyMs: 5 }, sdk: { version: '0.9.0' } }, events: [{ id: 'event_receipt', seq: 1, kind: 'action', monotonicMs: 500, route: '/receipt', widget: { widgetType: 'Text', key: 'receipt_total', candidates: [{ kind: 'key', value: 'receipt_total', confidence: 'high' }] }, payload: { action: 'observe' } }] });
  await captureStore.beginNarration(capture, 'audio/webm', 1_000); await captureStore.appendNarration(capture, 'audio/webm', Buffer.from('fixture-owned-audio')); await captureStore.finishNarration(capture, 2_000); await captureStore.setStatus(capture, 'ready');
  await captureStore.writeTranscript(capture.id, { schemaVersion: 1, recordingId: capture.id, status: 'ready', provider: { kind: 'local', runtime: 'whisper.cpp', runtimeVersion: '1.9.4', modelId: 'whisper-small-q5_1-multilingual', modelSha256: 'a'.repeat(64), translated: false }, segments: [{ id: 'transcript_receipt', recordingSegmentId: 'narration_1', startMs: 0, endMs: 1_000, timingUncertaintyMs: 5, originalText: 'The receipt total should be twelve dollars.', text: 'The receipt total should be twelve dollars.', revisions: [], evidenceEventIds: ['event_receipt'] }], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), warnings: [] });
  const source = "// SAYSPEC_GENERATED\nimport 'package:flutter_test/flutter_test.dart';\nimport 'package:patrol/patrol.dart';\nvoid main() { patrolTest('receipt total', ($) async { expect(true, isTrue); }); }\n";
  const runtime = { flutterVersion: '3.38.5', dartVersion: '3.10.4', patrolCliVersion: '4.8.0', patrolPackageVersion: '4.10.0', deviceId: 'emulator-5554', deviceName: 'Slim_1', platform: 'android', apiLevel: '37', entrypoint: 'patrol_test/pro_receipt_test.dart', testFileHashes: { 'patrol_test/pro_receipt_test.dart': createHash('sha256').update(source).digest('hex') }, environmentHash: environmentHash({ flutterVersion: '3.38.5', patrolCliVersion: '4.8.0', patrolPackageVersion: '4.10.0', deviceId: 'emulator-5554', entrypoint: 'patrol_test/pro_receipt_test.dart' }) };
  const version = await runStore.saveTest({ organizationId, projectId, title: 'Pro receipt total', relativePath: runtime.entrypoint, source, recordingCaptureId: capture.id, dependencies: { patrol: '4.10.0' }, provider: 'codex', validationAttemptId: 'patrol_attempt_validation', validatedRuntime: runtime, state: 'published' });
  const attempt = { schemaVersion: 1, id: 'patrol_attempt_pro_share', testId: version.id, versionId: version.versionId, organizationId, projectId, testContentHash: version.contentHash, runtime, state: 'passed', deviceId: 'emulator-5554', leaseId: 'patrol_lease_released', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: '1 passed', detail: 'Client-reported local Patrol execution.', passed: 1, failed: 0, skipped: 0, tests: [{ id: 'receipt total', title: 'receipt total', outcome: 'passed', durationMs: 100, errors: [] }], artifacts: [], exitCode: 0, runner: 'desktop-local-patrol' };
  await runStore.recordAttempt(attempt);

  electronApp = await electron.launch({ args: ['.'], cwd: desktop, env: { ...process.env, SAYSPEC_TEST_MODE: '1', SAYSPEC_TEST_USER_DATA: userData }, timeout: 120_000 });
  const page = await electronApp.firstWindow(); page.setDefaultTimeout(180_000); await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2_000);
  process.stdout.write(`E07_PRO_STAGE=entry body=${JSON.stringify((await page.locator('body').innerText()).slice(0, 1_000))}\n`);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.getByLabel('Email').fill('outsider@sayspec.local'); await page.getByLabel('Password').fill('local-only-password');
  await page.locator('.auth-form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForTimeout(3_000);
  process.stdout.write(`E07_PRO_STAGE=sign-in-submitted body=${JSON.stringify((await page.locator('body').innerText()).slice(0, 1_500))}\n`);
  await page.getByText('outsider@sayspec.local', { exact: true }).waitFor();
  process.stdout.write(`E07_PRO_STAGE=signed-in body=${JSON.stringify((await page.locator('body').innerText()).slice(0, 1_000))}\n`);
  await page.getByLabel('Organization').selectOption(organizationId);
  await page.getByLabel('Project').selectOption(projectId);
  process.stdout.write(`E07_PRO_STAGE=scope-selected\n`);
  await page.getByRole('button', { name: 'Pro narrated receipt' }).click();
  await page.getByTestId('flutter-capture-review').waitFor();
  process.stdout.write(`E07_PRO_STAGE=capture-open\n`);
  await page.getByText('Explicit Pro sharing', { exact: true }).waitFor();
  const rawAudio = page.getByLabel('Include raw narration audio'); assert.equal(await rawAudio.isChecked(), false);
  await page.getByRole('button', { name: 'Share Flutter slice' }).click();
  process.stdout.write(`E07_PRO_STAGE=share-clicked\n`);
  await page.getByText(/This Flutter slice is shared/).waitFor({ timeout: 180_000 });

  adminApp = initializeApp({ projectId: 'demo-sayspec-local' }, `flutter-native-share-${Date.now()}`);
  const shareId = `flutter_share_${version.versionId.replace(/^patrol_version_/, '')}`;
  const shared = await getFirestore(adminApp).doc(`organizations/${organizationId}/projects/${projectId}/flutterShares/${shareId}`).get();
  assert.equal(shared.data()?.status, 'shared'); assert.equal(shared.data()?.clientReported, true); assert.equal(shared.data()?.manifest?.includeRawAudio, false);
  assert.equal(shared.data()?.manifest?.testVersion?.contentHash, version.contentHash); assert.equal(shared.data()?.manifest?.attempt?.id, attempt.id);
  const reopenedCapture = await captureStore.get(projectId, capture.id); assert.equal(reopenedCapture.summary.shareState, 'shared');
  process.stdout.write(`E07_PRO_ELECTRON_RESULT=${JSON.stringify({ shareId, status: shared.data()?.status, user: createdByUid, organizationId, projectId, versionId: version.versionId, sourceSha256: version.contentHash, attemptId: attempt.id, clientReported: shared.data()?.clientReported, rawAudioIncluded: shared.data()?.manifest?.includeRawAudio, localShareState: reopenedCapture.summary.shareState })}\n`);
} finally {
  await electronApp?.close().catch(() => undefined);
  if (adminApp) await deleteApp(adminApp).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
