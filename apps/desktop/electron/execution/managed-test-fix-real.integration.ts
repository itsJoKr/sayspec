import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FailureAnalysis, PlaywrightGenerationDraft } from '@sayspec/contracts';
import { CodingAgentAdapters } from '../coding-agent/adapters.ts';
import { SavedWebTestStore } from './saved-web-tests.ts';
import { ManagedTestFixSessionManager } from './managed-test-fix-session.ts';
import { ProjectAgentWorkspaceManager } from '../coding-agent/project-agent-workspace.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
test('real Claude PTY creates a staged proposal without editing saved source', { skip: process.env.SAYSPEC_REAL_FIX !== '1', timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-real-fix-'));
  let manager: ManagedTestFixSessionManager | undefined;
  try {
    const scope = { organizationId: 'local', projectId: 'project_one', testId: 'test_one' };
    const source = "import { test, expect } from '@playwright/test';\ntest('ready heading', async ({ page }) => {\n  await page.goto('/');\n  await expect(page.getByRole('heading', { name: 'Old', exact: true })).toBeVisible();\n});";
    const draft: PlaywrightGenerationDraft = { schemaVersion: 1, id: 'generation_one', ...scope, recordingId: 'recording_one', state: 'draft', title: 'Ready heading', steps: [{ id: 'step_one', instruction: 'Open page', assertion: 'Old heading visible', intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }],
      files: [{ id: 'file_one', relativePath: 'tests/ready.spec.ts', text: source, sha256: sha(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' }], runtime: { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: 'tests/ready.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, requirements: ['Node.js >=22.12.0', 'Playwright Chromium installed'] },
      provenance: { provider: 'claude-code', cliVersion: 'fixture', generatedAt: new Date().toISOString(), inputRevisionHash: 'a'.repeat(64), recordingId: 'recording_one', selectedEvidenceEventIds: [], executionValidated: true, published: false }, unresolvedQuestions: [], warnings: [], validation: { status: 'passed', attempts: 1, passed: 1, failed: 0, summary: 'Earlier green', validatedAt: new Date().toISOString() } };
    const store = new SavedWebTestStore(path.join(root, 'store'), async () => ({ status: 'failed', passed: 0, failed: 1, summary: 'Old heading missing; Ready heading rendered.', detail: 'Expected Old heading, found Ready heading', artifacts: [] }));
    await store.initialize(); const version = await store.saveGenerated(scope.testId, draft);
    const attempt = await store.run({ ...scope, versionId: version.id, baseUrl: 'https://example.test' });
    const analysis: FailureAnalysis = { schemaVersion: 1, id: 'analysis_one', ...scope, attemptId: attempt.id, versionId: version.id, testVersionHash: version.contentHash, inputHash: 'b'.repeat(64), createdAt: new Date().toISOString(), status: 'complete', provider: 'claude-code', expected: 'Old heading', actual: 'Ready heading', category: 'test', explanation: 'The saved selector uses the old heading label; the current page evidence shows Ready.', limitations: 'Only this attempt.', nextStep: 'Review a selector update.', evidenceIds: ['e01'], evidence: [{ id: 'e01', kind: 'framework', label: 'Framework result', text: 'Expected Old heading, found Ready heading.' }] };
    await store.saveFailureAnalysis(analysis);
    const events: string[] = [];
    manager = new ManagedTestFixSessionManager(new ProjectAgentWorkspaceManager(path.join(root, 'work'), store), store, new CodingAgentAdapters(), (event) => { if (event.kind === 'data') events.push(event.data ?? ''); if (event.kind === 'error') events.push(`ERROR:${event.data}`); });
    const started = await manager.start({ ...scope, attemptId: attempt.id, analysisId: analysis.id }, 'claude-code');
    const deadline = Date.now() + 110_000;
    let trusted = false;
    while (Date.now() < deadline && !store.fixProposals(scope).length && !events.join('').includes('ERROR:')) {
      const output = events.join('');
      if (!trusted && output.includes('Yes') && output.includes('trust') && output.includes('folder')) { manager.write(attempt.id, started.sessionToken, '\x1b[B\r'); trusted = true; }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await manager.close(attempt.id, started.sessionToken);
    const proposals = store.fixProposals(scope);
    const readable = events.join('').replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[78])/g, '').replace(/[\r\n ]+/g, ' ');
    assert.equal(proposals.length, 1, `Claude did not submit a valid proposal: ${readable.slice(0, 7000)} … ${readable.slice(-2500)}`);
    assert.equal(store.version({ ...scope, versionId: version.id }).files[0].text, source);
    assert.match(proposals[0].diff, /Old/);
    console.log(`REAL_FIX_RESULT=${JSON.stringify({ proposalId: proposals[0].id, proposalHash: proposals[0].proposalHash, impact: proposals[0].assertionImpact, savedSourceUnchanged: true })}`);
  } finally { await manager?.shutdown(); await rm(root, { recursive: true, force: true }); }
});
