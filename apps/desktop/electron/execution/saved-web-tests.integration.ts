import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PlaywrightGenerationDraft } from '@sayspec/contracts';
import { SavedWebTestStore, validatePortableWebTestBundle } from './saved-web-tests.ts';
import { validatePlaywrightCandidate } from '../generation/playwright-validation.ts';

const source = `import { test, expect } from '@playwright/test';
test('saved assertion', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ready', exact: true })).toBeVisible();
});`;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function draft(): PlaywrightGenerationDraft {
  return { schemaVersion: 1, id: 'generation_fixture', organizationId: 'org_local', projectId: 'project_one', recordingId: 'recording_fixture', state: 'draft', title: 'Ready heading is visible',
    steps: [{ id: 'step_ready', instruction: 'Open the page.', assertion: 'The Ready heading is visible.', intentItemIds: [], transcriptSegmentIds: ['transcript_segment_1'], evidenceEventIds: ['event_1'] }],
    files: [{ id: 'file_1', relativePath: 'tests/ready.spec.ts', text: source, sha256: hash(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' }],
    runtime: { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: 'tests/ready.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, requirements: ['Node.js >=22.12.0', '@playwright/test 1.63.0', 'Playwright Chromium installed', 'Configured Web base URL'] },
    unresolvedQuestions: [], provenance: { provider: 'codex', cliVersion: '0.144.6', generatedAt: new Date().toISOString(), inputRevisionHash: 'a'.repeat(64), recordingId: 'recording_fixture', selectedEvidenceEventIds: ['event_1'], executionValidated: true, published: false },
    warnings: [], validation: { status: 'passed', attempts: 1, passed: 1, failed: 0, summary: 'Passed locally.', validatedAt: new Date().toISOString() } };
}

test('saved source survives restart, preserves a failed attempt after passing retry, and replays an imported bundle unchanged', { timeout: 90_000 }, async () => {
  let heading = 'Ready';
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(`<h1>${heading}</h1>`); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address missing.');
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  const firstRoot = await mkdtemp(path.join(tmpdir(), 'sayspec-saved-run-'));
  const secondRoot = await mkdtemp(path.join(tmpdir(), 'sayspec-replay-'));
  try {
    let store = new SavedWebTestStore(firstRoot); await store.initialize();
    const version = await store.saveGenerated('test_saved', draft());
    const input = { organizationId: 'org_local', projectId: 'project_one', testId: version.testId, versionId: version.id, baseUrl };
    const first = await store.run(input); assert.equal(first.state, 'passed', first.detail); assert.equal(first.passed, 1);
    assert.equal(first.testVersionHash, version.contentHash);
    store = new SavedWebTestStore(firstRoot); await store.initialize();
    assert.equal(store.version(input).files[0].text, source);
    heading = 'Not ready';
    const failed = await store.run(input); assert.equal(failed.state, 'failed', failed.detail); assert.equal(failed.failed, 1);
    assert.ok(failed.artifacts.some((artifact) => artifact.relativePath === 'result.json'));
    assert.ok(failed.artifacts.some((artifact) => artifact.relativePath.endsWith('.zip')), 'Failure should retain a trace.');
    for (const artifact of failed.artifacts) {
      const bytes = await readFile(path.join(firstRoot, 'attempts', failed.id, 'artifacts', artifact.relativePath));
      assert.equal(hash(bytes), artifact.sha256, 'Artifact hash is retained.');
    }
    const trace = failed.artifacts.find((artifact) => artifact.relativePath.endsWith('.zip'))!;
    assert.equal((await store.readArtifact({ organizationId: 'org_local', projectId: 'project_one', testId: version.testId, attemptId: failed.id, relativePath: trace.relativePath })).bytes.byteLength, trace.byteLength);
    await assert.rejects(store.readArtifact({ organizationId: 'org_wrong', projectId: 'project_one', testId: version.testId, attemptId: failed.id, relativePath: trace.relativePath }), /not found/);
    heading = 'Ready';
    const retried = await store.run(input); assert.equal(retried.state, 'passed', retried.detail);
    assert.deepEqual(store.attempts('org_local', 'project_one', version.testId).map((attempt) => attempt.state), ['passed', 'failed', 'passed']);
    assert.equal(failed.testVersionHash, retried.testVersionHash);
    await assert.rejects(store.publish({ ...input, approved: false as never }), /explicit reviewer approval/);
    const published = await store.publish({ ...input, approved: true }); assert.equal(published.state, 'published');
    const bundle = store.export(input);
    assert.equal(bundle.original.state, 'published');
    assert.equal(bundle.files[0].text, source); assert.equal(bundle.secretPlaceholders[0], 'BASE_URL');
    const fresh = new SavedWebTestStore(secondRoot); await fresh.initialize();
    const preview = fresh.previewImport(bundle); assert.equal(preview.contentHash, version.contentHash);
    const imported = await fresh.import('org_other', 'project_other', bundle);
    assert.notEqual(imported.id, version.id); assert.equal(imported.state, 'generated'); assert.equal(imported.contentHash, version.contentHash);
    assert.equal(imported.files[0].text, source);
    const replay = await fresh.run({ organizationId: 'org_other', projectId: 'project_other', testId: imported.testId, versionId: imported.id, baseUrl });
    assert.equal(replay.state, 'passed', replay.detail);
    assert.equal(fresh.version({ organizationId: 'org_other', projectId: 'project_other', testId: imported.testId, versionId: imported.id }).state, 'execution-validated');
    const blocked = await fresh.run({ organizationId: 'org_other', projectId: 'project_other', testId: imported.testId, versionId: imported.id, baseUrl: '' });
    assert.equal(blocked.state, 'blocked'); assert.equal(blocked.passed, 0);
    assert.throws(() => fresh.version(input), /not found/);
    assert.throws(() => validatePortableWebTestBundle({ ...bundle, files: [{ ...bundle.files[0], relativePath: '../escape.spec.ts' }] }), /unsafe/);
    assert.throws(() => validatePortableWebTestBundle({ ...bundle, schemaVersion: 999 }), /schema/);
    assert.throws(() => validatePortableWebTestBundle({ ...bundle, files: [{ ...bundle.files[0], text: `${source}\n` }] }), /hash|size/);
    assert.throws(() => validatePortableWebTestBundle({ ...bundle, files: [{ ...bundle.files[0], linkTarget: '/etc/passwd' }] }), /unsupported fields/);
    assert.throws(() => validatePortableWebTestBundle({ ...bundle, runtime: { ...bundle.runtime, dependencies: {} } }), /dependencies/);
    assert.throws(() => validatePortableWebTestBundle({ ...bundle, extraCredentials: { password: 'should-not-survive' } }), /unsupported fields/);
    await assert.rejects(fresh.import('org_other', 'project_other', bundle, imported.testId), /cannot be overwritten/);
  } finally { await rm(firstRoot, { recursive: true, force: true }); await rm(secondRoot, { recursive: true, force: true }); server.close(); }
});

test('portable export refuses literal credentials and import refuses oversized JSON', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-portable-negative-'));
  try {
    const store = new SavedWebTestStore(root); await store.initialize();
    const unsafeSource = `${source}\nconst password = 'literal-secret';`;
    const base = draft();
    const unsafe: PlaywrightGenerationDraft = { ...base, files: [{ ...base.files[0], text: unsafeSource, sha256: hash(unsafeSource), byteLength: Buffer.byteLength(unsafeSource) }] };
    const version = await store.saveGenerated('test_unsafe', unsafe);
    assert.throws(() => store.export({ organizationId: 'org_local', projectId: 'project_one', testId: version.testId, versionId: version.id }), /credential/);
    assert.throws(() => validatePortableWebTestBundle({ schemaVersion: 1, kind: 'sayspec-playwright-bundle', extra: 'x'.repeat(1024 * 1024) }), /1 MiB budget/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('skips cannot pass, cancellation is retained, and restart reconciles interrupted attempts without replay', { timeout: 45_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-attempt-states-'));
  try {
    const skippedSource = "import { test, expect } from '@playwright/test'; test.skip('skipped', async () => { expect(true).toBe(true); });";
    const skipped = await validatePlaywrightCandidate({ files: [{ id: 'file_skip', relativePath: 'tests/skip.spec.ts', text: skippedSource, sha256: hash(skippedSource), byteLength: Buffer.byteLength(skippedSource), mimeType: 'text/typescript' }], entrypoint: 'tests/skip.spec.ts', baseUrl: 'http://127.0.0.1:1/' });
    assert.equal(skipped.status, 'skipped'); assert.equal(skipped.passed, 0);
    const store = new SavedWebTestStore(root); await store.initialize();
    const waitingSource = "import { test, expect } from '@playwright/test'; test('wait', async ({ page }) => { await page.waitForTimeout(60000); expect(true).toBe(true); });";
    const baseCandidate = draft();
    const candidate: PlaywrightGenerationDraft = { ...baseCandidate, files: [{ ...baseCandidate.files[0], text: waitingSource, sha256: hash(waitingSource), byteLength: Buffer.byteLength(waitingSource) }] };
    const version = await store.saveGenerated('test_waiting', candidate);
    const pending = store.run({ organizationId: 'org_local', projectId: 'project_one', testId: version.testId, versionId: version.id, baseUrl: 'http://127.0.0.1:1/' });
    let active: ReturnType<typeof store.attempts>[number] | undefined;
    for (let count = 0; count < 100; count++) {
      active = store.attempts('org_local', 'project_one', version.testId).find((attempt) => attempt.state === 'running');
      if (active) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(active); store.cancel(active.id);
    const canceled = await pending; assert.equal(canceled.state, 'canceled'); assert.equal(canceled.passed, 0);
    const indexPath = path.join(root, 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    index.attempts.push({ ...canceled, id: 'attempt_22222222-2222-4222-8222-222222222222', state: 'running', finishedAt: undefined, summary: 'Running before crash.' });
    await writeFile(indexPath, JSON.stringify(index));
    const reopened = new SavedWebTestStore(root); await reopened.initialize();
    const recovered = reopened.attempts('org_local', 'project_one', version.testId).at(-1)!;
    assert.equal(recovered.state, 'infrastructure-error'); assert.match(recovered.summary, /stopped before a final result/);
    assert.equal(reopened.attempts('org_local', 'project_one', version.testId)[0].state, 'canceled');
  } finally { await rm(root, { recursive: true, force: true }); }
});
