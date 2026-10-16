import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FailureAnalysis, ManagedTestFixProposal, PatrolAttempt, PatrolSavedTest } from '@sayspec/contracts';
import { CodingAgentAdapters } from '../coding-agent/adapters.ts';
import { proposalContentHash } from '../execution/managed-test-fix.ts';
import { ManagedTestFixSessionManager } from '../execution/managed-test-fix-session.ts';
import { SavedWebTestStore } from '../execution/saved-web-tests.ts';
import { ProjectAgentWorkspaceManager } from '../coding-agent/project-agent-workspace.ts';
import { parseRunIssues, PatrolRunAnalysisManager } from './patrol-run-analysis.ts';
import { PatrolRunStore } from './patrol-store.ts';
import { createPatrolTestFixProposal, patrolTestFixSubject } from './patrol-test-fix.ts';

const source = (finder: string) => `import 'package:patrol/patrol.dart';\nimport 'package:flutter_test/flutter_test.dart';\n\nvoid main() {\n  patrolTest('cart total', ($) async {\n    await $(#${finder}).tap();\n    expect($('Total: $12'), findsOneWidget);\n  });\n}\n`;
const scope = { organizationId: 'local', projectId: 'project_one' };

function failedAttempt(test: PatrolSavedTest, overrides: Partial<PatrolAttempt> = {}): PatrolAttempt {
  return { schemaVersion: 1, id: 'patrol_attempt_one', testId: test.id, versionId: test.versionId, ...scope, testContentHash: test.contentHash, runtime: { deviceId: 'emulator-5554', deviceName: 'Slim', platform: 'android', entrypoint: test.relativePath, testFileHashes: { [test.relativePath]: test.contentHash }, environmentHash: 'e'.repeat(64) } as unknown as PatrolAttempt['runtime'], state: 'failed', deviceId: 'emulator-5554', leaseId: 'lease_one', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: '0 passed, 1 failed', detail: 'Finder #addToCart found no widget', passed: 0, failed: 1, skipped: 0, tests: [{ title: 'cart total', outcome: 'failed', durationMs: 900, errors: ['Finder #addToCart found no widget'] }] as unknown as PatrolAttempt['tests'], artifacts: [], runner: 'desktop-local-patrol', ...overrides };
}

function testAnalysis(test: PatrolSavedTest, attemptId: string, overrides: Partial<FailureAnalysis> = {}): FailureAnalysis {
  return { schemaVersion: 1, id: 'analysis_one', ...scope, testId: test.id, attemptId, versionId: test.versionId, testVersionHash: test.contentHash, inputHash: 'c'.repeat(64), createdAt: new Date().toISOString(), status: 'complete', provider: 'claude-code', expected: 'Total $12', actual: 'No add button', category: 'test', explanation: 'The button key changed.', limitations: 'One run.', nextStep: 'Use #addItem.', evidenceIds: ['e01'], evidence: [{ id: 'e01', kind: 'log', label: 'Issue', text: 'Finder #addToCart found no widget' }], ...overrides };
}

async function savedTest(store: PatrolRunStore, finder = 'addToCart') {
  return store.saveTest({ ...scope, title: 'Cart total', relativePath: 'patrol_test/cart_test.dart', source: source(finder), recordingCaptureId: 'flutter_capture_one', state: 'published' });
}

test('a Patrol test-fix proposal replaces only the saved file and flags weakened checks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-fix-'));
  try {
    const store = new PatrolRunStore(root); await store.initialize();
    const version = await savedTest(store);
    const analysis = testAnalysis(version, 'patrol_attempt_one');
    const fixed = source('addItem');
    const proposal = createPatrolTestFixProposal({ version, analysis, rationale: 'The button key is now addItem.', changes: [{ relativePath: version.relativePath, text: fixed }] });
    assert.equal(proposal.scope, 'managed-patrol-test'); assert.equal(proposal.baseVersionId, version.versionId); assert.equal(proposal.baseContentHash, version.contentHash);
    assert.equal(proposal.proposalHash, proposalContentHash(proposal)); assert.match(proposal.diff, /-    await \$\(#addToCart\)\.tap\(\);/);
    assert.deepEqual(proposal.assertionImpact, ['No assertion weakening pattern detected; reviewer must still inspect the diff.']);

    const weakened = fixed.replace("    expect($('Total: $12'), findsOneWidget);\n", '').replace("patrolTest('cart total',", "patrolTest('cart total', skip: true,").replace("import 'package:flutter_test/flutter_test.dart';", "import 'package:flutter_test/flutter_test.dart';\nimport 'package:mocktail/mocktail.dart';").replace('.tap();', '.tap();\n    await Future.delayed(const Duration(seconds: 20));');
    const flagged = createPatrolTestFixProposal({ version, analysis, rationale: 'Loosen.', changes: [{ relativePath: version.relativePath, text: weakened }] });
    for (const flag of ['removed assertions', 'introduced a skip', 'wait or timeout', 'new import package:mocktail/mocktail.dart']) assert.ok(flagged.assertionImpact.some((item) => item.includes(flag)), flag);

    assert.throws(() => createPatrolTestFixProposal({ version, analysis, rationale: 'Helper.', changes: [{ relativePath: 'patrol_test/robots/cart_robot.dart', text: fixed }] }), /Only the saved test file/);
    assert.throws(() => createPatrolTestFixProposal({ version, analysis, rationale: 'Two.', changes: [{ relativePath: version.relativePath, text: fixed }, { relativePath: version.relativePath, text: fixed }] }), /exactly one file/);
    assert.throws(() => createPatrolTestFixProposal({ version, analysis, rationale: 'Same.', changes: [{ relativePath: version.relativePath, text: version.source }] }), /does not change/);
    assert.throws(() => createPatrolTestFixProposal({ version, analysis, rationale: 'Plain Dart.', changes: [{ relativePath: version.relativePath, text: 'void main() {}' }] }), /not a Patrol test/);
    assert.throws(() => createPatrolTestFixProposal({ version, analysis: testAnalysis(version, 'patrol_attempt_one', { category: 'application' }), rationale: 'App.', changes: [{ relativePath: version.relativePath, text: fixed }] }), /no supported Patrol test-fix analysis/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an approved Patrol test fix becomes the next version once, and only on the reviewed base', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-fix-store-'));
  try {
    const store = new PatrolRunStore(root); await store.initialize();
    const version = await savedTest(store);
    const attempt = await store.recordAttempt(failedAttempt(version));
    const analysis = await store.saveFailureAnalysis(testAnalysis(version, attempt.id));
    const change = { relativePath: version.relativePath, text: source('addItem') };
    const proposal = await store.proposeTestFix({ ...scope, testId: version.id, analysisId: analysis.id, rationale: 'Key changed.', changes: [change] });
    await assert.rejects(store.applyTestFix({ ...scope, testId: version.id, proposalId: proposal.id, actorUid: 'guest' }), /approval is required/);
    await assert.rejects(store.decideTestFix({ ...scope, testId: 'patrol_test_other', proposalId: proposal.id, actorUid: 'guest', kind: 'approve' }), /not found/);
    await store.decideTestFix({ ...scope, testId: version.id, proposalId: proposal.id, actorUid: 'guest', kind: 'approve' });
    await assert.rejects(store.applyTestFix({ ...scope, testId: version.id, proposalId: proposal.id, actorUid: 'someone_else' }), /approval is required/);
    const next = await store.applyTestFix({ ...scope, testId: version.id, proposalId: proposal.id, actorUid: 'guest' });
    assert.equal(next.id, version.id); assert.equal(next.version, 2); assert.equal(next.source, change.text); assert.equal(next.state, 'generated');
    assert.equal(next.recordingCaptureId, 'flutter_capture_one');
    assert.equal((await store.applyTestFix({ ...scope, testId: version.id, proposalId: proposal.id, actorUid: 'guest' })).versionId, next.versionId, 'applying again returns the same version');
    assert.equal(store.test(version.id, version.versionId).source, version.source, 'the failed version is unchanged');

    // A second proposal against the old base cannot overwrite the newer version.
    const stale = await store.proposeTestFix({ ...scope, testId: version.id, analysisId: analysis.id, rationale: 'Other key.', changes: [{ relativePath: version.relativePath, text: source('addOther') }] });
    await store.decideTestFix({ ...scope, testId: version.id, proposalId: stale.id, actorUid: 'guest', kind: 'approve' });
    await assert.rejects(store.applyTestFix({ ...scope, testId: version.id, proposalId: stale.id, actorUid: 'guest' }), /changed since this proposal/);

    const reopened = new PatrolRunStore(root); await reopened.initialize();
    assert.deepEqual(reopened.testFixProposals({ ...scope, testId: version.id }).map((item) => item.status).sort(), ['applied', 'approved']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('analysis.json issues are clipped, verdict-checked and matched only to the run\'s own tests', () => {
  const items = [
    { testId: 'patrol_test_cart', title: 'Cart total', relativePath: 'patrol_test/cart_test.dart', aliases: ['cart total shows the sum'] },
    { testId: 'patrol_test_login', title: 'Login', relativePath: 'patrol_test/login_test.dart' },
  ];
  const issues = parseRunIssues(JSON.stringify({ schema: 1, issues: [
    { id: 'i1', tests: ['cart total shows the sum'], testFile: null, verdict: 'app-bug', summary: '  Total is off by the delivery fee. ', expected: '$12', actual: '$7', evidence: ['E/flutter: Total: $7', 42], nextStep: 'Fix lib/cart.dart.' },
    { id: 'i1', tests: ['Unknown test'], testFile: 'patrol_test/login_test.dart', verdict: 'bad-test', summary: 'Login button key changed.', nextStep: 'Use #signIn.' },
    { id: '../escape', tests: ['Other project test'], verdict: 'catastrophe', summary: 'x'.repeat(5000) },
    { tests: ['Cart total'], verdict: 'flaky' },
    'not an issue',
  ] }), items);
  assert.equal(issues.length, 3);
  assert.deepEqual(issues[0], { id: 'i1', verdict: 'app-bug', summary: 'Total is off by the delivery fee.', nextStep: 'Fix lib/cart.dart.', testIds: ['patrol_test_cart'], expected: '$12', actual: '$7', evidence: ['E/flutter: Total: $7'] });
  assert.equal(issues[1].id, 'i1-2'); assert.deepEqual(issues[1].testIds, ['patrol_test_login']);
  assert.equal(issues[2].id, 'i3'); assert.equal(issues[2].verdict, 'unclear'); assert.deepEqual(issues[2].testIds, []); assert.equal(issues[2].summary.length, 1000);
  assert.throws(() => parseRunIssues('{"schema":1}', items), /no issues/);
});

test('a run issue becomes a reusable fix target for the test\'s failed attempt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-issue-fix-'));
  try {
    const store = new PatrolRunStore(root); await store.initialize();
    const version = await savedTest(store);
    const run = await store.createRun({ ...scope, testIds: [version.id], name: 'Nightly' });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    await store.recordAttempt(failedAttempt(version, { runId: run.id, startedAt }));
    const issues = [
      { id: 'i1', verdict: 'bad-test' as const, summary: 'The add button key changed.', nextStep: 'Use #addItem.', testIds: [version.id], expected: 'Tap #addToCart', actual: 'No widget', evidence: ['Finder #addToCart found no widget'] },
      { id: 'i2', verdict: 'flaky' as const, summary: 'Animation timing.', nextStep: 'Rerun.', testIds: [version.id], evidence: [] },
    ];
    await store.updateRun(run.id, { state: 'finished', startedAt, finishedAt: new Date().toISOString(), analysis: { state: 'ready', provider: 'claude-code', startedAt, issues } });
    const manager = new PatrolRunAnalysisManager({ root: path.join(root, 'analysis'), store, adapters: new CodingAgentAdapters(), provider: () => 'claude-code', emit: () => undefined, open: async () => undefined });
    const request = { ...scope, runId: run.id, issueId: 'i1', testId: version.id };
    const { attempt, analysis } = await manager.prepareFix(request);
    assert.equal(attempt.id, 'patrol_attempt_one'); assert.equal(analysis.category, 'test'); assert.equal(analysis.status, 'complete');
    assert.equal(analysis.versionId, version.versionId); assert.equal(analysis.expected, 'Tap #addToCart');
    assert.match(analysis.evidence[0]!.text, /add button key changed[\s\S]*Finder #addToCart found no widget/);
    assert.deepEqual(analysis.evidenceIds, analysis.evidence.map((entry) => entry.id));
    assert.equal((await manager.prepareFix(request)).analysis.id, analysis.id, 'preparing the same fix again reuses the analysis');
    await assert.rejects(manager.prepareFix({ ...request, issueId: 'i2' }), /Only app bugs and test bugs/);
    await assert.rejects(manager.prepareFix({ ...request, testId: 'patrol_test_other' }), /not part of this issue/);

    // A test-fix session accepts the prepared analysis as is.
    const proposal = await store.proposeTestFix({ ...scope, testId: version.id, analysisId: analysis.id, rationale: 'Key changed.', changes: [{ relativePath: version.relativePath, text: source('addItem') }] });
    assert.equal(proposal.attemptId, attempt.id);

    // Reports written before issues were read get them when SaySpec starts.
    await store.updateRun(run.id, { analysis: { state: 'ready', provider: 'claude-code', startedAt } });
    await mkdir(path.join(root, 'analysis', run.id), { recursive: true });
    await writeFile(path.join(root, 'analysis', run.id, 'analysis.json'), JSON.stringify({ schema: 1, issues: [{ id: 'i9', tests: ['Cart total'], verdict: 'app-bug', summary: 'Wrong total.', nextStep: 'Fix it.' }] }));
    await new PatrolRunAnalysisManager({ root: path.join(root, 'analysis'), store, adapters: new CodingAgentAdapters(), provider: () => 'claude-code', emit: () => undefined, open: async () => undefined }).initialize();
    assert.deepEqual(store.run({ ...scope, runId: run.id }).analysis?.issues?.map((issue) => [issue.id, issue.testIds]), [['i9', [version.id]]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a Patrol test-fix session stages the failed test, reads the app and records the agent\'s proposal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-fix-session-'));
  const project = path.join(root, 'flutter_app'); const executable = path.join(root, 'fake-claude');
  const store = new PatrolRunStore(path.join(root, 'patrol')); await store.initialize();
  const webTests = new SavedWebTestStore(path.join(root, 'web')); await webTests.initialize();
  const version = await savedTest(store);
  const attempt = await store.recordAttempt(failedAttempt(version));
  const analysis = await store.saveFailureAnalysis(testAnalysis(version, attempt.id));
  await mkdir(project);
  await writeFile(path.join(root, 'proposal.json'), JSON.stringify({ rationale: 'The add button key is now addItem.', changes: [{ relativePath: version.relativePath, text: source('addItem') }] }));
  // Stands in for Claude Code: shows what it was given, then proposes the fix and reads SaySpec's answer.
  await writeFile(executable, [
    '#!/bin/sh',
    'printf "ARGS:%s\\n" "$*"',
    'printf "SKILL:%s\\n" "$(head -2 "$TMPDIR/.claude/skills/fix-managed-patrol-test/SKILL.md" | tail -1)"',
    'printf "BASE:%s\\n" "$(grep -c addToCart "$TMPDIR/base/patrol_test/cart_test.dart")"',
    'printf "RUN:%s\\n" "$(tr -d \'\\n \' < "$TMPDIR/run.json")"',
    `cp ${JSON.stringify(path.join(root, 'proposal.json'))} "$TMPDIR/proposal.json"`,
    'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -f "$TMPDIR/proposal-result.json" ] && break; /bin/sleep 0.2; done',
    'printf "RESULT:%s\\n" "$(cat "$TMPDIR/proposal-result.json")"',
    '/bin/sleep 0.2',
  ].join('\n'));
  await chmod(executable, 0o700);
  let output = ''; const proposals: ManagedTestFixProposal[] = [];
  let finish!: () => void; const exited = new Promise<void>((resolve) => { finish = resolve; });
  const manager = new ManagedTestFixSessionManager(new ProjectAgentWorkspaceManager(path.join(root, 'work'), webTests, store), webTests, new CodingAgentAdapters({ candidates: { 'claude-code': [executable] } }),
    (event) => { if (event.kind === 'data') output += event.data ?? ''; if (event.kind === 'proposal' && event.proposal) proposals.push(event.proposal); if (event.kind === 'exit') finish(); }, patrolTestFixSubject(store));
  try {
    const fixScope = { ...scope, testId: version.id, attemptId: attempt.id, analysisId: analysis.id };
    await assert.rejects(manager.start(fixScope, 'claude-code', 100, 28), /failed attempt was not found/, 'a Patrol attempt is not a Web test');
    await manager.start(fixScope, 'claude-code', 100, 28, { kind: 'patrol', readDirectory: project });
    await Promise.race([exited, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(`fake fix session did not exit:\n${output}`)), 15_000); timer.unref(); })]);
    const flat = output.replace(/\r?\n/g, '');
    assert.match(flat, /--add-dir/); assert.ok(flat.includes(project), 'the agent may read the Flutter project');
    assert.match(output, /SKILL:name: fix-managed-patrol-test/);
    assert.match(output, /BASE:1/);
    assert.ok(flat.includes(`"testFile":"${version.relativePath}"`) && flat.includes(`"projectDirectory":"${project}"`), flat);
    assert.match(flat, /RESULT:\{"status":"recorded"/);
    assert.equal(proposals.length, 1); assert.equal(proposals[0]!.scope, 'managed-patrol-test'); assert.equal(proposals[0]!.attemptId, attempt.id);
    assert.deepEqual(store.testFixProposals({ ...scope, testId: version.id }).map((item) => item.id), [proposals[0]!.id]);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});
