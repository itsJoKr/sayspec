import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlaywrightGenerationManager } from './playwright-generation.ts';
import { RecordingStore } from '../recording-store.ts';

test('signed-in Claude Code generates and locally validates a public narrated scroll test', { skip: process.env.SAYSPEC_REAL_VALIDATED_CLAUDE !== '1', timeout: 8 * 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-real-validated-'));
  let now = 1_000;
  try {
    const store = new RecordingStore(path.join(root, 'recordings'), { clock: { now: () => now }, minimumFreeBytes: 0 }); await store.initialize();
    const prepared = await store.create({ projectId: 'project_web', projectName: 'Public SaySpec landing page', startUrl: 'https://sayspec.app/', sharingChoice: 'local-only' });
    const active = await store.beginSegment(prepared.recording.id);
    now = 26_000;
    const navigation = await store.addEvent(prepared.recording.id, { action: 'navigation', context: 'page', targetDescription: 'https://sayspec.app/', frameUrl: 'https://sayspec.app/' });
    now = 30_000;
    const click = await store.addEvent(prepared.recording.id, { action: 'click', context: 'page', targetDescription: 'a · See how it works ↓', frameUrl: 'https://sayspec.app/', locatorCandidates: ['a[href="#how-it-works"]'] });
    now = 35_000; const stopped = await store.stop(prepared.recording.id);
    const narration = 'On the homepage, click See how it works. It should scroll down to the How it works section.';
    await store.writeTranscript(stopped.id, {
      schemaVersion: 1, recordingId: stopped.id, status: 'ready', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), warnings: [],
      provider: { kind: 'local', runtime: 'whisper.cpp', runtimeVersion: '1.9.4', modelId: 'whisper-small-q5_1-multilingual', modelSha256: 'a'.repeat(64), translated: false },
      segments: [{ id: 'transcript_segment_1', recordingSegmentId: active.activeSegmentId!, startMs: 0, endMs: 8_060, timingUncertaintyMs: 100, originalText: narration, text: narration, revisions: [{ id: 'revision_1', text: narration, editedAt: new Date().toISOString(), source: 'whisper' }], evidenceEventIds: [navigation!.id, click!.id] }],
    });
    const manager = new PlaywrightGenerationManager({ rootDirectory: path.join(root, 'work'), store }); await manager.initialize();
    const generated = await manager.start(stopped.id, 'claude-code');
    assert.equal(generated.state, 'draft', `${generated.error ?? generated.validation?.summary}\n${generated.validation?.detail ?? ''}`);
    assert.equal(generated.validation?.status, 'passed');
    assert.equal(generated.provenance.executionValidated, true);
    const reopened = new RecordingStore(path.join(root, 'recordings'), { minimumFreeBytes: 0 }); await reopened.initialize();
    assert.equal((await reopened.get('project_web', stopped.id)).generationDraft?.validation?.status, 'passed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
