import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FlutterCaptureStore } from '../electron/flutter/capture-store.ts';
import { LocalModelManager } from '../electron/transcription/model-manager.ts';
import { LocalTranscriptionManager } from '../electron/transcription/local-transcription.ts';
import { RecordingStore } from '../electron/recording-store.ts';

const run = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'sayspec-flutter-narration-'));
const installedModelRoot = path.join(process.env.HOME, 'Library', 'Application Support', '@sayspec', 'desktop', 'transcription-models');
try {
  const capturesRoot = path.join(root, 'captures');
  const store = new FlutterCaptureStore(capturesRoot); await store.initialize();
  const draft = await store.create({ organizationId: 'local', projectId: 'project_sample', title: 'Narrated receipt expectation', deviceId: 'emulator-5554', deviceName: 'Slim_1', platform: 'android', appId: 'dev.sayspec.flutter_sample_app', recorderSdkVersion: '0.9.0', recorderSchemaVersion: 1 });
  await store.appendBatch(draft, {
    envelope: { schemaVersion: 1, clock: { offsetMs: 10_000, roundTripMs: 10, samples: 3, uncertaintyMs: 5 }, sdk: { version: '0.9.0' } },
    events: [{ id: 'event_receipt_total', seq: 1, kind: 'action', monotonicMs: 1_800, route: '/receipt', widget: { widgetType: 'Text', key: 'receipt_total', candidates: [{ kind: 'key', value: 'receipt_total', confidence: 'high' }] }, payload: { action: 'tap' } }],
  });
  const audioFile = path.join(root, 'expectation.aiff');
  await run('/usr/bin/say', ['-o', audioFile, 'When I place the order, the receipt total should be twelve dollars.']);
  const audio = await readFile(audioFile);
  const probe = await run('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioFile]);
  const durationMs = Math.max(1, Math.round(Number(probe.stdout.trim()) * 1_000));
  await store.beginNarration(draft, 'audio/aiff', 10_000);
  await store.appendNarration(draft, 'audio/aiff', audio);
  const narration = await store.finishNarration(draft, 10_000 + durationMs);
  await store.setStatus(draft, 'ready');

  const modelRoot = path.join(root, 'models'); await mkdir(modelRoot, { recursive: true });
  await link(path.join(installedModelRoot, 'ggml-small-q5_1.bin'), path.join(modelRoot, 'ggml-small-q5_1.bin'));
  await writeFile(path.join(modelRoot, 'state.json'), JSON.stringify({ schemaVersion: 1, state: 'installed', downloadedBytes: 190085487 }));
  const models = new LocalModelManager({ rootDirectory: modelRoot, runtimeCandidates: ['/opt/homebrew/bin/whisper-cli'], converterCandidates: ['/opt/homebrew/bin/ffmpeg'], minimumFreeBytes: 0 }); await models.initialize();
  const webStore = new RecordingStore(path.join(root, 'unused-web-recordings')); await webStore.initialize();
  const transcription = new LocalTranscriptionManager({ rootDirectory: path.join(root, 'transcription-work'), store: webStore, models }); await transcription.initialize();
  const events = draft.events.map((event) => ({ id: event.id, elapsedMs: Math.max(0, event.hostAlignedMs - narration.startedAtHostMonotonicMs) }));
  const transcript = await transcription.startFlutter({ captureId: draft.id, audioPath: audioFile, durationMs, timingUncertaintyMs: draft.clock.uncertaintyMs, events, persist: (value) => store.writeTranscript(draft.id, value) });
  assert.equal(transcript.status, 'ready');
  assert.ok(transcript.segments.length > 0, `expected speech, got ${JSON.stringify(transcript.warnings)}`);
  assert.match(transcript.segments.map((item) => item.text).join(' '), /receipt total should be (?:twelve dollars|\$12)/i);
  assert.ok(transcript.segments.some((item) => item.evidenceEventIds.includes('event_receipt_total')));

  const reopenedStore = new FlutterCaptureStore(capturesRoot); await reopenedStore.initialize();
  const reopened = await reopenedStore.get('project_sample', draft.id);
  assert.equal(reopened.narration?.captureId, draft.id);
  assert.equal(reopened.narration?.sha256, narration.sha256);
  assert.deepEqual((await reopenedStore.readNarration(draft.id)).bytes, audio);
  assert.equal(reopened.transcript?.status, 'ready');
  process.stdout.write(`M10_NARRATION_RESULT=${JSON.stringify({ captureId: draft.id, audioBytes: narration.byteLength, audioSha256: narration.sha256, durationMs: narration.durationMs, clockUncertaintyMs: draft.clock.uncertaintyMs, transcript: transcript.segments.map((item) => ({ text: item.text, evidenceEventIds: item.evidenceEventIds })), restartVerified: true })}\n`);
} finally { await rm(root, { recursive: true, force: true }); }
