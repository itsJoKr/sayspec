import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PlaywrightGenerationDraft } from '@sayspec/contracts';
import { agentSandboxProfile, ProjectAgentWorkspaceManager } from './coding-agent/project-agent-workspace.ts';
import { SavedWebTestStore } from './execution/saved-web-tests.ts';
import { PatrolRunStore } from './flutter/patrol-store.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function draft(source: string): PlaywrightGenerationDraft {
  return {
    schemaVersion: 1, id: 'generation_workspace', organizationId: 'local', projectId: 'project_one', recordingId: 'recording_one', state: 'draft', title: 'Shared project test',
    steps: [{ id: 'step_one', instruction: 'Open the page', assertion: 'Ready is visible', intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }],
    files: [{ id: 'file_one', relativePath: 'tests/ready.spec.ts', text: source, sha256: sha(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' }],
    runtime: { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: 'tests/ready.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, requirements: [] },
    provenance: { provider: 'codex', cliVersion: 'fixture', generatedAt: new Date().toISOString(), inputRevisionHash: 'a'.repeat(64), recordingId: 'recording_one', selectedEvidenceEventIds: [], executionValidated: true, published: false },
    unresolvedQuestions: [], warnings: [], validation: { status: 'passed', attempts: 1, passed: 1, failed: 0, summary: 'Passed', validatedAt: new Date().toISOString() },
  };
}

test('coding agents reuse a project root with all latest tests and disposable writable sessions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-agent-workspace-'));
  try {
    const store = new SavedWebTestStore(path.join(root, 'store')); await store.initialize();
    const patrol = new PatrolRunStore(path.join(root, 'patrol')); await patrol.initialize();
    const original = "import { test } from '@playwright/test';\ntest('ready', async () => {});";
    await store.saveGenerated('test_one', draft(original));
    await patrol.saveTest({ projectId: 'project_one', organizationId: 'local', title: 'Receipt total', relativePath: 'patrol_test/receipt_test.dart', source: "// SAYSPEC_GENERATED\nimport 'package:patrol/patrol.dart';\nvoid main(){ patrolTest('receipt', ($) async {}); }" });
    const workspaces = new ProjectAgentWorkspaceManager(path.join(root, 'workspaces'), store, patrol);
    const first = await workspaces.open({ organizationId: 'local', projectId: 'project_one' }, 'generation', 'recording_one');
    assert.equal(await readFile(path.join(first.rootDirectory, 'tests', 'test_one', 'tests', 'ready.spec.ts'), 'utf8'), original);
    assert.match(await readFile(path.join(first.rootDirectory, 'tests', `patrol-${patrol.listTests('project_one', 'local')[0].id}`, 'patrol_test', 'receipt_test.dart'), 'utf8'), /patrolTest/);
    await assert.rejects(workspaces.open({ organizationId: 'local', projectId: 'project_one' }, 'fix', 'attempt_one'), /already using/);
    await workspaces.release(first);
    await assert.rejects(access(first.directory));
    const second = await workspaces.open({ organizationId: 'local', projectId: 'project_one' }, 'fix', 'attempt_one');
    assert.equal(second.rootDirectory, first.rootDirectory);
    assert.notEqual(second.directory, first.directory);
    assert.equal(JSON.parse(await readFile(path.join(second.rootDirectory, 'tests', 'index.json'), 'utf8')).tests.length, 2);
    await workspaces.release(second);
    const other = await workspaces.open({ organizationId: 'local', projectId: 'project_two' }, 'generation', 'recording_two');
    assert.notEqual(other.rootDirectory, first.rootDirectory);
    assert.equal(JSON.parse(await readFile(path.join(other.rootDirectory, 'tests', 'index.json'), 'utf8')).tests.length, 0);
    await workspaces.release(other);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('agent sandbox profiles preserve provider trust state without making the project root writable', () => {
  const session = path.join(tmpdir(), 'sayspec-session');
  const project = path.dirname(path.dirname(session));
  for (const provider of ['claude-code', 'codex'] as const) {
    const profile = agentSandboxProfile(session, provider);
    assert.match(profile, /\(deny file-write\*\)/);
    assert.ok(profile.includes(`(subpath ${JSON.stringify(session)})`));
    assert.ok(!profile.includes(`(subpath ${JSON.stringify(project)})`));
    assert.match(profile, provider === 'claude-code' ? /\.claude/ : /\.codex/);
  }
});
