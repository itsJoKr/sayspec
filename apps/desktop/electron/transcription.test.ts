import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalModelManager } from './transcription/model-manager.ts';
import type { WhisperModelManifest } from './transcription/model-manifest.ts';
import { LocalTranscriptionManager, normalizeWhisperSegments, normalizeWhisperTimeline } from './transcription/local-transcription.ts';
import { RecordingStore } from './recording-store.ts';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-model-'));
  const runtime = path.join(root, 'whisper-cli'); const converter = path.join(root, 'ffmpeg');
  await writeFile(runtime, '#!/bin/sh\necho "whisper.cpp version: 1.9.4"\n');
  await writeFile(converter, '#!/bin/sh\necho "ffmpeg version fixture"\n');
  await Promise.all([chmod(runtime, 0o700), chmod(converter, 0o700)]);
  const bytes = Buffer.from('verified local whisper model fixture');
  const manifest: WhisperModelManifest = {
    id: 'fixture-model', displayName: 'Fixture model', family: 'whisper', variant: 'small', quantization: 'q5_1',
    multilingual: true, supportedLanguages: 'multilingual', byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), license: 'fixture', sourceUrl: 'https://fixture.invalid/model.bin', fileName: 'model.bin',
  };
  return { root, runtime, converter, bytes, manifest };
}

function response(bytes: Uint8Array) { const copy = new Uint8Array(bytes.byteLength); copy.set(bytes); return new Response(copy.buffer, { status: 200, headers: { 'content-length': String(bytes.byteLength) } }); }

test('model download is size/hash verified, corrupt installs are removed, and reinstall/remove are atomic', async () => {
  const value = await fixture();
  try {
    const manager = new LocalModelManager({ rootDirectory: value.root, manifest: value.manifest, runtimeCandidates: [value.runtime], converterCandidates: [value.converter], fetchImpl: (async () => response(value.bytes)) as typeof fetch, minimumFreeBytes: 0 });
    await manager.initialize();
    assert.equal((await manager.snapshot()).runtime.state, 'ready');
    assert.equal((await manager.install('fixture-model')).model.state, 'installed');
    assert.deepEqual(await readFile(manager.modelPath), value.bytes);
    await writeFile(manager.modelPath, 'corrupt');
    const reopened = new LocalModelManager({ rootDirectory: value.root, manifest: value.manifest, runtimeCandidates: [value.runtime], converterCandidates: [value.converter], fetchImpl: (async () => response(value.bytes)) as typeof fetch, minimumFreeBytes: 0 });
    await reopened.initialize();
    assert.equal((await reopened.snapshot()).model.state, 'failed');
    await assert.rejects(access(reopened.modelPath));
    assert.equal((await reopened.install('fixture-model')).model.state, 'installed');
    assert.equal((await reopened.remove('fixture-model')).model.state, 'not-installed');
    await assert.rejects(access(reopened.modelPath));
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('canceled and interrupted downloads never become installed and can be retried', async () => {
  const value = await fixture(); let release!: () => void;
  try {
    const slowFetch = (async () => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({ async pull(controller) {
        if (!sent) { controller.enqueue(value.bytes.subarray(0, 4)); sent = true; await new Promise<void>((resolve) => { release = resolve; }); }
        controller.enqueue(value.bytes.subarray(4)); controller.close();
      } });
      return new Response(body, { headers: { 'content-length': String(value.bytes.length) } });
    }) as typeof fetch;
    const manager = new LocalModelManager({ rootDirectory: value.root, manifest: value.manifest, runtimeCandidates: [value.runtime], converterCandidates: [value.converter], fetchImpl: slowFetch, minimumFreeBytes: 0 });
    await manager.initialize(); const installing = manager.install('fixture-model');
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    const canceled = manager.cancelInstall(); release(); await installing; assert.equal((await canceled).model.state, 'not-installed');
    await assert.rejects(access(manager.modelPath));
    const partial = `${manager.modelPath}.partial`; await writeFile(partial, 'partial');
    await writeFile(path.join(value.root, 'state.json'), JSON.stringify({ schemaVersion: 1, state: 'downloading', downloadedBytes: 7 }));
    const reopened = new LocalModelManager({ rootDirectory: value.root, manifest: value.manifest, runtimeCandidates: [value.runtime], converterCandidates: [value.converter], fetchImpl: (async () => response(value.bytes)) as typeof fetch, minimumFreeBytes: 0 });
    await reopened.initialize(); assert.equal((await reopened.snapshot()).model.state, 'not-installed'); await assert.rejects(access(partial));
    assert.equal((await reopened.install('fixture-model')).model.state, 'installed');
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('network, low-disk, and architecture failures remain explicit', async () => {
  const value = await fixture();
  try {
    const network = new LocalModelManager({ rootDirectory: value.root, manifest: value.manifest, runtimeCandidates: [value.runtime], converterCandidates: [value.converter], fetchImpl: (async () => { throw new Error('fixture network interruption'); }) as typeof fetch, minimumFreeBytes: 0 });
    await network.initialize(); await assert.rejects(network.install('fixture-model'), /network interruption/); assert.equal((await network.snapshot()).model.state, 'failed');
    const lowDisk = new LocalModelManager({ rootDirectory: path.join(value.root, 'low'), manifest: value.manifest, runtimeCandidates: [value.runtime], converterCandidates: [value.converter], fetchImpl: (async () => response(value.bytes)) as typeof fetch, availableFreeBytes: async () => 0, minimumFreeBytes: 1 });
    await lowDisk.initialize(); await assert.rejects(lowDisk.install('fixture-model'), /free bytes/);
    const unsupported = new LocalModelManager({ rootDirectory: path.join(value.root, 'arch'), manifest: value.manifest, platform: 'darwin', architecture: 'riscv64', runtimeCandidates: [value.runtime], converterCandidates: [value.converter], minimumFreeBytes: 0 });
    await unsupported.initialize(); assert.equal((await unsupported.snapshot()).runtime.state, 'unsupported');
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('Whisper timestamps map onto paused recording segments without summarizing corrections or negation', () => {
  const recordingSegment = { id: 'segment_2', startMs: 5_000, endMs: 8_000, pausedAfter: false };
  const events = [{ id: 'event_2', segmentId: 'segment_2', elapsedMs: 6_100, context: 'page', action: 'click' as const, targetDescription: 'Monthly plan', evidenceArtifactIds: [] }];
  const result = normalizeWhisperSegments({ result: { language: 'en' }, transcription: [
    { offsets: { from: 0, to: 1_200 }, text: ' No, correction.' },
    { offsets: { from: 1_200, to: 2_900 }, text: ' Do not submit the form.' },
  ] }, recordingSegment, events);
  assert.equal(result.language, 'en');
  assert.deepEqual(result.segments.map((item) => [item.startMs, item.endMs, item.text]), [[5_000, 6_200, 'No, correction.'], [6_200, 7_900, 'Do not submit the form.']]);
  assert.deepEqual(result.segments[0].evidenceEventIds, ['event_2']);
  assert.equal(result.segments[0].timingUncertaintyMs, 100, 'tail silence is not clock uncertainty');
  assert.equal(normalizeWhisperSegments({ transcription: [{ offsets: { from: 0, to: 3_000 }, text: '[BLANK_AUDIO]' }] }, recordingSegment, []).segments.length, 0);
});

test('Flutter narration timing links spoken expectations to host-aligned evidence without synthesis', () => {
  const result = normalizeWhisperTimeline({ result: { language: 'en' }, transcription: [
    { offsets: { from: 250, to: 1_500 }, text: ' The receipt total should be twelve dollars.' },
  ] }, { id: 'narration_1', startMs: 0, endMs: 2_500, pausedAfter: false, audioArtifactId: 'narration_audio' }, [
    { id: 'event_cart', elapsedMs: 200 }, { id: 'event_receipt', elapsedMs: 1_400 },
  ]);
  assert.equal(result.segments[0]?.text, 'The receipt total should be twelve dollars.');
  assert.deepEqual(result.segments[0]?.evidenceEventIds, ['event_receipt']);
  assert.equal(normalizeWhisperTimeline({ transcription: [{ offsets: { from: 0, to: 1_000 }, text: '[silence]' }] }, { id: 'narration_1', startMs: 0, endMs: 2_500, pausedAfter: false }, []).segments.length, 0);
});

test('Metal allocation failure retries on CPU without changing the local provider', async () => {
  const value = await fixture(); let now = 1_000;
  try {
    await writeFile(value.runtime, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "whisper.cpp version: 1.9.4"; exit 0; fi
cpu=0
previous=""
output=""
for argument in "$@"; do
  if [ "$previous" = "--output-file" ]; then output="$argument"; fi
  if [ "$argument" = "--no-gpu" ]; then cpu=1; fi
  previous="$argument"
done
if [ "$cpu" = "0" ]; then echo "src/ggml-backend.cpp:205: GGML_ASSERT(buffer) failed" >&2; exit 134; fi
printf '%s' '{"result":{"language":"en"},"transcription":[{"offsets":{"from":0,"to":900},"text":" Do not submit."}]}' > "\${output}.json"
`);
    await writeFile(value.converter, '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffmpeg version fixture"; exit 0; fi\nlast=""\nfor argument in "$@"; do last="$argument"; done\nif [ "$last" != "-" ]; then : > "$last"; fi\n');
    await Promise.all([chmod(value.runtime, 0o700), chmod(value.converter, 0o700)]);
    const models = new LocalModelManager({ rootDirectory: path.join(value.root, 'models'), manifest: value.manifest, runtimeCandidates: [value.runtime], converterCandidates: [value.converter], fetchImpl: (async () => response(value.bytes)) as typeof fetch, minimumFreeBytes: 0 });
    await models.initialize(); await models.install(value.manifest.id);
    const store = new RecordingStore(path.join(value.root, 'recordings'), { clock: { now: () => now }, minimumFreeBytes: 0 }); await store.initialize();
    const prepared = await store.create({ projectId: 'project_web', projectName: 'CPU fallback', startUrl: 'https://example.test/', sharingChoice: 'local-only' });
    const active = await store.beginSegment(prepared.recording.id); await store.appendAudio({ recordingId: prepared.recording.id, segmentId: active.activeSegmentId!, mimeType: 'audio/wav', bytes: new Uint8Array([82, 73, 70, 70]) });
    now = 2_000; const review = await store.stop(prepared.recording.id);
    const manager = new LocalTranscriptionManager({ rootDirectory: path.join(value.root, 'work'), store, models }); await manager.initialize();
    const transcript = await manager.start(review.id);
    assert.equal(transcript.status, 'ready'); assert.equal(transcript.provider.kind, 'local'); assert.equal(transcript.segments[0].text, 'Do not submit.');
    assert.match(transcript.warnings.join(' '), /retried on CPU.*No provider or data destination changed/i);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('local inference failure and cancellation preserve original audio and never switch providers', async () => {
  const value = await fixture(); let now = 1_000;
  try {
    await writeFile(value.runtime, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "whisper.cpp version: 1.9.4"; exit 0; fi\necho "fixture inference crash" >&2\nexit 17\n');
    await writeFile(value.converter, '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffmpeg version fixture"; exit 0; fi\nlast=""\nfor argument in "$@"; do last="$argument"; done\nif [ "$last" != "-" ]; then : > "$last"; fi\n');
    await Promise.all([chmod(value.runtime, 0o700), chmod(value.converter, 0o700)]);
    const modelRoot = path.join(value.root, 'models');
    const models = new LocalModelManager({ rootDirectory: modelRoot, manifest: value.manifest, runtimeCandidates: [value.runtime], converterCandidates: [value.converter], fetchImpl: (async () => response(value.bytes)) as typeof fetch, minimumFreeBytes: 0 });
    await models.initialize(); await models.install(value.manifest.id);
    const store = new RecordingStore(path.join(value.root, 'recordings'), { clock: { now: () => now }, minimumFreeBytes: 0 }); await store.initialize();
    const prepared = await store.create({ projectId: 'project_web', projectName: 'Inference failure', startUrl: 'https://example.test/', sharingChoice: 'local-only' });
    const active = await store.beginSegment(prepared.recording.id); const originalAudio = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
    await store.appendAudio({ recordingId: prepared.recording.id, segmentId: active.activeSegmentId!, mimeType: 'audio/wav', bytes: originalAudio }); now = 2_000; const review = await store.stop(prepared.recording.id);
    const manager = new LocalTranscriptionManager({ rootDirectory: path.join(value.root, 'work'), store, models }); await manager.initialize();
    const failed = await manager.start(review.id); assert.equal(failed.status, 'failed'); assert.match(failed.error ?? '', /original audio is unchanged/i);
    assert.deepEqual((await store.readAsset(review.id, review.manifest.segments[0].audioArtifactId!)).bytes, originalAudio);
    await writeFile(value.runtime, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "whisper.cpp version: 1.9.4"; exit 0; fi\nexec sleep 30\n'); await chmod(value.runtime, 0o700);
    const running = manager.start(review.id); await new Promise((resolve) => setTimeout(resolve, 80)); const canceled = await manager.cancel(review.id); await running;
    assert.equal(canceled.status, 'canceled'); assert.match(canceled.error ?? '', /original audio is unchanged/i);
    assert.equal(canceled.provider.kind, 'local');
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
