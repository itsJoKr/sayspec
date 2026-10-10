import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecordingStore } from './recording-store.ts';
import { LocalTranscriptionManager } from './transcription/local-transcription.ts';
import { LocalModelManager } from './transcription/model-manager.ts';
import { DEFAULT_WHISPER_MODEL } from './transcription/model-manifest.ts';

const modelFixture = process.env.SAYSPEC_REAL_WHISPER_MODEL;
const englishFixture = process.env.SAYSPEC_REAL_WHISPER_ENGLISH;
const croatianFixture = process.env.SAYSPEC_REAL_WHISPER_CROATIAN;
const silenceFixture = process.env.SAYSPEC_REAL_WHISPER_SILENCE;
if (!modelFixture || !englishFixture || !croatianFixture || !silenceFixture) throw new Error('Set the SAYSPEC_REAL_WHISPER_MODEL, SAYSPEC_REAL_WHISPER_ENGLISH, SAYSPEC_REAL_WHISPER_CROATIAN, and SAYSPEC_REAL_WHISPER_SILENCE fixture paths.');

test('real whisper.cpp transcribes saved pause/resume narration locally and reopens faithful text with aligned timestamps', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-real-transcription-')); let now = 1_000;
  try {
    const modelRoot = path.join(root, 'models'); await mkdir(modelRoot, { recursive: true });
    await link(modelFixture, path.join(modelRoot, DEFAULT_WHISPER_MODEL.fileName));
    const models = new LocalModelManager({ rootDirectory: modelRoot }); await models.initialize();
    assert.equal((await models.snapshot()).model.state, 'installed'); assert.equal((await models.snapshot()).runtime.state, 'ready');
    const recordingsRoot = path.join(root, 'recordings'); const store = new RecordingStore(recordingsRoot, { clock: { now: () => now }, minimumFreeBytes: 0 }); await store.initialize();
    const prepared = await store.create({ projectId: 'project_web', projectName: 'Real transcript', startUrl: 'https://example.test/', sharingChoice: 'local-only' });
    const first = await store.beginSegment(prepared.recording.id); await store.appendAudio({ recordingId: prepared.recording.id, segmentId: first.activeSegmentId!, mimeType: 'audio/wav', bytes: await readFile(englishFixture) });
    now = 7_000; await store.addEvent(prepared.recording.id, { action: 'click', context: 'page', targetDescription: 'Annual plan' }); now = 13_000; await store.pause(prepared.recording.id);
    now = 15_000; const second = await store.beginSegment(prepared.recording.id); await store.appendAudio({ recordingId: prepared.recording.id, segmentId: second.activeSegmentId!, mimeType: 'audio/wav', bytes: await readFile(croatianFixture) });
    now = 18_000; await store.addEvent(prepared.recording.id, { action: 'observation', context: 'page', targetDescription: 'Order count' }); now = 22_000; const review = await store.stop(prepared.recording.id);
    const transcription = new LocalTranscriptionManager({ rootDirectory: path.join(root, 'work'), store, models }); await transcription.initialize();
    const transcript = await transcription.start(review.id); assert.equal(transcript.status, 'ready'); assert.equal(transcript.provider.kind, 'local'); assert.equal(transcript.provider.runtimeVersion, '1.9.4');
    const text = transcript.segments.map((segment) => segment.text).join(' ');
    assert.match(text, /No, correction/i); assert.match(text, /Do not submit the form/i); assert.match(text, /nemoj poslati obrazac/i);
    assert.ok(transcript.segments.some((segment) => segment.recordingSegmentId === 'segment_2' && segment.startMs >= review.manifest.segments[1].startMs));
    assert.ok(transcript.segments.every((segment) => segment.timingUncertaintyMs >= 100)); assert.ok(transcript.segments.some((segment) => segment.evidenceEventIds.length));
    const silentPrepared = await store.create({ projectId: 'project_web', projectName: 'Silence', startUrl: 'https://example.test/', sharingChoice: 'local-only' });
    const silentSegment = await store.beginSegment(silentPrepared.recording.id); await store.appendAudio({ recordingId: silentPrepared.recording.id, segmentId: silentSegment.activeSegmentId!, mimeType: 'audio/wav', bytes: await readFile(silenceFixture) }); now = 26_000; const silentReview = await store.stop(silentPrepared.recording.id);
    const silentTranscript = await transcription.start(silentReview.id); assert.equal(silentTranscript.status, 'ready'); assert.equal(silentTranscript.segments.length, 0); assert.match(silentTranscript.warnings.join(' '), /No speech/i);
    const reopened = new RecordingStore(recordingsRoot, { minimumFreeBytes: 0 }); await reopened.initialize(); const restored = await reopened.get('project_web', review.id);
    assert.equal(restored.transcript?.status, 'ready'); assert.match(restored.transcript?.segments.map((segment) => segment.text).join(' ') ?? '', /No, correction/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
