import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FlutterCaptureStore } from '../electron/flutter/capture-store.ts';
import { FlutterCaptureSessionManager } from '../electron/flutter/session-manager.ts';
import { deriveAssertions } from '../electron/flutter/capture-store.ts';
import { resolveTool, runFile } from '../electron/setup/environment.ts';

/**
 * F05 — Flutter recording feasibility, driven end to end.
 *
 * Uses the same capture server and session manager the Electron app uses, so
 * a pass here is evidence about the product path, not a fixture. The device is
 * driven with real `adb` input events, which is what the recorder observes.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const source = new URL('../../../fixtures/flutter_sample_app', import.meta.url).pathname.replace(/\/$/, '');
const profile = await mkdtemp(path.join(tmpdir(), 'sayspec-f05-'));
const lifecycle = [];

async function adb(serial, args) {
  const tool = await resolveTool({ name: 'adb' });
  return runFile(tool.path, ['-s', serial, ...args], { timeoutMs: 60_000 });
}

async function tap(serial, x, y) {
  await adb(serial, ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  await sleep(900);
}

/**
 * Reads the device accessibility tree. Flutter exposes semantics nodes here,
 * which is what makes driving the fixture deterministic instead of
 * coordinate-guessing.
 */
async function dumpNodes(serial) {
  // `uiautomator dump` intermittently fails with "could not get idle state"
  // while Flutter animates, so failures are retried by the callers.
  const dump = await adb(serial, ['shell', 'uiautomator', 'dump', '--compressed', '/sdcard/sayspec-ui.xml']);
  if (!/dumped to/i.test(dump.stdout)) throw new Error(`uiautomator dump failed: ${dump.stdout}${dump.stderr}`);
  const xml = await adb(serial, ['shell', 'cat', '/sdcard/sayspec-ui.xml']);
  return [...xml.stdout.matchAll(/<node\s[^>]*>/g)].map((match) => {
    const attribute = (name) => new RegExp(`${name}="([^"]*)"`).exec(match[0])?.[1] ?? '';
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(match[0]);
    return {
      text: attribute('text'), contentDesc: attribute('content-desc'), className: attribute('class'),
      password: attribute('password'), clickable: attribute('clickable'),
      center: bounds ? { x: (Number(bounds[1]) + Number(bounds[3])) / 2, y: (Number(bounds[2]) + Number(bounds[4])) / 2 } : undefined,
    };
  }).filter((node) => node.center);
}

/** Taps the centre of the first node matching the predicate. */
async function tapNode(serial, predicate, label = 'expected node') {
  let node;
  let lastSeen = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    lastSeen = (await dumpNodes(serial).catch(() => [])).filter((item) => item.contentDesc || item.text);
    // An AppBar title and its button can share the same label, so a clickable
    // node always wins over a decorative one.
    node = lastSeen.find((item) => item.clickable === 'true' && predicate(item)) ?? lastSeen.find(predicate);
    if (node && node.clickable === 'true') break;
    if (node) break;
    await sleep(1_000);
  }
  assert.ok(node, `${label} was not present on the device; saw ${JSON.stringify(lastSeen.map((item) => `${item.className.split('.').pop()}:${item.contentDesc || item.text}`).slice(0, 24))}`);
  await tap(serial, node.center.x, node.center.y);
}

/** Waits until the session manager reports a lifecycle state for a capture. */
async function waitForLifecycle(state, captureId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = lifecycle.find((event) => event.state === state && (!captureId || event.captureId === captureId));
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`no ${state} lifecycle for ${captureId ?? 'any capture'}; saw ${JSON.stringify(lifecycle.map((event) => `${event.state}:${event.captureId}:${event.message}`))}`);
}

async function type(serial, text) {
  await adb(serial, ['shell', 'input', 'text', text.replaceAll(' ', '%s')]);
  await sleep(400);
}

let instance;
let sessions;
let captureId;
try {
  const store = new FlutterCaptureStore(path.join(profile, 'captures'));
  await store.initialize();
  sessions = new FlutterCaptureSessionManager({ store, onLifecycle: (event) => lifecycle.push(event) });
  // Target one named AVD so the acceptance result describes a known device,
  // and boot it when it is not already running.
  const requestedAvd = process.env.SAYSPEC_F05_AVD ?? 'Slim_1';
  const devices = await sessions.devices();
  const device = devices.find((entry) => entry.platform === 'android' && entry.state === 'ready' && entry.name === requestedAvd)
    ?? devices.find((entry) => entry.platform === 'android' && entry.kind === 'emulator' && entry.name === requestedAvd)
    ?? devices.find((entry) => entry.platform === 'android' && entry.state === 'ready');
  assert.ok(device, `no Android device or AVD named ${requestedAvd} is available; saw ${JSON.stringify(devices.map((entry) => `${entry.name}:${entry.state}`))}`);
  // The fixture app is relaunched from a clean state, so a previous run's
  // navigation cannot leak into this recording.
  await adb(device.id, ['shell', 'pm', 'clear', 'dev.sayspec.flutter_sample_app']);

  const summary = await sessions.start({ projectId: 'project_sample', projectName: 'Sample shop', deviceId: device.id, appId: 'dev.sayspec.flutter_sample_app', title: 'F05 cart flow' }, source);
  // The app opens idle with the SaySpec overlay; nothing records until Record.
  assert.equal(summary.status, 'preparing');
  captureId = summary.id;

  // `app.started` fires before the first frame is drawn, so wait until the
  // sign-in screen is actually up before touching it.
  let firstScreen = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const nodes = await dumpNodes(device.id).catch(() => []);
    if (nodes.some((node) => (node.contentDesc || node.text) === 'Sign in')) { firstScreen = true; break; }
    await sleep(1_000);
  }
  if (!firstScreen) {
    const seen = await dumpNodes(device.id).catch((error) => [{ text: `dump failed: ${error.message}`, contentDesc: '', className: '' }]);
    process.stderr.write(`F05_SCREEN_NODES=${JSON.stringify(seen.map((node) => `${node.className.split('.').pop()}:${node.contentDesc || node.text}`).slice(0, 20))}\n`);
    process.stderr.write(`F05_FLUTTER_LOG=${JSON.stringify(sessions.getLog(summary.id).slice(-2_000))}\n`);
  }
  assert.ok(firstScreen, 'the instrumented app never showed its sign-in screen');
  await tapNode(device.id, (node) => node.contentDesc === 'Record', 'the SaySpec overlay Record button');
  await waitForLifecycle('recording', summary.id, 20_000);

  /**
   * Empty `TextField`s are not exposed in the accessibility tree, so the two
   * credential fields are addressed by the layout positions measured from this
   * device's own dump (56 dp fields, 24 dp padding, 12/20 dp gaps). Every other
   * control is found by its semantics node, so the flow does not depend on
   * guessed geometry.
   */
  const density = await adb(device.id, ['shell', 'wm', 'density']);
  const scale = Number(/(\d+)/.exec(density.stdout)?.[1] ?? 0) / 160;
  assert.ok(scale > 0, 'the device must report a density so dp positions can be computed');
  const size = await adb(device.id, ['shell', 'wm', 'size']);
  const screen = /(\d+)x(\d+)/.exec(size.stdout);
  assert.ok(screen, 'the device must report its screen size');
  const dp = (value) => Math.round(value * scale);
  const centerX = Math.round(Number(screen[1]) / 2);
  // Material layout of the fixture's sign-in form: 24 dp padding, 56 dp fields,
  // 12 dp and 20 dp gaps. Derived per device instead of hard-coded.
  const emailY = dp(24 + 56 + 24 + 28);
  const passwordY = dp(24 + 56 + 24 + 56 + 12 + 28);
  await tap(device.id, centerX, emailY);
  await type(device.id, 'fixture@sayspec.local');
  await tap(device.id, centerX, passwordY);
  await type(device.id, 'fixture-password');
  await tapNode(device.id, (node) => (node.contentDesc || node.text) === 'Sign in', 'the Sign in button');
  await tapNode(device.id, (node) => (node.contentDesc || node.text) === 'Add', 'a catalog Add button');
  await sleep(800);
  await tapNode(device.id, (node) => (node.contentDesc || node.text) === 'Add', 'the second catalog Add button');
  await sleep(800);
  await tapNode(device.id, (node) => (node.contentDesc || node.text) === 'Cart', 'the Cart button');
  await tapNode(device.id, (node) => (node.contentDesc || node.text) === 'Place order', 'the Place order button');
  await sleep(2_000);

  const capture = await sessions.stop(summary.id);
  const assertions = deriveAssertions(capture.events);
  const record = {
    device: `${device.name} (${device.id})`,
    screen: `${screen[1]}x${screen[2]} @${scale}x`,
    eventCount: capture.summary.eventCount,
    clockUncertaintyMs: capture.clock.uncertaintyMs,
    kinds: [...new Set(capture.events.map((event) => event.kind))],
    routes: [...new Set(capture.events.map((event) => event.route).filter(Boolean))],
    identifiedWidgets: capture.events.filter((event) => event.widget?.key || event.widget?.semanticLabel || event.widget?.text).length,
    suggestionCount: assertions.length,
    highConfidence: assertions.filter((item) => item.confidence === 'high').length,
    screenshotCount: capture.artifacts.length,
    warnings: capture.summary.completenessWarnings,
    sample: capture.events.filter((event) => event.kind === 'action').slice(0, 4).map((event) => ({ route: event.route, widget: event.widget?.key ?? event.widget?.text ?? event.widget?.widgetType, hostAlignedMs: event.hostAlignedMs })),
    lifecycle: lifecycle.map((event) => `${event.state}: ${event.message}`),
  };
  process.stdout.write(`F05_EVENTS=${JSON.stringify(capture.events.map((event) => ({ kind: event.kind, route: event.route, widget: event.widget?.widgetType, key: event.widget?.key, text: event.widget?.text, candidates: event.widget?.candidates?.map((item) => `${item.kind}:${item.value}`) })))}\n`);
  assert.ok(capture.summary.eventCount >= 5, 'the recorder must observe the driven interactions');
  assert.ok(record.identifiedWidgets >= 2, 'at least two events must carry a durable widget identity');
  assert.ok(record.highConfidence >= 1, 'recorded keys must produce a high-confidence finder suggestion');
  assert.ok(record.routes.length >= 2, `navigation must be recorded; captured routes: ${JSON.stringify(record.routes)}`);
  assert.ok(capture.clock.samples > 0 && capture.clock.uncertaintyMs < 500, 'clock alignment must be measured and bounded');

  // A minimal real Patrol assertion is derived from the recorded key and
  // written into the fixture project, where E04 executes it unchanged.
  const recordedKey = capture.events.find((event) => event.widget?.key && event.kind === 'action')?.widget?.key;
  assert.ok(recordedKey, 'at least one action must record a widget key');
  const patrolTest = [
    "import 'package:flutter/material.dart';",
    "import 'package:patrol/patrol.dart';",
    '',
    'void main() {',
    "  patrolTest('recorded sign-in key exists', (\$) async {",
    '    await \$(#sign_in_submit).tap();',
    `    expect(find.byKey(const ValueKey<String>('${recordedKey}')), findsOneWidget);`,
    '  });',
    '}',
    '',
  ].join('\n');
  const patrol = await resolveTool({ name: 'patrol', versionArgs: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/ });
  // Written into the fixture project so E04 executes a saved test that came
  // from this evidence. The reviewed copy lives in patrol_test/; this one is a
  // run artifact and is removed afterwards.
  const testPath = path.join(source, 'integration_test', 'f05_derived_test.dart');
  const fs = await import('node:fs/promises');
  await fs.mkdir(path.dirname(testPath), { recursive: true });
  if (!(await fs.readFile(testPath, 'utf8').catch(() => undefined))) await fs.writeFile(testPath, patrolTest);
  process.stdout.write(`PATROL_CLI=${patrol.version ?? 'missing'} ${patrol.path ?? ''}\n`);
  record.patrolTestWritten = testPath;
  assert.ok(!capture.events.some((event) => event.widget?.text === 'SaySpec' || /Record/.test(event.widget?.semanticLabel ?? '')), 'overlay taps must not become evidence');

  // Stop restarts the app process (no rebuild) and the overlay is Ready again
  // for the next test in the same session.
  const stoppedAt = Date.now();
  const next = sessions.active('project_sample');
  assert.ok(next && next.id !== summary.id && next.status === 'preparing', 'stop must prepare the next test in the same session');
  captureId = next.id;
  await waitForLifecycle('waiting-for-user', next.id, 60_000);
  record.restartMs = Date.now() - stoppedAt;
  let readyScreen = false;
  for (let attempt = 0; attempt < 30 && !readyScreen; attempt += 1) {
    const nodes = await dumpNodes(device.id).catch(() => []);
    readyScreen = nodes.some((node) => (node.contentDesc || node.text) === 'Sign in') && nodes.some((node) => node.contentDesc === 'Record');
    if (!readyScreen) await sleep(1_000);
  }
  assert.ok(readyScreen, 'the restarted app must show its first screen and the Ready overlay');

  // Second test, started and stopped from the overlay.
  await tapNode(device.id, (node) => node.contentDesc === 'Record', 'the SaySpec overlay Record button');
  await waitForLifecycle('recording', next.id, 20_000);
  await tapNode(device.id, (node) => (node.contentDesc || node.text) === 'Sign in' && node.clickable === 'true', 'the Sign in button');
  await sleep(1_000);
  await tapNode(device.id, (node) => node.contentDesc === 'Stop recording', 'the SaySpec overlay Stop button');
  await waitForLifecycle('stop-requested', next.id, 20_000);
  const second = await sessions.stop(next.id);
  record.secondTest = { eventCount: second.summary.eventCount, kinds: second.events.map((event) => event.kind), initialRoute: second.events[1]?.route };
  assert.equal(second.events[0]?.kind, 'lifecycle');
  assert.equal(second.events[1]?.kind, 'navigation');
  assert.ok(second.events.some((event) => event.kind === 'action'), 'the second test must record its own action');
  captureId = sessions.active('project_sample')?.id;
  process.stdout.write(`F05_RESULT=${JSON.stringify(record)}\n`);
} finally {
  // The derived test written for this run is an artifact, not a fixture.
  await (await import('node:fs/promises')).rm(path.join(source, 'integration_test', 'f05_derived_test.dart'), { force: true }).catch(() => undefined);
  // A failed assertion must not leave the instrumented app or its capture
  // server running, or the next attempt would join a stale session.
  if (sessions && captureId) await sessions.cancel(captureId).catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
  void instance;
}

// Keeps the import used when a future revision drives the app itself.
void spawn;
