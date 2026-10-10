import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ApplicationPatchLink } from '@sayspec/contracts';
import { SavedWebTestStore } from './saved-web-tests.ts';
import { validatePlaywrightCandidate } from '../generation/playwright-validation.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
test('patched reruns preserve failed, canceled, drifted and passing outcomes on one saved version', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-app-reruns-'));
  let count = 0;
  const validator = (async (input: Parameters<typeof validatePlaywrightCandidate>[0]) => {
    count++;
    if (count === 3) await new Promise<void>((_resolve, reject) => input.signal?.addEventListener('abort', () => reject(new Error('canceled')), { once: true }));
    const passed = count >= 4;
    return { status: passed ? 'passed' : 'failed', summary: passed ? 'passed' : 'assertion failed', detail: '', passed: passed ? 1 : 0, failed: passed ? 0 : 1, skipped: 0, tests: [{ id: 'test_one', title: 'total', outcome: passed ? 'passed' : 'failed', durationMs: 1, errors: passed ? [] : ['expected 12, got 7'] }], artifacts: [], exitCode: passed ? 0 : 1, durationMs: 1 };
  }) as typeof validatePlaywrightCandidate;
  try {
    const store = new SavedWebTestStore(root, validator); await store.initialize();
    const source = "import { test, expect } from '@playwright/test'; test('total', async ({ page }) => { await expect(page.getByText('12')).toBeVisible(); });";
    const steps = [{ id: 'step_one', instruction: 'Open cart', assertion: 'Total is 12', intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }];
    const files = [{ id: 'file_one', relativePath: 'tests/total.spec.ts', text: source, sha256: sha(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' }];
    const runtime = { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: files[0].relativePath, dependencies: { '@playwright/test': '1.63.0' }, requirements: ['Node.js >=22.12.0', 'Playwright Chromium installed'] };
    const bundle = { schemaVersion: 1, kind: 'sayspec-playwright-bundle', exportedAt: new Date().toISOString(), original: { testId: 'test_source', versionId: 'version_source', contentHash: sha(canonical({ steps, files, runtime })), state: 'execution-validated' }, title: 'Total', steps, files, runtime, secretPlaceholders: ['BASE_URL'], provenance: { provider: 'codex', cliVersion: 'fixture', inputRevisionHash: 'a'.repeat(64), generatedAt: new Date().toISOString() } };
    const version = await store.import('local', 'project_one', bundle, 'test_one');
    const input = { organizationId: 'local', projectId: 'project_one', testId: version.testId, versionId: version.id, baseUrl: 'http://127.0.0.1:4173/' };
    const original = await store.run(input); assert.equal(original.state, 'failed');
    const patch: ApplicationPatchLink = { receiptId: 'receipt_one', proposalId: 'proposal_one', proposalHash: 'b'.repeat(64), originatingAttemptId: original.id, sourceRootHash: 'c'.repeat(64), runtimeKind: 'local-web-server', runtimeHash: 'd'.repeat(64) };
    const stillFailing = await store.run(input, patch, async () => undefined); assert.equal(stillFailing.state, 'failed');
    const pending = store.run(input, patch, async () => undefined);
    for (let i = 0; i < 100; i++) { const active = store.attempts('local', 'project_one', version.testId).at(-1); if (active?.state === 'running') { store.cancel(active.id); break; } await new Promise((resolve) => setTimeout(resolve, 10)); }
    const canceled = await pending; assert.equal(canceled.state, 'canceled');
    const drifted = await store.run(input, patch, async () => { throw new Error('patched source changed during execution'); }); assert.equal(drifted.state, 'infrastructure-error'); assert.match(drifted.detail, /changed during/);
    const passing = await store.run(input, patch, async () => undefined); assert.equal(passing.state, 'passed');
    assert.equal(passing.versionId, original.versionId); assert.equal(passing.applicationPatch?.originatingAttemptId, original.id);
    const reopened = new SavedWebTestStore(root, validator); await reopened.initialize();
    assert.deepEqual(reopened.attempts('local', 'project_one', version.testId).map((item) => item.state), ['failed', 'failed', 'canceled', 'infrastructure-error', 'passed']);
    assert.equal(reopened.versions('local', 'project_one', version.testId).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
