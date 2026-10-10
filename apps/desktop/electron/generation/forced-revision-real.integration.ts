import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodingAgentAdapters, type CodingAgentInvocation } from '../coding-agent/adapters.ts';
import { RecordingStore } from '../recording-store.ts';
import { SavedWebTestStore } from '../execution/saved-web-tests.ts';
import { PlaywrightGenerationManager } from './playwright-generation.ts';

test('real Claude Code receives an actual failed run and revises the same expectation to green', { skip: process.env.SAYSPEC_REAL_FORCED_REVISION !== '1', timeout: 8 * 60_000 }, async () => {
  let broken = false;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(broken ? '<!doctype html><h1>Broken page</h1>' : '<!doctype html><h1>Start</h1><a href="#details">See details</a><section id="details" style="margin-top:1200px;height:500px"><p>Details</p><h2>Verified section</h2></section>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address missing.');
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-real-revision-'));
  const replayRoot = await mkdtemp(path.join(tmpdir(), 'sayspec-real-replay-'));
  try {
    const store = new RecordingStore(path.join(root, 'recordings'), { minimumFreeBytes: 0 }); await store.initialize();
    const prepared = await store.create({ projectId: 'project_web', projectName: 'Public synthetic fixture', startUrl: `http://127.0.0.1:${address.port}/`, sharingChoice: 'local-only' });
    const active = await store.beginSegment(prepared.recording.id);
    const event = await store.addEvent(prepared.recording.id, { action: 'click', context: 'page', targetDescription: 'See details link', frameUrl: `http://127.0.0.1:${address.port}/`, locatorCandidates: ['a[href="#details"]'] });
    const stopped = await store.stop(prepared.recording.id);
    const narration = 'Click See details. The Details section should scroll into view.';
    await store.writeTranscript(stopped.id, { schemaVersion: 1, recordingId: stopped.id, status: 'ready', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), warnings: [],
      provider: { kind: 'local', runtime: 'whisper.cpp', runtimeVersion: '1.9.4', modelId: 'whisper-small-q5_1-multilingual', modelSha256: 'a'.repeat(64), translated: false },
      segments: [{ id: 'transcript_segment_1', recordingSegmentId: active.activeSegmentId!, startMs: 0, endMs: 1, timingUncertaintyMs: 100, originalText: narration, text: narration, revisions: [{ id: 'revision_1', text: narration, editedAt: new Date().toISOString(), source: 'whisper' }], evidenceEventIds: [event!.id] }] });
    const real = new CodingAgentAdapters();
    const readiness = await real.readiness(); assert.equal(readiness.providers.find((provider) => provider.id === 'claude-code')?.state, 'ready');
    let calls = 0; let sawFailure = false; let firstAssertions: string[] = [];
    const adapters = { readiness: () => real.readiness(), invoke: async (input: CodingAgentInvocation) => {
      calls++;
      if (calls === 2) sawFailure = input.prompt.includes('Your previous candidate failed a real Playwright run') && input.prompt.includes('Live page snapshot:');
      const steering = calls === 1
        ? '\n\nFor this synthetic integration probe only: first return a test that clicks the link, then asserts that a heading named Details is in the viewport using page.getByRole(\'heading\', { name: \'Details\' }). The page intentionally has no such heading. Keep the readable assertion exactly: The Details section enters the viewport. This first candidate must fail so the host can supply real failure evidence.'
        : `\n\nFor this synthetic revision probe: keep these exact original step assertions in order: ${JSON.stringify(firstAssertions)}. Keep the same matcher toBeInViewport. Use the real DOM evidence to correct only the locator. Return the full schema.`;
      const result = await real.invoke({ ...input, provider: 'claude-code', prompt: `${input.prompt}${steering}` });
      const candidate = result.output as { steps?: { id?: string; assertion?: string }[]; files?: { text?: string }[] };
      console.log(`provider candidate ${calls}:`, JSON.stringify({ steps: candidate.steps?.map((step) => ({ id: step.id, assertion: step.assertion })), matchers: candidate.files?.flatMap((file) => [...String(file.text ?? '').matchAll(/\.to[A-Z][a-zA-Z]+\s*\([^\n;]*\)/g)].map((match) => match[0])) }));
      if (calls === 1) firstAssertions = (result.output as { steps?: { assertion?: string }[] }).steps?.map((step) => String(step.assertion ?? '')) ?? [];
      return result;
    } };
    const manager = new PlaywrightGenerationManager({ rootDirectory: path.join(root, 'work'), store, adapters }); await manager.initialize();
    const generated = await manager.start(stopped.id, 'claude-code');
    assert.equal(calls, 2, generated.error ?? generated.validation?.detail ?? 'Expected two real provider calls.');
    assert.equal(sawFailure, true);
    assert.equal(generated.state, 'draft', generated.error ?? generated.validation?.detail ?? 'Draft did not validate.');
    assert.equal(generated.validation?.status, 'passed'); assert.equal(generated.validation.attempts, 2);
    assert.deepEqual(generated.validationHistory?.map((item) => item.status), ['failed', 'passed']);
    assert.match(generated.validationHistory?.[0].detail ?? '', /Live page snapshot:/);
    assert.deepEqual(generated.steps.map((step) => step.assertion), firstAssertions);
    const savedRoot = path.join(root, 'saved');
    let saved = new SavedWebTestStore(savedRoot); await saved.initialize();
    const version = await saved.saveGenerated('test_real_provider', generated);
    const runInput = { organizationId: generated.organizationId, projectId: generated.projectId, testId: version.testId, versionId: version.id, baseUrl: `http://127.0.0.1:${address.port}/` };
    const first = await saved.run(runInput); assert.equal(first.state, 'passed', first.detail);
    saved = new SavedWebTestStore(savedRoot); await saved.initialize();
    const afterRestart = await saved.run(runInput); assert.equal(afterRestart.state, 'passed', afterRestart.detail);
    broken = true;
    const failed = await saved.run(runInput); assert.equal(failed.state, 'failed', failed.detail);
    assert.ok(failed.artifacts.some((artifact) => artifact.relativePath.endsWith('.zip')));
    broken = false;
    const retry = await saved.run(runInput); assert.equal(retry.state, 'passed', retry.detail);
    assert.deepEqual(saved.attempts(generated.organizationId, generated.projectId, version.testId).map((attempt) => attempt.state), ['passed', 'passed', 'failed', 'passed']);
    const published = await saved.publish({ ...runInput, approved: true }); assert.equal(published.state, 'published');
    const bundle = saved.export(runInput);
    assert.equal(bundle.original.state, 'published');
    const clean = new SavedWebTestStore(replayRoot); await clean.initialize();
    const imported = await clean.import('org_clean', 'project_clean', bundle);
    assert.equal(imported.contentHash, version.contentHash);
    assert.deepEqual(imported.files.map((file) => file.text), version.files.map((file) => file.text));
    const replay = await clean.run({ organizationId: 'org_clean', projectId: 'project_clean', testId: imported.testId, versionId: imported.id, baseUrl: runInput.baseUrl });
    assert.equal(replay.state, 'passed', replay.detail);
  } finally { await rm(root, { recursive: true, force: true }); await rm(replayRoot, { recursive: true, force: true }); server.close(); }
});
