import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PatrolRunStore } from '../electron/flutter/patrol-store.ts';
import { PatrolRunner } from '../electron/flutter/patrol-runner.ts';
import { FlutterCaptureStore } from '../electron/flutter/capture-store.ts';
import { FlutterCaptureSessionManager } from '../electron/flutter/session-manager.ts';

/**
 * E04 — saved Patrol test execution on a leased Android device, or on an iOS
 * simulator with SAYSPEC_E04_PLATFORM=ios (SAYSPEC_E04_SIMULATOR names it).
 *
 * The assertions below are written the way the recording evidence suggests:
 * every finder uses a key the recorder captured for that widget.
 */
const source = new URL('../../../fixtures/flutter_sample_app', import.meta.url).pathname.replace(/\/$/, '');
const stage = (message) => process.stderr.write(`E04_STAGE=${message}\n`);
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`E04_UNHANDLED=${reason instanceof Error ? reason.stack : String(reason)}\n`);
});
const profile = await mkdtemp(path.join(tmpdir(), 'sayspec-e04-'));

const PASSING = `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patrol/patrol.dart';

import 'package:flutter_sample_app/catalog.dart';
import 'package:flutter_sample_app/main.dart' as app;

void main() {
  patrolTest('receipt total is shown for two items', (\$) async {
    await \$.pumpWidgetAndSettle(const app.SampleApp());
    await \$(\$(AppKeys.signInEmail)).enterText('fixture@sayspec.local');
    await \$(\$(AppKeys.signInPassword)).enterText('fixture-password');
    await \$(\$(AppKeys.signInSubmit)).tap();
    await \$(\$(AppKeys.addFirstItem)).tap();
    await \$(\$(AppKeys.addSecondItem)).tap();
    await \$(\$(AppKeys.openCart)).tap();
    await \$(\$(AppKeys.cartPlaceOrder)).tap();
    expect(\$(\$(AppKeys.receiptTotal)).text, 'Total paid \\$20.00');
  });
}
`;

const FAILING = `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patrol/patrol.dart';

import 'package:flutter_sample_app/catalog.dart';
import 'package:flutter_sample_app/main.dart' as app;

void main() {
  patrolTest('cart total is shown for two items', (\$) async {
    await \$.pumpWidgetAndSettle(const app.SampleApp());
    await \$(\$(AppKeys.signInEmail)).enterText('fixture@sayspec.local');
    await \$(\$(AppKeys.signInPassword)).enterText('fixture-password');
    await \$(\$(AppKeys.signInSubmit)).tap();
    await \$(\$(AppKeys.addFirstItem)).tap();
    await \$(\$(AppKeys.addSecondItem)).tap();
    await \$(\$(AppKeys.openCart)).tap();
    expect(\$(\$(AppKeys.cartTotal)).text, 'Total \\$20.00');
  });
}
`;

// Each scenario owns its own file so switching sources cannot be mistaken
// for an in-place edit of a saved test.
const passPath = 'patrol_test/sayspec_cart_pass_test.dart';
const failPath = 'patrol_test/sayspec_cart_fail_test.dart';
const brokenPath = 'patrol_test/sayspec_cart_broken_test.dart';
const cancelPath = 'patrol_test/sayspec_cart_cancel_test.dart';

async function writeTest(relativePath, source_) {
  await mkdir(path.dirname(path.join(source, relativePath)), { recursive: true });
  await writeFile(path.join(source, relativePath), source_);
}

/**
 * Resolves a ready Android device, booting the named AVD when necessary.
 *
 * The Android emulator on this host has been observed to exit between runs, so
 * the acceptance script waits for a real device instead of failing later with
 * a misleading "device not available" from inside a scenario.
 */
async function ensureAndroidDevice(sessions, avdName) {
  const find = async () => (await sessions.devices()).find((entry) => entry.platform === 'android' && entry.kind === 'emulator' && entry.name === avdName && entry.state === 'ready');
  const ready = await find();
  if (ready) return ready;
  const avd = (await sessions.devices()).find((entry) => entry.platform === 'android' && entry.kind === 'emulator' && entry.name === avdName);
  assert.ok(avd, `no ready emulator and no installed AVD named ${avdName}`);
  await sessions.ensureDevice(avd);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const next = await find();
    if (next) return next;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${avdName} did not become ready`);
}

/** Resolves the named iOS simulator, booting it when it is shut down. */
async function ensureIosSimulator(sessions, name) {
  const simulator = (await sessions.devices()).find((entry) => entry.platform === 'ios' && entry.name === name);
  assert.ok(simulator, `no iOS simulator named ${name}`);
  return sessions.ensureDevice(simulator);
}

const platform = process.env.SAYSPEC_E04_PLATFORM ?? 'android';

try {
  const store = new PatrolRunStore(path.join(profile, 'patrol'));
  await store.initialize();
  const captures = new FlutterCaptureStore(path.join(profile, 'captures'));
  await captures.initialize();
  const sessions = new FlutterCaptureSessionManager({ store: captures, onLifecycle: () => undefined });
  const runner = new PatrolRunner({ store, captures: sessions });

  // The acceptance run needs a booted device and must not assume a warm
  // emulator: it starts the named AVD itself when none is ready.
  const device = platform === 'ios'
    ? await ensureIosSimulator(sessions, process.env.SAYSPEC_E04_SIMULATOR ?? 'iPhone 17')
    : await ensureAndroidDevice(sessions, process.env.SAYSPEC_E04_AVD ?? 'Slim_1');
  stage(`device ${device.name} (${device.id})`);

  // 1. A known saved test runs unchanged and passes with a real report.
  await writeTest(passPath, PASSING);
  const test = await store.saveTest({ projectId: 'project_sample', organizationId: 'local', title: 'Receipt total', relativePath: passPath, source: PASSING });
  stage('pass-run');
  const passed = await runner.run({ organizationId: 'local', projectId: 'project_sample', testId: test.id, deviceId: device.id }, source);
  if (passed.state !== 'passed') {
    const log = await store.readArtifact({ organizationId: passed.organizationId, projectId: passed.projectId, testId: passed.testId, attemptId: passed.id, relativePath: 'patrol-run.log' }).then((artifact) => artifact.bytes.toString('utf8')).catch(() => 'no log artifact');
    process.stderr.write(`E04_PATROL_LOG=${JSON.stringify(log.slice(-4_000))}\n`);
  }
  if (passed.state !== 'passed') {
    process.stderr.write(`E04_ERRORS=${JSON.stringify(passed.tests.flatMap((item) => item.errors).map((item) => item.slice(0, 1_200)))}\n`);
  }
  assert.equal(passed.state, 'passed', `${passed.summary} ${passed.detail}`);
  assert.equal(passed.passed, 1);
  assert.ok(passed.tests.some((item) => item.outcome === 'passed'), 'the reporter must produce a per-test outcome');
  assert.ok(passed.artifacts.some((artifact) => artifact.relativePath === 'patrol-run.log'));
  assert.equal(passed.runtime.patrolPackageVersion, '4.10.0');
  assert.ok(passed.runtime.flutterVersion && passed.runtime.patrolCliVersion, 'the runtime manifest must record the resolved toolchain');
  assert.equal(store.activeLeases().length, 0, 'the device lease must be released after a run');
  // The saved test is now execution-validated; its source is unchanged.
  assert.equal(store.test(test.id).contentHash, test.contentHash);

  // 2. An assertion failure is a real failure, distinct from infrastructure.
  await writeTest(failPath, FAILING);
  const failingTest = await store.saveTest({ projectId: 'project_sample', organizationId: 'local', title: 'Cart total (defect)', relativePath: failPath, source: FAILING });
  stage('fail-run');
  const failed = await runner.run({ organizationId: 'local', projectId: 'project_sample', testId: failingTest.id, deviceId: device.id }, source);
  assert.equal(failed.state, 'failed', `${failed.summary} ${failed.detail}`);
  assert.equal(failed.failed, 1);
  assert.ok(failed.tests.some((item) => item.errors.length > 0), 'the failure must carry the reporter error text');

  // 3. A retry is a separate attempt; the first failure is preserved.
  stage('retry-run');
  const retried = await runner.run({ organizationId: 'local', projectId: 'project_sample', testId: failingTest.id, deviceId: device.id }, source);
  assert.equal(retried.state, 'failed');
  const attempts = store.attempts('project_sample', 'local', failingTest.id);
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0]?.id, attempts[1]?.id);
  assert.ok(attempts[0]?.finishedAt, 'the earlier attempt stays frozen');

  // 4. A build failure is an infrastructure error, never a test failure.
  await writeTest(brokenPath, PASSING.replace("import 'package:flutter_sample_app/catalog.dart';", "import 'package:flutter_sample_app/does_not_exist.dart';"));
  const brokenTest = await store.saveTest({
    projectId: 'project_sample', organizationId: 'local', title: 'Broken build', relativePath: brokenPath,
    source: PASSING.replace("import 'package:flutter_sample_app/catalog.dart';", "import 'package:flutter_sample_app/does_not_exist.dart';"),
  });
  stage('build-failure-run');
  const buildFailure = await runner.run({ organizationId: 'local', projectId: 'project_sample', testId: brokenTest.id, deviceId: device.id }, source);
  assert.equal(buildFailure.state, 'infrastructure-error', `${buildFailure.summary} ${buildFailure.detail}`);
  assert.equal(buildFailure.passed, 0);
  assert.equal(store.activeLeases().length, 0);

  // 5. A disconnected device is blocked before a misleading run starts.
  stage('disconnected-run');
  const disconnected = await runner.run({ organizationId: 'local', projectId: 'project_sample', testId: test.id, deviceId: platform === 'ios' ? 'ios:00000000-0000-0000-0000-000000000000' : 'emulator-missing' }, source);
  assert.equal(disconnected.state, 'blocked');
  assert.match(disconnected.detail, /not connected/i);

  // 6. Assertion failures and infrastructure failures are separable, and
  //    cancellation releases the lease.
  await writeTest(cancelPath, PASSING);
  const cancelTest = await store.saveTest({ projectId: 'project_sample', organizationId: 'local', title: 'Cancelable', relativePath: cancelPath, source: PASSING });
  stage('cancel-run');
  const running = runner.run({ organizationId: 'local', projectId: 'project_sample', testId: cancelTest.id, deviceId: device.id }, source);
  // The run is intentionally not awaited: a rejection here would otherwise
  // surface as an unhandled rejection and hide which assertion really failed.
  const settled = running.then((value) => ({ value }), (error) => ({ error }));
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const attemptId = store.activeLeases()[0]?.attemptId;
  assert.ok(attemptId, `a running attempt must hold the device lease; settled=${JSON.stringify(await Promise.race([settled, Promise.resolve('pending')]))}`);
  const busy = await runner.run({ organizationId: 'local', projectId: 'project_sample', testId: cancelTest.id, deviceId: device.id }, source);
  assert.equal(busy.state, 'blocked');
  assert.match(busy.detail, /already running attempt/i);
  await runner.cancel({ organizationId: 'local', projectId: 'project_sample', testId: cancelTest.id, attemptId });
  const outcome = await settled;
  if ('error' in outcome) throw outcome.error;
  const canceled = outcome.value;
  assert.equal(canceled.state, 'canceled', `${canceled.summary} ${canceled.detail}`);
  assert.equal(store.activeLeases().length, 0, 'cancellation must release the lease');

  process.stdout.write(`E04_RESULT=${JSON.stringify({
    device: `${device.name} (${device.id})`,
    pass: { state: passed.state, passed: passed.passed, tests: passed.tests.map((item) => `${item.title}:${item.outcome}`), artifacts: passed.artifacts.map((item) => item.relativePath), runtime: { flutter: passed.runtime.flutterVersion, patrolCli: passed.runtime.patrolCliVersion, patrolPackage: passed.runtime.patrolPackageVersion } },
    assertionFailure: { state: failed.state, failed: failed.failed, firstError: failed.tests.flatMap((item) => item.errors)[0]?.slice(0, 160) },
    retry: { attempts: attempts.length, states: attempts.map((item) => item.state), distinctIds: new Set(attempts.map((item) => item.id)).size },
    buildFailure: { state: buildFailure.state, detail: buildFailure.detail.slice(0, 160) },
    disconnectedDevice: { state: disconnected.state, detail: disconnected.detail },
    duplicateLeaseDenied: busy.detail,
    canceled: { state: canceled.state, leasesAfter: store.activeLeases().length },
  })}\n`);
} finally {
  // The scenarios materialize real Patrol files into the fixture project; they
  // are run inputs, not fixtures, so they are removed afterwards.
  for (const name of ['sayspec_cart_pass_test.dart', 'sayspec_cart_fail_test.dart', 'sayspec_cart_broken_test.dart', 'sayspec_cart_cancel_test.dart', 'test_bundle.dart']) {
    await rm(path.join(source, 'patrol_test', name), { force: true }).catch(() => undefined);
  }
  await rm(profile, { recursive: true, force: true });
}
