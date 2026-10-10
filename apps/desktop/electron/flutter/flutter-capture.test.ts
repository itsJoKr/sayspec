import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FlutterCaptureServer } from './capture-server.ts';
import { deriveAssertions, FlutterCaptureStore } from './capture-store.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function profile() {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-flutter-test-'));
  const store = new FlutterCaptureStore(path.join(root, 'captures'));
  await store.initialize();
  return { root, store };
}

test('capture server accepts an authenticated batch and returns queued commands', async () => {
  const received: Record<string, unknown>[] = [];
  const server = new FlutterCaptureServer({ onEvents: (input: { events: Record<string, unknown>[] }) => { received.push(...input.events); } });
  const { port, token } = await server.start({ captureId: 'flutter_capture_fixture' });
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauthorized.status, 401);

    const wrongSession = await fetch(`http://127.0.0.1:${port}/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: 'other', events: [] }),
    });
    assert.equal(wrongSession.status, 409);

    server.enqueue({ command: 'pause' });
    const response = await fetch(`http://127.0.0.1:${port}/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: 'flutter_capture_fixture', envelope: { schemaVersion: 1 }, events: [{ id: 'e1', kind: 'action', monotonicMs: 10 }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { accepted: number; commands: { command: string }[] };
    assert.equal(body.accepted, 1);
    assert.deepEqual(body.commands.map((item) => item.command), ['pause']);
    assert.equal(received.length, 1);

    const clock = await fetch(`http://127.0.0.1:${port}/clock`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sentMonotonicMs: 5 }),
    });
    assert.equal(clock.status, 200);
    const clockBody = await clock.json() as { hostMonotonicMs: number };
    assert.ok(clockBody.hostMonotonicMs > 0);
  } finally { await server.stop(); }
});

test('stored capture keeps host-aligned timing, screenshots and finder suggestions', async () => {
  const { root, store } = await profile();
  try {
    const draft = await store.create({ projectId: 'project_sample', title: 'Cart flow', deviceId: 'emulator-5554', deviceName: 'Slim_1', platform: 'android', appId: 'dev.sayspec.flutter_sample_app', recorderSdkVersion: '0.9.0', recorderSchemaVersion: 1 });
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    await store.appendBatch(draft, {
      envelope: { schemaVersion: 1, clock: { offsetMs: 500, roundTripMs: 8, samples: 3, uncertaintyMs: 4 }, device: { platform: 'android' }, sdk: { version: '0.9.0', schemaVersion: 1 } },
      events: [{
        id: 'event_1', seq: 1, kind: 'action', monotonicMs: 1_000, route: '/cart',
        widget: { widgetType: 'FilledButton', key: 'cart_place_order', keyKind: 'value', text: 'Place order', ancestors: ['CartPage'], candidates: [{ kind: 'key', value: 'cart_place_order', confidence: 'high' }] },
        payload: { action: 'tap' }, screenshot: png.toString('base64'),
      }],
    });
    await store.setStatus(draft, 'ready');
    const capture = await store.get('project_sample', draft.id);
    assert.equal(capture.summary.status, 'ready');
    assert.equal(capture.clock.offsetMs, 500);
    assert.equal(capture.events[0]?.hostAlignedMs, 1_500);
    assert.equal(capture.events[0]?.screenshotArtifactId !== undefined, true);
    assert.equal(capture.artifacts.length, 1);
    const asset = await store.readArtifact(draft.id, capture.artifacts[0]!.id);
    assert.equal(createHash('sha256').update(asset.bytes).digest('hex'), capture.artifacts[0]!.sha256);
    assert.match(capture.assertions[0]!.suggestion, /find\.byKey\(const ValueKey<String>\('cart_place_order'\)\)/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an incompatible recorder schema is refused before any event is stored', async () => {
  const { root, store } = await profile();
  try {
    const draft = await store.create({ projectId: 'project_sample', title: 'Cart flow', deviceId: 'd', deviceName: 'd', platform: 'android', appId: 'app', recorderSdkVersion: 'unknown', recorderSchemaVersion: 2 });
    await assert.rejects(() => store.appendBatch(draft, { envelope: { schemaVersion: 2 }, events: [] }), /schema 2/);
    assert.equal(draft.events.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uncalibrated or missing widget evidence is recorded as a completeness warning', async () => {
  const { root, store } = await profile();
  try {
    const draft = await store.create({ projectId: 'project_sample', title: 'Cart flow', deviceId: 'd', deviceName: 'd', platform: 'android', appId: 'app', recorderSdkVersion: 'unknown', recorderSchemaVersion: 1 });
    await store.appendBatch(draft, { envelope: { schemaVersion: 1, clock: { offsetMs: 0, roundTripMs: 0, samples: 0, uncertaintyMs: 0 } }, events: [{ id: 'event_1', kind: 'action', monotonicMs: 10, payload: { action: 'tap' } }] });
    assert.ok(draft.completenessWarnings.some((warning) => /Clock calibration/.test(warning)));
    assert.ok(draft.completenessWarnings.some((warning) => /no widget identity/.test(warning)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('assertion suggestions never claim a recorded literal is the intent', () => {
  const suggestions = deriveAssertions([
    { id: 'event_1', seq: 1, kind: 'action', monotonicMs: 0, hostAlignedMs: 0, payload: {}, widget: { widgetType: 'Text', text: 'Coffee beans', ancestors: [], candidates: [{ kind: 'text', value: 'Coffee beans', confidence: 'medium' }] } },
    { id: 'event_2', seq: 2, kind: 'action', monotonicMs: 0, hostAlignedMs: 0, payload: {}, widget: { widgetType: 'CustomPaint', ancestors: [], candidates: [] } },
  ]);
  assert.match(suggestions[0]!.suggestion, /find\.text/);
  assert.match(suggestions[0]!.rationale, /narration must confirm/);
  assert.equal(suggestions[1]!.confidence, 'low');
});

test('capture artifacts are written to disk so a reopened review shows them', async () => {
  const { root, store } = await profile();
  try {
    const draft = await store.create({ projectId: 'project_sample', title: 'Cart flow', deviceId: 'd', deviceName: 'd', platform: 'android', appId: 'app', recorderSdkVersion: 'unknown', recorderSchemaVersion: 1 });
    await store.appendBatch(draft, { events: [{ id: 'event_1', kind: 'action', monotonicMs: 5, payload: {}, screenshot: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') }] });
    await store.flushWrites();
    const capture = await store.get('project_sample', draft.id);
    const absolute = path.join(root, 'captures', draft.id, capture.artifacts[0]!.relativePath);
    assert.equal(sha(await (await import('node:fs/promises')).readFile(absolute).then((bytes) => bytes.toString('hex'))).length, 64);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capture-owned narration and transcript survive restart with verified identity and timing', async () => {
  const { root, store } = await profile();
  try {
    const draft = await store.create({ organizationId: 'org_sample', projectId: 'project_sample', title: 'Narrated cart', deviceId: 'd', deviceName: 'd', platform: 'android', appId: 'app', recorderSdkVersion: '0.9.0', recorderSchemaVersion: 1 });
    await store.beginNarration(draft, 'audio/webm', 10_000);
    const audio = new Uint8Array([26, 69, 223, 163, 1, 2, 3, 4]);
    await store.appendNarration(draft, 'audio/webm', audio);
    const narration = await store.finishNarration(draft, 12_500);
    assert.equal(narration.captureId, draft.id);
    assert.equal(narration.durationMs, 2_500);
    assert.equal(narration.sha256, createHash('sha256').update(audio).digest('hex'));
    await store.setStatus(draft, 'ready');
    await store.writeTranscript(draft.id, {
      schemaVersion: 1, recordingId: draft.id, status: 'ready',
      provider: { kind: 'local', runtime: 'whisper.cpp', runtimeVersion: 'fixture', modelId: 'fixture', modelSha256: 'a'.repeat(64), translated: false },
      segments: [{ id: 'transcript_segment_1', recordingSegmentId: 'narration_1', startMs: 100, endMs: 2_000, timingUncertaintyMs: 5, originalText: 'The cart total should be twelve dollars.', text: 'The cart total should be twelve dollars.', revisions: [], evidenceEventIds: [] }],
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), warnings: [],
    });
    const reopenedStore = new FlutterCaptureStore(path.join(root, 'captures')); await reopenedStore.initialize();
    const reopened = await reopenedStore.get('project_sample', draft.id);
    assert.equal(reopened.summary.organizationId, 'org_sample');
    assert.equal(reopened.narration?.sha256, narration.sha256);
    assert.equal(reopened.transcript?.segments[0]?.text, 'The cart total should be twelve dollars.');
    assert.deepEqual((await reopenedStore.readNarration(draft.id)).bytes, Buffer.from(audio));
    await assert.rejects(() => reopenedStore.writeTranscript('flutter_capture_00000000-0000-0000-0000-000000000000', { ...reopened.transcript!, recordingId: draft.id }), /does not belong/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capture store groups recordings by session and keeps a legacy recording as its own session', async () => {
  const { root, store } = await profile();
  try {
    const base = { projectId: 'project_one', deviceId: 'emulator-5554', deviceName: 'Slim', platform: 'android' as const, appId: 'dev.sayspec.fixture', recorderSdkVersion: '0.9.0', recorderSchemaVersion: 1 };
    const legacy = await store.create({ ...base, title: 'Old recording' });
    const first = await store.create({ ...base, sessionId: 'flutter_session_one', sessionTitle: 'Checkout', title: 'Recording 1' });
    const second = await store.create({ ...base, sessionId: 'flutter_session_one', sessionTitle: 'Checkout', title: 'Recording 2' });
    for (const draft of [legacy, first, second]) await store.setStatus(draft, 'ready');
    assert.deepEqual(store.listSession('project_one', 'flutter_session_one').map((item) => item.title), ['Recording 1', 'Recording 2']);
    assert.equal(store.listSession('project_one', 'flutter_session_one')[0]?.sessionTitle, 'Checkout');
    assert.deepEqual(store.listSession('project_one', legacy.id).map((item) => item.id), [legacy.id]);
    assert.deepEqual(store.listSession('project_two', 'flutter_session_one'), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a flavored launch restarts the package its flavor installs', async () => {
  const { gradleApplicationIdSuffixes } = await import('./session-manager.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-flutter-flavor-'));
  try {
    await mkdir(path.join(root, 'android', 'app'), { recursive: true });
    await writeFile(path.join(root, 'android', 'app', 'build.gradle.kts'), `android {
  defaultConfig { applicationId = "com.example.shop" }
  productFlavors {
    create("dev") { dimension = "env"; applicationIdSuffix = ".dev" }
    create("staging") { dimension = "env"; applicationIdSuffix = ".stg" }
    create("prod") { dimension = "env" }
  }
}`);
    assert.deepEqual(await gradleApplicationIdSuffixes(root, 'staging'), ['.stg']);
    assert.deepEqual(await gradleApplicationIdSuffixes(root, 'prod'), []);
    assert.deepEqual(await gradleApplicationIdSuffixes(root), ['.dev', '.stg']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
