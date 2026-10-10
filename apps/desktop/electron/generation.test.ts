import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CodingAgentReadinessReport, LocalRecordingReview } from '@sayspec/contracts';
import { CodingAgentError, type CodingAgentInvocation, type CodingAgentInvocationResult } from './coding-agent/adapters.ts';
import { PlaywrightGenerationManager, generationInputRevisionHash, validatePlaywrightGenerationOutput, type CodingAgentInvoker } from './generation/playwright-generation.ts';
import { RecordingStore } from './recording-store.ts';

const readiness: CodingAgentReadinessReport = {
  checkedAt: '2026-09-20T10:00:00.000Z', disclosure: 'fixture', providers: [{
    id: 'codex', displayName: 'Codex', state: 'ready', version: '0.144.6', detail: 'ready',
    isolation: { writeAccess: 'none', enforcement: 'codex-os-read-only-sandbox', verified: true },
  }],
};

function validOutput(review: LocalRecordingReview) {
  const intentIds = review.intent!.items.map((item) => item.id);
  const transcriptIds = review.transcript!.segments.map((item) => item.id);
  const evidenceIds = [...new Set(review.intent!.items.flatMap((item) => item.evidenceEventIds))];
  return {
    title: 'Monthly plan increases the order count',
    steps: [{ id: 'step_checkout', instruction: 'Select the reviewed monthly plan and observe the order count.', assertion: 'The order count increases by exactly one and the form is not submitted.', intentItemIds: intentIds, transcriptSegmentIds: transcriptIds, evidenceEventIds: evidenceIds }],
    files: [{ relativePath: 'tests/monthly-plan.spec.ts', mimeType: 'text/typescript', text: "import { test, expect } from '@playwright/test';\ntest('monthly plan', async ({ page }) => {\n  await page.goto('/');\n  const before = await page.getByTestId('count').textContent();\n  await page.getByRole('radio', { name: 'Monthly' }).check();\n  await expect(page.getByTestId('count')).not.toHaveText(before ?? '');\n  await expect(page).toHaveURL(/\\/$/);\n});" }],
    entrypoint: 'tests/monthly-plan.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, unresolvedQuestions: [],
  };
}

class FakeInvoker implements CodingAgentInvoker {
  invocation?: CodingAgentInvocation;
  readonly run: (input: CodingAgentInvocation) => Promise<CodingAgentInvocationResult>;
  constructor(run: (input: CodingAgentInvocation) => Promise<CodingAgentInvocationResult>) { this.run = run; }
  async readiness() { return readiness; }
  async invoke(input: CodingAgentInvocation) { this.invocation = input; return this.run(input); }
}

async function reviewedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-generation-')); let now = 1_000;
  const store = new RecordingStore(path.join(root, 'recordings'), { clock: { now: () => now }, minimumFreeBytes: 0 }); await store.initialize();
  const created = await store.create({ projectId: 'project_web', projectName: 'Generation fixture', startUrl: 'https://example.test/checkout', sharingChoice: 'local-only' });
  const active = await store.beginSegment(created.recording.id);
  now = 1_500;
  const event = await store.addEvent(created.recording.id, { action: 'click', context: 'page', targetDescription: 'Monthly plan', frameUrl: 'https://example.test/checkout', locatorCandidates: ['getByRole("radio", { name: "Monthly" })'], screenshot: new Uint8Array([137, 80, 78, 71]) });
  now = 4_000; const stopped = await store.stop(created.recording.id);
  await store.writeTranscript(stopped.id, {
    schemaVersion: 1, recordingId: stopped.id, status: 'ready', provider: { kind: 'local', runtime: 'whisper.cpp', runtimeVersion: '1.9.4', modelId: 'whisper-small-q5_1-multilingual', modelSha256: 'a'.repeat(64), translated: false },
    startedAt: '2026-09-20T10:00:00.000Z', finishedAt: '2026-09-20T10:00:01.000Z', warnings: [], segments: [{
      id: 'transcript_segment_1', recordingSegmentId: active.activeSegmentId!, startMs: 0, endMs: 3_000, timingUncertaintyMs: 100,
      originalText: 'Select annual. No, correction, select monthly. The count should increase by one. Do not submit.',
      text: 'Select annual. No, correction, select monthly. The count should increase by one. Do not submit.',
      revisions: [{ id: 'revision_whisper', text: 'Select annual. No, correction, select monthly. The count should increase by one. Do not submit.', editedAt: '2026-09-20T10:00:00.000Z', source: 'whisper' }], evidenceEventIds: [event!.id],
    }],
  });
  await store.saveIntent(stopped.id, { readiness: 'ready', unresolvedQuestions: [], items: [
    { id: 'intent_choice', kind: 'exact-choice', statement: 'Use the monthly plan.', transcriptSegmentIds: ['transcript_segment_1'], evidenceEventIds: [event!.id] },
    { id: 'intent_correction', kind: 'correction', statement: 'Ignore the earlier annual choice and do not submit the form.', transcriptSegmentIds: ['transcript_segment_1'], evidenceEventIds: [event!.id] },
    { id: 'intent_assertion', kind: 'relational-assertion', statement: 'The order count increases by exactly one.', transcriptSegmentIds: ['transcript_segment_1'], evidenceEventIds: [event!.id] },
  ] });
  return { root, store, review: await store.get('project_web', stopped.id) };
}

test('reviewed intent becomes a hashed, evidence-linked, unvalidated Playwright draft and reopens after restart', async () => {
  const value = await reviewedFixture();
  try {
    const invoker = new FakeInvoker(async () => ({ provider: 'codex', cliVersion: '0.144.6', output: validOutput(value.review) }));
    const manager = new PlaywrightGenerationManager({ rootDirectory: path.join(value.root, 'work'), store: value.store, adapters: invoker, validationMode: 'off' }); await manager.initialize();
    const draft = await manager.start(value.review.id, 'codex');
    assert.equal(draft.state, 'draft'); assert.equal(draft.provenance.executionValidated, false); assert.equal(draft.provenance.published, false);
    assert.equal(draft.provenance.inputRevisionHash, generationInputRevisionHash(value.review)); assert.equal(draft.files[0].byteLength, Buffer.byteLength(draft.files[0].text));
    assert.match(invoker.invocation?.prompt ?? '', /untrusted data/i); assert.equal(invoker.invocation?.evidenceImagePaths?.length, 1);
    const reopened = new RecordingStore(path.join(value.root, 'recordings'), { minimumFreeBytes: 0 }); await reopened.initialize();
    const restored = await reopened.get('project_web', value.review.id);
    assert.equal(restored.generationDraft?.state, 'draft'); assert.equal(restored.generationDraft?.steps[0].evidenceEventIds[0], value.review.manifest.events[0].id);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('a narrated recording generates directly without a transcript-edit or intent form', async () => {
  const value = await reviewedFixture();
  try {
    await unlink(path.join(value.root, 'recordings', value.review.id, 'intent.json'));
    const review = await value.store.get('project_web', value.review.id);
    assert.equal(review.intent, undefined);
    const output = validOutput(value.review);
    output.steps[0].intentItemIds = [];
    const invoker = new FakeInvoker(async () => ({ provider: 'codex', cliVersion: '0.144.6', output }));
    const manager = new PlaywrightGenerationManager({ rootDirectory: path.join(value.root, 'work-direct'), store: value.store, adapters: invoker, validationMode: 'off' }); await manager.initialize();
    const generated = await manager.start(review.id, 'codex');
    assert.equal(generated.state, 'draft', generated.error ?? 'Generation did not complete.');
    assert.deepEqual(generated.steps[0].intentItemIds, []);
    assert.match(invoker.invocation?.prompt ?? '', /The event timeline is what happened/);
    assert.match(invoker.invocation?.prompt ?? '', /recordedActions/);
    assert.doesNotMatch(invoker.invocation?.prompt ?? '', /"reviewedIntent"/);
    const reopened = new RecordingStore(path.join(value.root, 'recordings'), { minimumFreeBytes: 0 }); await reopened.initialize();
    assert.equal((await reopened.get('project_web', review.id)).generationDraft?.state, 'draft');
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('silent narration never invokes the coding AI to invent a verification', async () => {
  const value = await reviewedFixture();
  try {
    await value.store.writeTranscript(value.review.id, { ...value.review.transcript!, segments: [] });
    let invoked = false;
    const invoker = new FakeInvoker(async () => { invoked = true; return { provider: 'codex', cliVersion: '0.144.6', output: validOutput(value.review) }; });
    const manager = new PlaywrightGenerationManager({ rootDirectory: path.join(value.root, 'work-silent'), store: value.store, adapters: invoker, validationMode: 'off' }); await manager.initialize();
    await assert.rejects(manager.start(value.review.id, 'codex'), /No speech was detected/);
    assert.equal(invoked, false);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('generation rejects malformed output, traversal, scope escape, unsupported dependencies, and missing evidence links', async () => {
  const value = await reviewedFixture();
  try {
    const base = validOutput(value.review);
    assert.throws(() => validatePlaywrightGenerationOutput('not-json', value.review), /object/);
    assert.throws(() => validatePlaywrightGenerationOutput({ ...base, files: [{ ...base.files[0], relativePath: '../application.ts' }], entrypoint: '../application.ts' }, value.review), /unsafe/);
    assert.throws(() => validatePlaywrightGenerationOutput({ ...base, files: [{ ...base.files[0], relativePath: 'node_modules/escape.spec.ts' }], entrypoint: 'node_modules/escape.spec.ts' }, value.review), /reserved/);
    assert.throws(() => validatePlaywrightGenerationOutput({ ...base, dependencies: { '@playwright/test': '1.63.0', 'scope-escape-package': 'latest' } }, value.review), /must contain only/);
    assert.throws(() => validatePlaywrightGenerationOutput({ ...base, steps: [{ ...base.steps[0], evidenceEventIds: ['event_unknown'] }] }, value.review), /unknown evidence/);
    assert.throws(() => validatePlaywrightGenerationOutput({ ...base, files: [{ ...base.files[0], text: "import { test } from '@playwright/test'; test('x', async () => {});" }] }, value.review), /explicit expect/);
    assert.throws(() => validatePlaywrightGenerationOutput({ ...base, files: [{ ...base.files[0], text: "import { test, expect } from '@playwright/test'; test.skip('x', async () => { expect(true).toBe(true); });" }] }, value.review), /skip or invert/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('an AI revision cannot silently remove an original matcher or rewrite its readable assertion', async () => {
  const value = await reviewedFixture();
  try {
    let calls = 0; let runs = 0;
    const invoker = new FakeInvoker(async () => {
      calls++;
      const output = validOutput(value.review);
      if (calls === 2) {
        output.steps[0].assertion = 'Something changes.';
        output.files[0].text = output.files[0].text.replace("  await expect(page).toHaveURL(/\\/$/);", '');
      }
      return { provider: 'codex', cliVersion: '0.144.6', output };
    });
    const manager = new PlaywrightGenerationManager({ rootDirectory: path.join(value.root, 'work-no-weakening'), store: value.store, adapters: invoker,
      validator: async () => { runs++; return { status: 'failed', passed: 0, failed: 1, summary: 'Failure', detail: 'Live page snapshot: a changed page.' }; } });
    await manager.initialize();
    const result = await manager.start(value.review.id, 'codex');
    assert.equal(result.state, 'failed'); assert.match(result.error ?? '', /changed or removed an original expectation/);
    assert.equal(calls, 2); assert.equal(runs, 1);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('transcript edits during generation make the returned draft stale and revoke intent readiness', async () => {
  const value = await reviewedFixture();
  let release!: () => void; let invoked!: () => void;
  const started = new Promise<void>((resolve) => { invoked = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    const invoker = new FakeInvoker(async () => { invoked(); await hold; return { provider: 'codex', cliVersion: '0.144.6', output: validOutput(value.review) }; });
    const manager = new PlaywrightGenerationManager({ rootDirectory: path.join(value.root, 'work'), store: value.store, adapters: invoker, validationMode: 'off' }); await manager.initialize();
    const running = manager.start(value.review.id, 'codex'); await started;
    await value.store.saveTranscriptEdits(value.review.id, [{ segmentId: 'transcript_segment_1', text: 'Use the corrected monthly plan. The count increases by one. Do not submit.' }]);
    release(); const draft = await running;
    assert.equal(draft.state, 'stale'); assert.match(draft.warnings.join(' '), /recording changed/i);
    assert.equal((await value.store.get('project_web', value.review.id)).intent?.readiness, 'draft');
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('cancellation and missing authentication remain honest failures without draft success', async () => {
  const value = await reviewedFixture();
  try {
    let invoked!: () => void; const started = new Promise<void>((resolve) => { invoked = resolve; });
    const cancelInvoker = new FakeInvoker((input) => new Promise((_resolve, reject) => {
      invoked(); input.signal?.addEventListener('abort', () => reject(new CodingAgentError('canceled', 'canceled')), { once: true });
    }));
    const manager = new PlaywrightGenerationManager({ rootDirectory: path.join(value.root, 'work-cancel'), store: value.store, adapters: cancelInvoker, validationMode: 'off' }); await manager.initialize();
    const running = manager.start(value.review.id, 'codex'); await started; const canceled = await manager.cancel(value.review.id); await running;
    assert.equal(canceled.state, 'canceled'); assert.match(canceled.error ?? '', /No test was published/i);

    const authInvoker = new FakeInvoker(async () => { throw new CodingAgentError('unauthenticated', 'The CLI is not authenticated.'); });
    const second = new PlaywrightGenerationManager({ rootDirectory: path.join(value.root, 'work-auth'), store: value.store, adapters: authInvoker, validationMode: 'off' }); await second.initialize();
    const failed = await second.start(value.review.id, 'codex'); assert.equal(failed.state, 'failed'); assert.match(failed.error ?? '', /not authenticated/i);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('failed Playwright run is returned to the agent and only a passing rerun is saved as validated', async () => {
  const value = await reviewedFixture();
  try {
    const prompts: string[] = []; let runs = 0;
    const invoker = new FakeInvoker(async (input) => { prompts.push(input.prompt); return { provider: 'codex', cliVersion: '0.144.6', output: validOutput(value.review) }; });
    const manager = new PlaywrightGenerationManager({
      rootDirectory: path.join(value.root, 'work-validated'), store: value.store, adapters: invoker,
      validator: async () => ++runs === 1
        ? { status: 'failed', passed: 0, failed: 1, summary: '1 Playwright test failed.', detail: 'Live page snapshot: heading is named Do your test.' }
        : { status: 'passed', passed: 1, failed: 0, summary: '1 Playwright test passed.', detail: '' },
    });
    await manager.initialize();
    const draft = await manager.start(value.review.id, 'codex');
    assert.equal(draft.state, 'draft'); assert.equal(draft.provenance.executionValidated, true);
    assert.equal(draft.validation?.attempts, 2); assert.equal(runs, 2);
    assert.deepEqual(draft.validationHistory?.map((item) => item.status), ['failed', 'passed']);
    assert.match(prompts[1], /Live page snapshot: heading is named Do your test/);
    const reopened = new RecordingStore(path.join(value.root, 'recordings'), { minimumFreeBytes: 0 }); await reopened.initialize();
    assert.equal((await reopened.get('project_web', value.review.id)).generationDraft?.provenance.executionValidated, true);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
