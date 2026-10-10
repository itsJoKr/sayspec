import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FailureAnalysis, PlaywrightGenerationDraft } from '@sayspec/contracts';
import { SavedWebTestStore } from './saved-web-tests.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const source = "import { test, expect } from '@playwright/test';\ntest('ready', async ({ page }) => {\n await expect(page.getByText('Ready')).toBeVisible();\n});";
const scope = { organizationId: 'local', projectId: 'project_one', testId: 'test_one' };
function draft(): PlaywrightGenerationDraft { return { schemaVersion: 1, id: 'generation_one', ...scope, recordingId: 'recording_one', state: 'draft', title: 'Ready',
  steps: [{ id: 'step_one', instruction: 'Open page', assertion: 'Ready visible', intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }],
  files: [{ id: 'file_one', relativePath: 'tests/ready.spec.ts', text: source, sha256: sha(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' }],
  runtime: { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: 'tests/ready.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, requirements: [] },
  provenance: { provider: 'codex', cliVersion: 'fixture', generatedAt: new Date().toISOString(), inputRevisionHash: 'a'.repeat(64), recordingId: 'recording_one', selectedEvidenceEventIds: [], executionValidated: true, published: false },
  unresolvedQuestions: [], warnings: [], validation: { status: 'passed', attempts: 1, passed: 1, failed: 0, summary: 'Prior green', validatedAt: new Date().toISOString() } }; }

test('proposal, approval, immutable apply and restart preserve the original failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-managed-fix-'));
  try {
    const store = new SavedWebTestStore(root, async () => ({ status: 'failed', passed: 0, failed: 1, summary: 'Ready missing', detail: 'Expected Ready', artifacts: [] }));
    await store.initialize(); const base = await store.saveGenerated(scope.testId, draft());
    const attempt = await store.run({ ...scope, versionId: base.id, baseUrl: 'https://example.test' });
    const analysis: FailureAnalysis = { schemaVersion: 1, id: 'analysis_one', ...scope, attemptId: attempt.id, versionId: base.id, testVersionHash: base.contentHash, inputHash: 'b'.repeat(64), createdAt: new Date().toISOString(), status: 'complete', provider: 'codex', expected: 'Ready', actual: 'Missing', category: 'test', explanation: 'Selector stale', limitations: 'One run', nextStep: 'Review selector', evidenceIds: ['e01'], evidence: [{ id: 'e01', kind: 'framework', label: 'Failure', text: 'Expected Ready' }] };
    await store.saveFailureAnalysis(analysis);
    const fixed = source.replace("getByText('Ready')", "getByRole('heading', { name: 'Ready' })");
    const proposal = await store.proposeManagedTestFix({ ...scope, analysisId: analysis.id, changes: [{ relativePath: 'tests/ready.spec.ts', text: fixed }], rationale: 'Use semantic heading.' });
    await assert.rejects(store.applyManagedTestFix({ ...scope, proposalId: proposal.id, actorUid: 'guest' }), /approval/);
    await store.decideManagedTestFix({ ...scope, proposalId: proposal.id, actorUid: 'guest', kind: 'approve' });
    await assert.rejects(store.applyManagedTestFix({ ...scope, proposalId: proposal.id, actorUid: 'forged' }), /approval/);
    const applied = await store.applyManagedTestFix({ ...scope, proposalId: proposal.id, actorUid: 'guest' });
    assert.equal(applied.version, 2); assert.equal(applied.state, 'generated'); assert.notEqual(applied.contentHash, base.contentHash);
    assert.equal((await store.applyManagedTestFix({ ...scope, proposalId: proposal.id, actorUid: 'guest' })).id, applied.id);
    await assert.rejects(store.applyManagedTestFix({ ...scope, proposalId: proposal.id, actorUid: 'forged' }), /authorized approval/);
    const stale = await store.proposeManagedTestFix({ ...scope, analysisId: analysis.id, changes: [{ relativePath: 'tests/ready.spec.ts', text: `${fixed}\n// another candidate` }], rationale: 'Another candidate.' });
    await store.decideManagedTestFix({ ...scope, proposalId: stale.id, actorUid: 'guest', kind: 'approve' });
    await assert.rejects(store.applyManagedTestFix({ ...scope, proposalId: stale.id, actorUid: 'guest' }), /changed since this proposal/);
    const rejected = await store.proposeManagedTestFix({ ...scope, analysisId: analysis.id, changes: [{ relativePath: 'tests/ready.spec.ts', text: `${fixed}\n// rejected` }], rationale: 'Reject candidate.' });
    await store.decideManagedTestFix({ ...scope, proposalId: rejected.id, actorUid: 'guest', kind: 'reject' });
    await assert.rejects(store.applyManagedTestFix({ ...scope, proposalId: rejected.id, actorUid: 'guest' }), /authorized approval/);
    const reopened = new SavedWebTestStore(root); await reopened.initialize();
    assert.equal(reopened.fixProposals(scope)[0].appliedVersionId, applied.id);
    assert.equal(reopened.version({ ...scope, versionId: base.id }).files[0].text, source);
    assert.equal(reopened.attempts(scope.organizationId, scope.projectId, scope.testId)[0].state, 'failed');
    assert.equal(reopened.failureAnalyses({ ...scope, attemptId: attempt.id })[0].id, analysis.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});
