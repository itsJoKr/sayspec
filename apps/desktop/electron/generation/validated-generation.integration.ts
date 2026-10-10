import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CodingAgentInvocation, CodingAgentInvocationResult } from '../coding-agent/adapters.ts';
import { PlaywrightGenerationManager } from './playwright-generation.ts';
import { RecordingStore } from '../recording-store.ts';

test('a recorded narration becomes green only after a failed locator is repaired and rerun against the live page', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><style>html{scroll-behavior:smooth}</style><h1>Start</h1><a href="#how-it-works">See how it works</a><section id="how-it-works" style="margin-top:1200px;height:500px"><p>How it works</p><h2>Do your test.</h2></section>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address.');
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-validated-generation-'));
  try {
    const store = new RecordingStore(path.join(root, 'recordings'), { minimumFreeBytes: 0 }); await store.initialize();
    const prepared = await store.create({ projectId: 'project_web', projectName: 'Scroll test', startUrl: `http://127.0.0.1:${address.port}/`, sharingChoice: 'local-only' });
    const active = await store.beginSegment(prepared.recording.id);
    const event = await store.addEvent(prepared.recording.id, { action: 'click', context: 'page', targetDescription: 'a · See how it works', frameUrl: `http://127.0.0.1:${address.port}/`, screenshot: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
    const stopped = await store.stop(prepared.recording.id);
    await store.writeTranscript(stopped.id, {
      schemaVersion: 1, recordingId: stopped.id, status: 'ready', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), warnings: [],
      provider: { kind: 'local', runtime: 'whisper.cpp', runtimeVersion: '1.9.4', modelId: 'whisper-small-q5_1-multilingual', modelSha256: 'a'.repeat(64), translated: false },
      segments: [{ id: 'transcript_segment_1', recordingSegmentId: active.activeSegmentId!, startMs: 0, endMs: 1, timingUncertaintyMs: 100, originalText: 'Click See how it works and the page should scroll to How it works.', text: 'Click See how it works and the page should scroll to How it works.', revisions: [{ id: 'revision_1', text: 'Click See how it works and the page should scroll to How it works.', editedAt: new Date().toISOString(), source: 'whisper' }], evidenceEventIds: [event!.id] }],
    });
    let calls = 0; let sawLiveSnapshot = false;
    const adapters = {
      readiness: async () => ({ checkedAt: new Date().toISOString(), disclosure: '', providers: [] }),
      invoke: async (input: CodingAgentInvocation): Promise<CodingAgentInvocationResult> => {
        calls++;
        if (calls === 2) sawLiveSnapshot = input.prompt.includes('Live page snapshot:') && input.prompt.includes('Do your test.');
        const target = calls === 1 ? "page.getByRole('heading', { name: /how it works/i })" : "page.locator('#how-it-works')";
        return { provider: 'claude-code', cliVersion: '2.1.269', output: {
          title: 'See how it works scrolls to the section',
          steps: [{ id: 'step_scroll', instruction: 'Click See how it works.', assertion: 'The How it works section enters the viewport.', intentItemIds: [], transcriptSegmentIds: ['transcript_segment_1'], evidenceEventIds: [event!.id] }],
          files: [{ relativePath: 'tests/scroll.spec.ts', mimeType: 'text/typescript', text: `import { test, expect } from '@playwright/test'; test('scroll', async ({ page }) => { await page.goto('/'); await page.getByRole('link', { name: /see how it works/i }).click(); await expect(${target}).toBeInViewport({ timeout: 3000 }); });` }],
          entrypoint: 'tests/scroll.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, unresolvedQuestions: [],
        } };
      },
    };
    const manager = new PlaywrightGenerationManager({ rootDirectory: path.join(root, 'work'), store, adapters }); await manager.initialize();
    const generated = await manager.start(stopped.id, 'claude-code');
    assert.equal(generated.state, 'draft', generated.error ?? generated.validation?.detail ?? 'Generation did not validate.');
    assert.equal(generated.provenance.executionValidated, true);
    assert.equal(generated.validation?.attempts, 2);
    assert.equal(calls, 2); assert.equal(sawLiveSnapshot, true);
    const reopened = new RecordingStore(path.join(root, 'recordings'), { minimumFreeBytes: 0 }); await reopened.initialize();
    assert.equal((await reopened.get('project_web', stopped.id)).generationDraft?.validation?.status, 'passed');
  } finally { await rm(root, { recursive: true, force: true }); server.close(); }
});
