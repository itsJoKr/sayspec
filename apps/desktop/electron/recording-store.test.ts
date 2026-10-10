import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RecordingStore } from './recording-store.ts';

test('recording evidence survives pause, resume, finalization, and a fresh store instance', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-recordings-'));
  let now = 1_000;
  try {
    const store = new RecordingStore(root, { clock: { now: () => now }, minimumFreeBytes: 0 }); await store.initialize();
    const prepared = await store.create({ projectId: 'project_web', projectName: 'Storefront', startUrl: 'https://example.test/?token=do-not-store', sharingChoice: 'local-only' });
    const first = await store.beginSegment(prepared.recording.id);
    await store.appendAudio({ recordingId: prepared.recording.id, segmentId: first.activeSegmentId!, mimeType: 'audio/webm;codecs=opus', bytes: new Uint8Array([1, 2, 3]) });
    now = 1_800;
    await store.addEvent(prepared.recording.id, { action: 'click', context: 'page_1', targetDescription: 'button · Checkout', pageId: 'page_1', frameUrl: 'https://example.test/', locatorCandidates: ['#checkout'], screenshot: new Uint8Array([4, 5, 6]) });
    await store.pause(prepared.recording.id);
    now = 2_400;
    const second = await store.beginSegment(prepared.recording.id);
    await store.appendAudio({ recordingId: prepared.recording.id, segmentId: second.activeSegmentId!, mimeType: 'audio/webm;codecs=opus', bytes: new Uint8Array([7, 8]) });
    now = 3_000;
    const review = await store.stop(prepared.recording.id);

    assert.equal(review.status, 'ready');
    assert.equal(review.startUrl, 'https://example.test/?token=%3Credacted%3E');
    assert.equal(review.manifest.segments.length, 2);
    assert.equal(review.manifest.events[0].elapsedMs, 800);
    assert.equal(review.manifest.artifacts.filter((item) => item.mimeType.startsWith('audio/')).length, 2);
    assert.ok(!await readFile(path.join(root, prepared.recording.id, 'draft.json'), 'utf8').then((text) => text.includes('do-not-store')));

    const reopened = new RecordingStore(root, { minimumFreeBytes: 0 }); await reopened.initialize();
    const restored = await reopened.get('project_web', prepared.recording.id);
    assert.equal(restored.startUrl, 'https://example.test/?token=%3Credacted%3E');
    assert.equal(restored.manifest.events[0].targetDescription, 'button · Checkout');
    const audio = await reopened.readAsset(prepared.recording.id, restored.manifest.segments[0].audioArtifactId!);
    assert.deepEqual([...audio.bytes], [1, 2, 3]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('startup recovers interrupted recordings and zero-byte audio honestly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-recordings-'));
  let now = 5_000;
  try {
    const first = new RecordingStore(root, { clock: { now: () => now }, minimumFreeBytes: 0 }); await first.initialize();
    const prepared = await first.create({ projectId: 'project_web', projectName: 'Interrupted', startUrl: 'https://example.test/', sharingChoice: 'local-only' });
    await first.beginSegment(prepared.recording.id); now = 5_500;
    const recovered = new RecordingStore(root, { minimumFreeBytes: 0 }); await recovered.initialize();
    const review = await recovered.get('project_web', prepared.recording.id);
    assert.equal(review.status, 'interrupted');
    assert.match(review.completenessWarnings.join(' '), /recovered/i);
    assert.match(review.completenessWarnings.join(' '), /audio is missing/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancel removes partial recording evidence from the local index', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-recordings-'));
  try {
    const store = new RecordingStore(root, { minimumFreeBytes: 0 }); await store.initialize();
    const prepared = await store.create({ projectId: 'project_web', projectName: 'Canceled', startUrl: 'https://example.test/', sharingChoice: 'local-only' });
    await store.beginSegment(prepared.recording.id);
    await store.cancel(prepared.recording.id);
    assert.deepEqual(store.list('project_web'), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('microphone-only recordings retain a playable first audio segment', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-recordings-'));
  let now = 10_000;
  try {
    const store = new RecordingStore(root, { clock: { now: () => now }, minimumFreeBytes: 0 }); await store.initialize();
    const prepared = await store.create({ projectId: 'project_web', projectName: 'Narration only', startUrl: 'https://example.test/', sharingChoice: 'local-only' });
    const active = await store.beginSegment(prepared.recording.id);
    await store.appendAudio({ recordingId: prepared.recording.id, segmentId: active.activeSegmentId!, mimeType: 'audio/webm', bytes: new Uint8Array([1, 2, 3, 4]) });
    now = 11_000; const review = await store.stop(prepared.recording.id);
    assert.equal(review.eventCount, 0); assert.ok(review.manifest.segments[0].audioArtifactId);
    assert.equal((await store.readAsset(review.id, review.manifest.segments[0].audioArtifactId!)).bytes.byteLength, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('action time is the arrival time, not the later screenshot completion time', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-action-time-'));
  let now = 10_000;
  try {
    const store = new RecordingStore(root, { clock: { now: () => now }, minimumFreeBytes: 0 }); await store.initialize();
    const prepared = await store.create({ projectId: 'project_web', projectName: 'Timing', startUrl: 'https://example.test/', sharingChoice: 'local-only' });
    await store.beginSegment(prepared.recording.id);
    const observedAtMonotonicMs = 10_750;
    now = 12_000;
    await store.addEvent(prepared.recording.id, { action: 'click', context: 'page', targetDescription: 'Start scroll', frameUrl: 'https://example.test/', observedAtMonotonicMs, screenshot: new Uint8Array([1, 2, 3]) });
    const review = await store.stop(prepared.recording.id);
    assert.equal(review.manifest.events[0].elapsedMs, 750);
    assert.equal(review.manifest.events[0].evidenceArtifactIds.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('transcript edits retain originals and evidence while intent corrections and unresolved questions survive restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-recordings-')); let now = 20_000;
  try {
    const store = new RecordingStore(root, { clock: { now: () => now }, minimumFreeBytes: 0 }); await store.initialize();
    const prepared = await store.create({ projectId: 'project_web', projectName: 'Intent fixture', startUrl: 'https://example.test/', sharingChoice: 'local-only' });
    const active = await store.beginSegment(prepared.recording.id);
    await store.appendAudio({ recordingId: prepared.recording.id, segmentId: active.activeSegmentId!, mimeType: 'audio/webm', bytes: new Uint8Array([1, 2, 3]) });
    now = 21_000; await store.addEvent(prepared.recording.id, { action: 'click', context: 'page', targetDescription: 'Annual plan' });
    now = 23_000; const review = await store.stop(prepared.recording.id); const segment = review.manifest.segments[0]; const event = review.manifest.events[0];
    await store.writeTranscript(review.id, {
      schemaVersion: 1, recordingId: review.id, status: 'ready', language: 'en',
      provider: { kind: 'local', runtime: 'whisper.cpp', runtimeVersion: '1.9.4', modelId: 'fixture-model', modelSha256: 'a'.repeat(64), translated: false },
      segments: [{ id: 'transcript_segment_1', recordingSegmentId: segment.id, startMs: 0, endMs: 2_900, timingUncertaintyMs: 100, originalText: 'Select the annual plan. No, correction.', text: 'Select the annual plan. No, correction.', revisions: [{ id: 'revision_original', text: 'Select the annual plan. No, correction.', editedAt: new Date().toISOString(), source: 'whisper' }], evidenceEventIds: [event.id] }],
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), warnings: [],
    });
    const edited = await store.saveTranscriptEdits(review.id, [{ segmentId: 'transcript_segment_1', text: 'Select the monthly plan. Do not submit.' }]);
    assert.equal(edited.transcript?.segments[0].originalText, 'Select the annual plan. No, correction.'); assert.equal(edited.transcript?.segments[0].revisions.length, 2);
    await store.saveIntent(review.id, { readiness: 'draft', items: [{ id: 'intent_correction', kind: 'correction', statement: 'Ignore the annual-plan click; monthly is the corrected choice.', transcriptSegmentIds: ['transcript_segment_1'], evidenceEventIds: [event.id] }], unresolvedQuestions: ['What should confirm the monthly plan?'] });
    await assert.rejects(store.saveIntent(review.id, { readiness: 'ready', items: [{ id: 'intent_correction', kind: 'correction', statement: 'Use the corrected monthly choice.', transcriptSegmentIds: ['transcript_segment_1'], evidenceEventIds: [event.id] }], unresolvedQuestions: ['Still unresolved'] }), /Resolve every open question/);
    await store.saveIntent(review.id, { readiness: 'ready', items: [{ id: 'intent_correction', kind: 'correction', statement: 'Use the corrected monthly choice.', transcriptSegmentIds: ['transcript_segment_1'], evidenceEventIds: [event.id] }], unresolvedQuestions: [] });
    await store.saveTranscriptEdits(review.id, [{ segmentId: 'transcript_segment_1', text: 'Select the monthly plan. Never submit.' }]);
    const reopened = new RecordingStore(root, { minimumFreeBytes: 0 }); await reopened.initialize(); const restored = await reopened.get('project_web', review.id);
    assert.equal(restored.transcript?.segments[0].text, 'Select the monthly plan. Never submit.'); assert.equal(restored.transcript?.segments[0].originalText, 'Select the annual plan. No, correction.');
    assert.equal(restored.intent?.readiness, 'draft'); assert.match(restored.intent?.unresolvedQuestions.join(' ') ?? '', /transcript changed/i); assert.equal(restored.intent?.items[0].kind, 'correction');
  } finally { await rm(root, { recursive: true, force: true }); }
});
