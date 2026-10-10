import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlaywrightGenerationManager } from './generation/playwright-generation.ts';
import { RecordingStore } from './recording-store.ts';
import { LocalTranscriptionManager } from './transcription/local-transcription.ts';
import { LocalModelManager } from './transcription/model-manager.ts';
import { DEFAULT_WHISPER_MODEL } from './transcription/model-manifest.ts';

const enabled = process.env.SAYSPEC_REAL_GENERATION === '1';
const modelFixture = process.env.SAYSPEC_REAL_WHISPER_MODEL;
const englishFixture = process.env.SAYSPEC_REAL_WHISPER_ENGLISH;

test('a real locally transcribed recording produces and reopens a reviewable Playwright draft through Codex', { skip: !enabled, timeout: 8 * 60_000 }, async () => {
  if (!modelFixture || !englishFixture) throw new Error('Set SAYSPEC_REAL_WHISPER_MODEL and SAYSPEC_REAL_WHISPER_ENGLISH.');
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-real-generation-')); let now = 1_000;
  try {
    const modelRoot = path.join(root, 'models'); await mkdir(modelRoot, { recursive: true });
    await link(modelFixture, path.join(modelRoot, DEFAULT_WHISPER_MODEL.fileName));
    const models = new LocalModelManager({ rootDirectory: modelRoot }); await models.initialize();
    assert.equal((await models.snapshot()).runtime.state, 'ready'); assert.equal((await models.snapshot()).model.state, 'installed');

    const recordingsRoot = path.join(root, 'recordings');
    const store = new RecordingStore(recordingsRoot, { clock: { now: () => now }, minimumFreeBytes: 0 }); await store.initialize();
    const prepared = await store.create({ projectId: 'project_web', projectName: 'Real generated checkout', startUrl: 'https://example.test/checkout', sharingChoice: 'local-only' });
    const active = await store.beginSegment(prepared.recording.id);
    await store.appendAudio({ recordingId: prepared.recording.id, segmentId: active.activeSegmentId!, mimeType: 'audio/wav', bytes: await readFile(englishFixture) });
    now = 2_500;
    const event = await store.addEvent(prepared.recording.id, {
      action: 'click', context: 'page', targetDescription: 'Monthly plan radio', frameUrl: 'https://example.test/checkout',
      locatorCandidates: ['getByRole("radio", { name: "Monthly" })'],
      screenshot: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    });
    now = 13_500; const review = await store.stop(prepared.recording.id);
    const transcription = new LocalTranscriptionManager({ rootDirectory: path.join(root, 'transcription-work'), store, models }); await transcription.initialize();
    const transcript = await transcription.start(review.id); assert.equal(transcript.status, 'ready');
    const transcriptText = transcript.segments.map((segment) => segment.text).join(' ');
    assert.match(transcriptText, /No, correction/i); assert.match(transcriptText, /Do not submit the form/i);

    const generation = new PlaywrightGenerationManager({ rootDirectory: path.join(root, 'generation-work'), store, validationMode: 'off' }); await generation.initialize();
    const draft = await generation.start(review.id, 'codex');
    assert.equal(draft.state, 'draft', draft.error ?? 'generation did not complete'); assert.equal(draft.provenance.provider, 'codex'); assert.equal(draft.provenance.executionValidated, false);
    assert.ok(draft.steps.every((step) => step.assertion.trim())); assert.ok(draft.steps.some((step) => step.evidenceEventIds.includes(event!.id)));
    assert.match(draft.files.find((file) => file.relativePath === draft.runtime.entrypoint)?.text ?? '', /expect\s*\(/);
    const reopened = new RecordingStore(recordingsRoot, { minimumFreeBytes: 0 }); await reopened.initialize();
    const restored = await reopened.get('project_web', review.id);
    assert.equal(restored.transcript?.status, 'ready'); assert.equal(restored.intent, undefined); assert.equal(restored.generationDraft?.state, 'draft');
    assert.equal(restored.generationDraft?.provenance.inputRevisionHash, draft.provenance.inputRevisionHash);
  } finally { await rm(root, { recursive: true, force: true }); }
});
