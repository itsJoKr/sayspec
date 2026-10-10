import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PlaywrightGenerationDraft } from '@sayspec/contracts';
import { SavedWebTestStore } from './saved-web-tests.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function draft(recordingId: string): PlaywrightGenerationDraft {
  const source = `import { test, expect } from '@playwright/test'; test('${recordingId}', () => expect(true).toBe(true));`;
  return { schemaVersion: 1, id: `generation_${recordingId}`, organizationId: 'org_one', projectId: 'project_one', recordingId, state: 'draft', title: recordingId,
    steps: [{ id: 'step_one', instruction: 'Open page', assertion: 'Page works', intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }],
    files: [{ id: 'file_one', relativePath: 'tests/test.spec.ts', text: source, sha256: sha(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' }],
    runtime: { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: 'tests/test.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, requirements: ['Node.js >=22.12.0', 'Playwright Chromium installed'] },
    unresolvedQuestions: [], provenance: { provider: 'codex', cliVersion: 'fixture', generatedAt: new Date().toISOString(), inputRevisionHash: 'a'.repeat(64), recordingId, selectedEvidenceEventIds: [], executionValidated: true, published: false },
    warnings: [], validation: { status: 'passed', attempts: 1, passed: 1, failed: 0, summary: 'Green', validatedAt: new Date().toISOString() } };
}
async function settled(store: SavedWebTestStore, runId: string) {
  for (let i = 0; i < 900; i++) {
    const run = store.listRuns('org_one', 'project_one').find((item) => item.id === runId)!;
    if (['completed', 'canceled', 'interrupted'].includes(run.state)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Run did not settle.');
}

test('named run snapshots versions and environment, records mixed results, retry retains failure and restart reopens history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-multi-run-'));
  let call = 0;
  let lastHeaded = false;
  try {
    const store = new SavedWebTestStore(root, async ({ headed }) => { lastHeaded = headed === true; call++;
      const status = call === 1 ? 'failed' : call === 2 ? 'skipped' : 'passed';
      return { status, passed: status === 'passed' ? 1 : 0, failed: status === 'failed' ? 1 : 0, skipped: status === 'skipped' ? 1 : 0, summary: status, detail: '', tests: [{ id: 'test', title: 'fixture', outcome: status, durationMs: 1, errors: [] }], artifacts: [] };
    }); await store.initialize();
    const first = await store.saveGenerated('test_first', draft('recording_first'));
    await store.saveGenerated('test_second', draft('recording_second'));
    await assert.rejects(store.createRun({ organizationId: 'org_one', projectId: 'project_one', name: 'Cross scope', baseUrl: 'https://example.test', testIds: ['test_other'] }), /no intact saved version/);
    const run = await store.createRun({ organizationId: 'org_one', projectId: 'project_one', name: 'Smoke', baseUrl: 'https://example.test', testIds: ['test_first', 'test_second'], suiteId: 'suite_smoke' });
    assert.equal(run.state, 'queued');
    assert.equal(call, 0);
    assert.equal(run.showBrowser, false);
    await store.startRun({ organizationId: 'org_one', projectId: 'project_one', runId: run.id, showBrowser: true });
    assert.equal(store.listRuns('org_one', 'project_one')[0].showBrowser, true);
    const done = await settled(store, run.id);
    assert.equal(done.state, 'completed'); assert.deepEqual(done.items.map((item) => item.attemptIds.length), [1, 1]);
    assert.equal(lastHeaded, true);
    assert.equal(store.attempts('org_one', 'project_one', 'test_first')[0].state, 'failed');
    assert.equal(store.attempts('org_one', 'project_one', 'test_second')[0].state, 'skipped');
    const retry = await store.retryRunItem({ organizationId: 'org_one', projectId: 'project_one', runId: run.id, testId: 'test_first' });
    assert.equal(retry.state, 'passed'); assert.deepEqual(store.attempts('org_one', 'project_one', 'test_first').map((item) => item.state), ['failed', 'passed']);
    assert.equal(store.listRuns('org_one', 'project_one')[0].items[0].contentHash, first.contentHash);
    assert.equal(store.listRuns('org_one', 'project_one')[0].items[0].version.files[0].text, first.files[0].text);
    const reopened = new SavedWebTestStore(root); await reopened.initialize();
    assert.equal(reopened.listRuns('org_one', 'project_one')[0].items[0].attemptIds.length, 2);
    assert.equal(reopened.listRuns('org_one', 'project_one')[0].baseUrl, 'https://example.test/');
    assert.deepEqual(reopened.listRuns('org_other', 'project_one'), []);
    await assert.rejects(reopened.retryRunItem({ organizationId: 'org_other', projectId: 'project_one', runId: run.id, testId: 'test_first' }), /not found/);
    const raw = JSON.parse(await readFile(path.join(root, 'index.json'), 'utf8'));
    raw.runs[0].state = 'running'; raw.runs[0].finishedAt = undefined;
    await writeFile(path.join(root, 'index.json'), JSON.stringify(raw));
    const recovered = new SavedWebTestStore(root); await recovered.initialize();
    assert.equal(recovered.listRuns('org_one', 'project_one')[0].state, 'interrupted');
    assert.equal(recovered.attempts('org_one', 'project_one', 'test_first').length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('multi-test run executes real saved Chromium source, retains failure trace and retry artifacts', { timeout: 90_000 }, async () => {
  let heading = 'Ready';
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(`<h1>${heading}</h1>`); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server missing.');
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-multi-real-'));
  try {
    const store = new SavedWebTestStore(root); await store.initialize();
    const passingSource = "import { test, expect } from '@playwright/test'; test('ready', async ({ page }) => { await page.goto('/'); await expect(page.getByRole('heading', { name: 'Ready' })).toBeVisible(); });";
    const failingSource = "import { test, expect } from '@playwright/test'; test('not ready', async ({ page }) => { await page.goto('/'); await expect(page.getByRole('heading', { name: 'Not ready' })).toBeVisible(); });";
    const saved = async (testId: string, recordingId: string, source: string) => {
      const base = draft(recordingId);
      return store.saveGenerated(testId, { ...base, files: [{ ...base.files[0], text: source, sha256: sha(source), byteLength: Buffer.byteLength(source) }] });
    };
    await saved('test_green', 'recording_green', passingSource);
    await saved('test_red', 'recording_red', failingSource);
    const run = await store.createRun({ organizationId: 'org_one', projectId: 'project_one', name: 'Real browser smoke', baseUrl: `http://127.0.0.1:${address.port}/`, testIds: ['test_green', 'test_red'] });
    await store.startRun({ organizationId: 'org_one', projectId: 'project_one', runId: run.id });
    const finished = await settled(store, run.id); assert.equal(finished.state, 'completed');
    const pass = store.attempts('org_one', 'project_one', 'test_green')[0];
    const fail = store.attempts('org_one', 'project_one', 'test_red')[0];
    assert.equal(pass.state, 'passed', pass.detail); assert.equal(fail.state, 'failed', fail.detail);
    const trace = fail.artifacts.find((item) => item.relativePath.endsWith('.zip')); assert.ok(trace);
    const bytes = await store.readArtifact({ organizationId: 'org_one', projectId: 'project_one', testId: 'test_red', attemptId: fail.id, relativePath: trace.relativePath }); assert.equal(bytes.bytes.byteLength, trace.byteLength);
    heading = 'Not ready';
    const retry = await store.retryRunItem({ organizationId: 'org_one', projectId: 'project_one', runId: run.id, testId: 'test_red' }); assert.equal(retry.state, 'passed', retry.detail);
    const reopened = new SavedWebTestStore(root); await reopened.initialize();
    assert.deepEqual(reopened.attempts('org_one', 'project_one', 'test_red').map((item) => item.state), ['failed', 'passed']);
    assert.equal((await reopened.readArtifact({ organizationId: 'org_one', projectId: 'project_one', testId: 'test_red', attemptId: fail.id, relativePath: trace.relativePath })).bytes.byteLength, trace.byteLength);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test('cancel stops current local attempt and leaves the remainder unrun', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-multi-cancel-'));
  try {
    const store = new SavedWebTestStore(root, async ({ signal }) => new Promise((resolve) => {
      signal?.addEventListener('abort', () => resolve({ status: 'canceled', passed: 0, failed: 0, summary: 'Canceled', detail: '', artifacts: [] }), { once: true });
    })); await store.initialize();
    await store.saveGenerated('test_first', draft('recording_first')); await store.saveGenerated('test_second', draft('recording_second'));
    const run = await store.createRun({ organizationId: 'org_one', projectId: 'project_one', name: 'Cancel', baseUrl: 'https://example.test', testIds: ['test_first', 'test_second'] });
    await store.startRun({ organizationId: 'org_one', projectId: 'project_one', runId: run.id });
    for (let i = 0; i < 100 && !store.attempts('org_one', 'project_one', 'test_first').some((item) => item.state === 'running'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.attempts('org_one', 'project_one', 'test_first')[0]?.state, 'running');
    store.cancelRun({ organizationId: 'org_one', projectId: 'project_one', runId: run.id });
    const finished = await settled(store, run.id); assert.equal(finished.state, 'canceled');
    assert.equal(store.attempts('org_one', 'project_one', 'test_first')[0].state, 'canceled');
    assert.equal(store.attempts('org_one', 'project_one', 'test_second').length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
