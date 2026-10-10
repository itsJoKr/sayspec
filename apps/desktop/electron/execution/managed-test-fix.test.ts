import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { FailureAnalysis, SavedWebTestVersion } from '@sayspec/contracts';
import { createManagedTestFixProposal, proposalContentHash } from './managed-test-fix.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const source = "import { test, expect } from '@playwright/test';\ntest('ready', async ({ page }) => {\n  await expect(page.getByText('Ready')).toBeVisible();\n});";
const file = { id: 'file_one', relativePath: 'tests/ready.spec.ts', text: source, sha256: sha(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' as const };
const version = { schemaVersion: 1, id: 'version_one', testId: 'test_one', organizationId: 'local', projectId: 'project_one', version: 1, title: 'Ready', createdAt: new Date().toISOString(), state: 'execution-validated', contentHash: 'a'.repeat(64), steps: [], files: [file], runtime: { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: file.relativePath, dependencies: { '@playwright/test': '1.63.0' }, requirements: [] }, provenance: { provider: 'codex', cliVersion: 'fixture', generatedAt: new Date().toISOString(), inputRevisionHash: 'b'.repeat(64), recordingId: 'recording_one', selectedEvidenceEventIds: [], executionValidated: true, published: false } } as SavedWebTestVersion;
const analysis = { schemaVersion: 1, id: 'analysis_one', organizationId: 'local', projectId: 'project_one', testId: 'test_one', attemptId: 'attempt_one', versionId: version.id, testVersionHash: version.contentHash, inputHash: 'c'.repeat(64), createdAt: new Date().toISOString(), status: 'complete', provider: 'codex', expected: 'Ready', actual: 'Loading', category: 'test', explanation: 'Selector changed.', limitations: 'Only one run.', nextStep: 'Review selector.', evidenceIds: ['e01'], evidence: [] } as FailureAnalysis;

test('managed proposal binds exact base and flags assertion weakening', () => {
  const proposed = source.replace("  await expect(page.getByText('Ready')).toBeVisible();", "  test.skip();");
  const result = createManagedTestFixProposal({ version, analysis, rationale: 'Investigate selector.', changes: [{ relativePath: file.relativePath, text: proposed }] });
  assert.equal(result.scope, 'managed-web-test'); assert.equal(result.fileChanges[0].baseSha256, file.sha256);
  assert.equal(result.proposalHash, proposalContentHash(result)); assert.match(result.diff, /-  await expect/);
  assert.ok(result.assertionImpact.some((item) => item.includes('removed assertions')));
  assert.ok(result.assertionImpact.some((item) => item.includes('skip')));
  assert.notEqual(proposalContentHash({ ...result, fileChanges: [{ ...result.fileChanges[0], proposedText: `${proposed} ` }] }), result.proposalHash);
  assert.throws(() => createManagedTestFixProposal({ version, analysis, rationale: 'escape', changes: [{ relativePath: '../source.ts', text: 'bad' }] }), /unsafe/);
  assert.throws(() => createManagedTestFixProposal({ version, analysis: { ...analysis, status: 'inconclusive' }, rationale: 'guess', changes: [{ relativePath: file.relativePath, text: proposed }] }), /no supported/);
  const widened = source.replace("toBeVisible()", "toBeVisible({ timeout: 90000 })").replace("  await expect", "  await expect");
  const additions = `${widened}\nimport helper from 'new-package';\nexpect(1).toBeCloseTo(2, 1);`;
  const changed = createManagedTestFixProposal({ version, analysis, rationale: 'Inspect changed threshold.', changes: [{ relativePath: file.relativePath, text: additions }] });
  assert.ok(changed.assertionImpact.some((item) => item.includes('tolerance')));
  assert.ok(changed.assertionImpact.some((item) => item.includes('new dependency')));
});
