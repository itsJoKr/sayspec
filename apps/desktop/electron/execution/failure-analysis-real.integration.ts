import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PlaywrightGenerationDraft } from '@sayspec/contracts';
import { CodingAgentAdapters } from '../coding-agent/adapters.ts';
import { FailureAnalysisManager } from './failure-analysis.ts';
import { SavedWebTestStore } from './saved-web-tests.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function draft(source: string): PlaywrightGenerationDraft {
  return { schemaVersion: 1, id: 'generation_one', organizationId: 'org_one', projectId: 'project_one', recordingId: 'recording_one', state: 'draft', title: 'Heading',
    steps: [{ id: 'step_one', instruction: 'Open page', assertion: 'Ready heading is visible', intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }],
    files: [{ id: 'file_one', relativePath: 'tests/heading.spec.ts', text: source, sha256: hash(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' }],
    runtime: { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: 'tests/heading.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, requirements: ['Node.js >=22.12.0', 'Playwright Chromium installed'] },
    unresolvedQuestions: [], provenance: { provider: 'codex', cliVersion: '0.144.6', generatedAt: new Date().toISOString(), inputRevisionHash: 'a'.repeat(64), recordingId: 'recording_one', selectedEvidenceEventIds: [], executionValidated: true, published: false },
    warnings: [], validation: { status: 'passed', attempts: 1, passed: 1, failed: 0, summary: 'Earlier green', validatedAt: new Date().toISOString() } };
}
test('real Chromium failed attempt receives real configured Codex explanation and reopens unchanged', { skip: process.env.SAYSPEC_REAL_ANALYSIS !== '1', timeout: 240_000 }, async () => {
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<h1>Loading</h1>'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server missing.');
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-analysis-real-'));
  try {
    const store = new SavedWebTestStore(root); await store.initialize();
    const source = "import { test, expect } from '@playwright/test'; test('ready heading', async ({ page }) => { await page.goto('/'); await expect(page.getByRole('heading', { name: 'Ready' })).toBeVisible(); });";
    const version = await store.saveGenerated('test_one', draft(source));
    const attempt = await store.run({ organizationId: 'org_one', projectId: 'project_one', testId: 'test_one', versionId: version.id, baseUrl: `http://127.0.0.1:${address.port}/` });
    assert.equal(attempt.state, 'failed', attempt.detail); assert.ok(attempt.artifacts.some((item) => item.relativePath.endsWith('.zip')));
    const manager = new FailureAnalysisManager(store, new CodingAgentAdapters());
    const scope = { organizationId: 'org_one', projectId: 'project_one', testId: 'test_one', attemptId: attempt.id };
    const analysis = await manager.analyze({ ...scope, provider: 'codex' });
    assert.ok(['complete', 'inconclusive'].includes(analysis.status), analysis.limitations); assert.ok(analysis.evidenceIds.length);
    assert.ok(analysis.evidenceIds.every((id) => analysis.evidence.some((item) => item.id === id)));
    assert.equal(analysis.provider, 'codex'); assert.equal(analysis.cliVersion, '0.144.6');
    const reopened = new SavedWebTestStore(root); await reopened.initialize();
    assert.equal(reopened.attempts('org_one', 'project_one', 'test_one')[0].state, 'failed');
    assert.equal(reopened.failureAnalyses(scope)[0].inputHash, analysis.inputHash);
    const offline = await store.run({ organizationId: 'org_one', projectId: 'project_one', testId: 'test_one', versionId: version.id, baseUrl: 'http://127.0.0.1:9/' });
    assert.equal(offline.state, 'failed', offline.detail);
    assert.match(offline.detail, /ERR_UNSAFE_PORT|ERR_CONNECTION_REFUSED/);
    const offlineAnalysis = await manager.analyze({ ...scope, attemptId: offline.id, provider: 'codex' });
    assert.ok(['complete', 'inconclusive'].includes(offlineAnalysis.status), offlineAnalysis.limitations);
    assert.equal(offlineAnalysis.attemptId, offline.id);
    assert.notEqual(offlineAnalysis.inputHash, analysis.inputHash);
    console.log(`REAL_ANALYSIS_RESULT=${JSON.stringify({ state: attempt.state, artifactCount: attempt.artifacts.length, analysisStatus: analysis.status, category: analysis.category, evidenceIds: analysis.evidenceIds, provider: analysis.provider, cliVersion: analysis.cliVersion, inputHash: analysis.inputHash, environmentFailure: offline.state, environmentAnalysis: offlineAnalysis.status, environmentCategory: offlineAnalysis.category })}`);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});
