import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FlutterCaptureStore } from '../electron/flutter/capture-store.ts';
import { FlutterCaptureSessionManager } from '../electron/flutter/session-manager.ts';
import { runFile } from '../electron/setup/environment.ts';

/**
 * F05 on an iOS simulator: the session manager and capture server the
 * Electron app uses, on the fixture app launched by UDID.
 *
 * A simulator has no `adb input`, and Simulator.app does not expose the app's
 * own elements to macOS accessibility, so the device is driven with real
 * mouse events and keystrokes on the Simulator window (CoreGraphics and System
 * Events, which need Accessibility permission for the terminal). Positions are device points of
 * the fixture's layout and of the overlay's default placement on a 402×874
 * iPhone 17 screen with a 34 pt bottom inset.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const source = new URL('../../../fixtures/flutter_sample_app', import.meta.url).pathname.replace(/\/$/, '');
const profile = await mkdtemp(path.join(tmpdir(), 'sayspec-f05-ios-'));
const lifecycle = [];
const BUNDLE_ID = 'dev.sayspec.flutterSampleApp';

/** Device points on the fixture's sign-in screen and the overlay's default spot. */
const POINTS = { record: [370, 722], email: [201, 169], password: [201, 238], signIn: [201, 309] };

async function osascript(script) {
  const result = await runFile('/usr/bin/osascript', ['-e', script], { timeoutMs: 20_000 });
  assert.equal(result.code, 0, `osascript failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Clicks a device point: the Simulator's screen group is the device screen in points. */
async function tap([x, y]) {
  await osascript('tell application "Simulator" to activate');
  const [left, top, width, height] = (await osascript('tell application "System Events" to tell process "Simulator" to get {position, size} of group 1 of window 1')).split(/,\s*/).map(Number);
  assert.ok(width > 0 && height > 0, 'the Simulator window must show the device screen');
  // System Events' `click at` presses the Simulator's accessibility element
  // instead of touching the device, so a real mouse event is posted.
  const point = `{x: ${Math.round(left + (x * width) / 402)}, y: ${Math.round(top + (y * height) / 874)}}`;
  const result = await runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('CoreGraphics'); for (const type of [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) { $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, type, ${point}, $.kCGMouseButtonLeft)); delay(0.05); }`], { timeoutMs: 20_000 });
  assert.equal(result.code, 0, `the click could not be posted: ${result.stderr}`);
  await sleep(900);
}

async function type(text) {
  await osascript('tell application "Simulator" to activate');
  await osascript(`tell application "System Events" to keystroke ${JSON.stringify(text)}`);
  await sleep(600);
}

async function waitForLifecycle(state, captureId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lifecycle.some((event) => event.state === state && event.captureId === captureId)) return;
    await sleep(250);
  }
  throw new Error(`no ${state} lifecycle for ${captureId}; saw ${JSON.stringify(lifecycle.map((event) => `${event.state}:${event.captureId}:${event.message}`))}`);
}

let sessions;
let captureId;
try {
  const store = new FlutterCaptureStore(path.join(profile, 'captures'));
  await store.initialize();
  sessions = new FlutterCaptureSessionManager({ store, onLifecycle: (event) => lifecycle.push(event) });
  const requested = process.env.SAYSPEC_F05_SIMULATOR ?? 'iPhone 17';
  const listed = (await sessions.devices()).find((entry) => entry.platform === 'ios' && entry.name === requested);
  assert.ok(listed, `no iOS simulator named ${requested}`);
  const device = await sessions.ensureDevice(listed);
  const udid = device.id.slice('ios:'.length);
  // A clean install, so the session's bundle-id discovery sees only this build.
  await runFile('/usr/bin/xcrun', ['simctl', 'uninstall', udid, BUNDLE_ID], { timeoutMs: 60_000 });

  const launchedAt = Date.now();
  // The Android package name is passed on purpose: it is not installed on the
  // simulator, so the Runner target's bundle id must be discovered instead.
  const summary = await sessions.start({ projectId: 'project_sample', projectName: 'Sample shop', deviceId: device.id, appId: 'dev.sayspec.flutter_sample_app', title: 'F05 iOS session' }, source);
  const launchMs = Date.now() - launchedAt;
  assert.equal(summary.status, 'preparing');
  assert.equal(summary.platform, 'ios');
  captureId = summary.id;

  // `app.started` fires before the first frame; give the sign-in screen time to draw.
  await sleep(4_000);
  await tap(POINTS.record);
  await waitForLifecycle('recording', summary.id, 30_000);
  await tap(POINTS.email);
  await type('fixture@sayspec.local');
  await tap(POINTS.password);
  await type('fixture-password');
  // A host marker travels the polled command channel and comes back as evidence.
  await sessions.mark(summary.id, 'ios-marker');
  await tap(POINTS.signIn);
  await sleep(2_000);
  // Stop on the device overlay, as a tester would.
  await tap(POINTS.record);
  await waitForLifecycle('stop-requested', summary.id, 20_000);
  const capture = await sessions.stop(summary.id);
  assert.equal(capture.summary.status, 'ready', capture.summary.error);
  assert.equal(capture.summary.deviceName, device.name);
  assert.equal(capture.summary.appId, BUNDLE_ID, 'the capture must name the iOS bundle that ran, not the requested Android package');
  const kinds = capture.events.map((event) => event.kind);
  assert.equal(kinds[0], 'lifecycle', `the recording must start with a lifecycle event; kinds ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('marker'), `the host marker must reach the app and come back; kinds ${JSON.stringify(kinds)}`);
  const keys = capture.events.filter((event) => event.kind === 'action').map((event) => event.widget?.key).filter(Boolean);
  assert.ok(keys.includes('sign_in_email') && keys.includes('sign_in_submit'), `taps must carry the fixture's widget keys; saw ${JSON.stringify(keys)}`);
  const typed = capture.events.find((event) => event.kind === 'action' && event.payload?.action === 'enterText' && event.widget?.key === 'sign_in_email');
  assert.equal(typed?.payload?.text, 'fixture@sayspec.local', 'typed text must be recorded as enterText');
  assert.ok(capture.events.some((event) => event.kind === 'navigation' && event.route && event.route !== '/'), 'signing in must record navigation');
  assert.ok(capture.clock.samples > 0 && capture.clock.uncertaintyMs < 500, 'clock alignment over the shared loopback must be measured and bounded');

  // Stop relaunches the installed build with simctl; the restarted process
  // calibrates its clock with the same server, which reports it ready again.
  const stoppedAt = Date.now();
  const next = sessions.active('project_sample');
  assert.ok(next && next.id !== summary.id && next.status === 'preparing', 'stop must prepare the next test in the same session');
  captureId = next.id;
  await waitForLifecycle('restarting', next.id, 10_000);
  await waitForLifecycle('waiting-for-user', next.id, 60_000);
  const restartMs = Date.now() - stoppedAt;
  assert.ok(!lifecycle.some((event) => event.state === 'failed'), `the restart must not fail: ${JSON.stringify(lifecycle.filter((event) => event.state === 'failed'))}`);
  const running = await runFile('/usr/bin/xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], { timeoutMs: 20_000 });
  assert.match(running.stdout, new RegExp(`UIKitApplication:${BUNDLE_ID.replaceAll('.', '\\.')}`), 'the relaunched app must be running');

  // The relaunched app starts fresh on the sign-in screen with the overlay Ready.
  await sleep(3_000);
  await tap(POINTS.record);
  await waitForLifecycle('recording', next.id, 30_000);
  await tap(POINTS.signIn);
  await sleep(1_000);
  await tap(POINTS.record);
  await waitForLifecycle('stop-requested', next.id, 20_000);
  const second = await sessions.stop(next.id);
  assert.equal(second.summary.status, 'ready', second.summary.error);
  assert.equal(second.events[0]?.kind, 'lifecycle');
  assert.ok(second.events.some((event) => event.kind === 'action' && event.widget?.key === 'sign_in_submit'), 'the second test must record its own tap');
  captureId = sessions.active('project_sample')?.id;

  process.stdout.write(`F05_IOS_RESULT=${JSON.stringify({
    device: `${device.name} · ${device.runtime} (${device.id})`,
    appId: capture.summary.appId,
    launchMs, restartMs,
    first: { status: capture.summary.status, eventCount: capture.summary.eventCount, kinds, keys, routes: [...new Set(capture.events.map((event) => event.route).filter(Boolean))], screenshots: capture.artifacts.length, clockUncertaintyMs: capture.clock.uncertaintyMs, clockSamples: capture.clock.samples },
    second: { status: second.summary.status, eventCount: second.summary.eventCount, kinds: second.events.map((event) => event.kind) },
    lifecycle: lifecycle.map((event) => `${event.state}: ${event.message}`),
  })}\n`);
} catch (error) {
  process.stderr.write(`F05_IOS_LIFECYCLE=${JSON.stringify(lifecycle.map((event) => `${event.state}:${event.captureId}:${event.message}`))}\n`);
  if (sessions && captureId) process.stderr.write(`F05_IOS_FLUTTER_LOG=${JSON.stringify(sessions.getLog(captureId).slice(-3_000))}\n`);
  throw error;
} finally {
  if (sessions && captureId) await sessions.cancel(captureId).catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
}
