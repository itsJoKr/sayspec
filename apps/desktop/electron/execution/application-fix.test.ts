import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FailureAnalysis } from '@sayspec/contracts';
import { DirectoryHandleRegistry } from '../jobs/directory-handles.ts';
import { ApplicationFixStore, applicationProposalHash, stageApplicationContext } from './application-fix.ts';

const analysis: FailureAnalysis = { schemaVersion: 1, id: 'analysis_one', organizationId: 'local', projectId: 'project_one', testId: 'test_one', attemptId: 'attempt_one', versionId: 'version_one', testVersionHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), createdAt: new Date().toISOString(), status: 'complete', provider: 'codex', expected: '12', actual: '7', category: 'application', explanation: 'The catalog price is wrong.', limitations: 'The source was not inspected.', nextStep: 'Review catalog price.', evidenceIds: ['e01'], evidence: [{ id: 'e01', kind: 'framework', label: 'assertion', text: 'Expected 12, actual 7' }] };

test('application proposal stages bounded source without secrets, tests or checkout writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-app-fix-'));
  try {
    const source = path.join(root, 'source'); await mkdir(path.join(source, 'lib'), { recursive: true });
    await mkdir(path.join(source, 'build')); await mkdir(path.join(source, 'patrol_test'));
    await writeFile(path.join(source, 'lib', 'catalog.dart'), 'const price = 7;\n');
    await writeFile(path.join(source, '.env'), 'API_KEY=secret');
    await writeFile(path.join(source, 'build', 'cache.json'), '{"secret":"value"}');
    await writeFile(path.join(source, 'patrol_test', 'receipt_test.dart'), 'expect(7, 12);');
    const handles = new DirectoryHandleRegistry(); const handle = await handles.register(source);
    const staged = await stageApplicationContext(handles, handle, analysis);
    assert.deepEqual(staged.files.map((item) => item.relativePath), ['lib/catalog.dart']);
    const store = new ApplicationFixStore(path.join(root, 'store')); await store.initialize();
    const proposal = await store.propose({ handles, sourceHandle: handle, analysis, target: 'flutter', stagedFiles: staged.files, changes: [{ relativePath: 'lib/catalog.dart', text: 'const price = 12;\n' }], rationale: 'Use the expected catalog price.' });
    assert.equal(proposal.fileChanges[0]?.baseText, 'const price = 7;\n');
    assert.equal(proposal.proposalHash, applicationProposalHash(proposal));
    assert.match(proposal.diff, /-const price = 7/);
    assert.equal(await readFile(path.join(source, 'lib', 'catalog.dart'), 'utf8'), 'const price = 7;\n');
    const reopened = new ApplicationFixStore(path.join(root, 'store')); await reopened.initialize();
    assert.equal(reopened.get({ organizationId: 'local', projectId: 'project_one', testId: 'test_one', proposalId: proposal.id }).proposalHash, proposal.proposalHash);
    await assert.rejects(store.propose({ handles, sourceHandle: handle, analysis, target: 'flutter', stagedFiles: staged.files, changes: [{ relativePath: 'patrol_test/receipt_test.dart', text: 'expect(12, 12);' }], rationale: 'Weaken test' }), /reviewed source context/);
    await writeFile(path.join(source, 'lib', 'catalog.dart'), 'const price = 8;\n');
    await assert.rejects(store.propose({ handles, sourceHandle: handle, analysis, target: 'flutter', stagedFiles: staged.files, changes: [{ relativePath: 'lib/catalog.dart', text: 'const price = 12;\n' }], rationale: 'Stale source' }), /changed after/);
    await writeFile(path.join(source, 'lib', 'credential.dart'), "const apiKey = 'fixture-secret-value';\n");
    assert.ok(!(await stageApplicationContext(handles, handle, analysis)).files.some((item) => item.relativePath === 'lib/credential.dart'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejected application proposal cannot be applied and a changed review diff is refused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-app-reject-'));
  try {
    const source = path.join(root, 'source'); await mkdir(source);
    await writeFile(path.join(source, 'app.js'), 'const total = 7;\n');
    const handles = new DirectoryHandleRegistry(); const sourceHandle = await handles.register(source);
    const store = new ApplicationFixStore(path.join(root, 'state')); await store.initialize();
    const stagedFiles = (await stageApplicationContext(handles, sourceHandle, analysis)).files;
    const proposal = await store.propose({ handles, sourceHandle, analysis, target: 'web', stagedFiles, changes: [{ relativePath: 'app.js', text: 'const total = 12;\n' }], rationale: 'Correct total.' });
    const scope = { organizationId: 'local', projectId: 'project_one', testId: 'test_one', proposalId: proposal.id, actorUid: 'guest', handles, sourceHandle };
    await store.decide({ ...scope, kind: 'reject' });
    await assert.rejects(store.apply(scope), /approval/);
    assert.equal(await readFile(path.join(source, 'app.js'), 'utf8'), 'const total = 7;\n');
    const dataPath = path.join(root, 'state', 'proposals.json');
    const data = JSON.parse(await readFile(dataPath, 'utf8')) as Array<{ diff: string }>;
    data[0]!.diff = 'misleading review text'; await writeFile(dataPath, JSON.stringify(data));
    const reopened = new ApplicationFixStore(path.join(root, 'state')); await reopened.initialize();
    await assert.rejects(reopened.decide({ ...scope, kind: 'approve' }), /proposal changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('application proposal rejects source traversal and symlink escape', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-app-escape-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'sayspec-app-outside-'));
  try {
    await mkdir(path.join(root, 'src')); await writeFile(path.join(outside, 'secret.ts'), 'secret');
    await symlink(path.join(outside, 'secret.ts'), path.join(root, 'src', 'secret.ts'));
    const handles = new DirectoryHandleRegistry(); const handle = await handles.register(root);
    const store = new ApplicationFixStore(path.join(root, 'state')); await store.initialize();
    const stagedFiles = [{ relativePath: 'src/secret.ts', sha256: 'a'.repeat(64) }];
    await assert.rejects(store.propose({ handles, sourceHandle: handle, analysis, target: 'web', stagedFiles, changes: [{ relativePath: 'src/secret.ts', text: 'new text' }], rationale: 'No' }), /outside|link/);
    await assert.rejects(store.propose({ handles, sourceHandle: handle, analysis, target: 'web', stagedFiles: [{ relativePath: '../secret.ts', sha256: 'a'.repeat(64) }], changes: [{ relativePath: '../secret.ts', text: 'new text' }], rationale: 'No' }), /not an application source path/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('approved application patch preserves dirty files, recovers a partial write, and is idempotent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-app-apply-'));
  try {
    const source = path.join(root, 'source'); await mkdir(path.join(source, 'src'), { recursive: true });
    await writeFile(path.join(source, 'src', 'one.ts'), 'one old\n');
    await writeFile(path.join(source, 'src', 'two.ts'), 'two old\n');
    await writeFile(path.join(source, 'src', 'unrelated.ts'), 'dirty user edit\n');
    const handles = new DirectoryHandleRegistry(); const sourceHandle = await handles.register(source);
    let inject = true;
    const store = new ApplicationFixStore(path.join(root, 'state'), { async afterWrite(count) { if (inject && count === 1) { inject = false; throw new Error('injected second-file failure'); } } }); await store.initialize();
    const stagedFiles = (await stageApplicationContext(handles, sourceHandle, analysis)).files;
    const proposal = await store.propose({ handles, sourceHandle, analysis, target: 'web', stagedFiles, changes: [{ relativePath: 'src/one.ts', text: 'one new\n' }, { relativePath: 'src/two.ts', text: 'two new\n' }], rationale: 'Correct both application calculations.' });
    const scope = { organizationId: 'local', projectId: 'project_one', testId: 'test_one', proposalId: proposal.id, actorUid: 'guest', handles, sourceHandle };
    await store.decide({ ...scope, kind: 'approve' });
    await assert.rejects(store.apply(scope), /injected second-file failure/);
    assert.equal(await readFile(path.join(source, 'src', 'one.ts'), 'utf8'), 'one old\n');
    assert.equal(await readFile(path.join(source, 'src', 'two.ts'), 'utf8'), 'two old\n');
    assert.equal(await readFile(path.join(source, 'src', 'unrelated.ts'), 'utf8'), 'dirty user edit\n');
    const receipt = await store.apply(scope);
    assert.equal(receipt.changedPaths.length, 2);
    assert.equal((await store.apply(scope)).id, receipt.id);
    assert.equal(await readFile(path.join(source, 'src', 'one.ts'), 'utf8'), 'one new\n');
    const reopened = new ApplicationFixStore(path.join(root, 'state')); await reopened.initialize();
    assert.equal(reopened.receipt(scope)?.id, receipt.id);
    assert.equal((await reopened.apply(scope)).id, receipt.id);
    await writeFile(path.join(source, 'src', 'one.ts'), 'subsequent user edit\n');
    await assert.rejects(reopened.apply(scope), /since changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recovery preserves an intervening edit and refuses altered approval or replaced checkout', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-app-conflict-'));
  try {
    const source = path.join(root, 'source'); await mkdir(path.join(source, 'src'), { recursive: true });
    await writeFile(path.join(source, 'src', 'one.ts'), 'one old\n'); await writeFile(path.join(source, 'src', 'two.ts'), 'two old\n');
    const handles = new DirectoryHandleRegistry(); const sourceHandle = await handles.register(source);
    const store = new ApplicationFixStore(path.join(root, 'state'), { async afterWrite(count) { if (count === 1) { await writeFile(path.join(source, 'src', 'one.ts'), 'external edit\n'); throw new Error('injected interruption'); } } }); await store.initialize();
    const stagedFiles = (await stageApplicationContext(handles, sourceHandle, analysis)).files;
    const proposal = await store.propose({ handles, sourceHandle, analysis, target: 'web', stagedFiles, changes: [{ relativePath: 'src/one.ts', text: 'one new\n' }, { relativePath: 'src/two.ts', text: 'two new\n' }], rationale: 'Fix application files.' });
    const scope = { organizationId: 'local', projectId: 'project_one', testId: 'test_one', proposalId: proposal.id, actorUid: 'guest', handles, sourceHandle };
    await store.decide({ ...scope, kind: 'approve' });
    await assert.rejects(store.apply(scope), /injected interruption/);
    assert.equal(await readFile(path.join(source, 'src', 'one.ts'), 'utf8'), 'external edit\n');
    assert.equal(await readFile(path.join(source, 'src', 'two.ts'), 'utf8'), 'two old\n');
    await assert.rejects(store.apply(scope), /recovery requires review/);
    const dataPath = path.join(root, 'state', 'proposals.json');
    const data = JSON.parse(await readFile(dataPath, 'utf8')) as Array<{ fileChanges: Array<{ proposedText: string }> }>;
    data[0]!.fileChanges[0]!.proposedText = 'tampered patch\n'; await writeFile(dataPath, JSON.stringify(data));
    const reopened = new ApplicationFixStore(path.join(root, 'state')); await reopened.initialize();
    await assert.rejects(reopened.apply(scope), /proposal changed/);
    await rm(source, { recursive: true }); await mkdir(path.join(source, 'src'), { recursive: true });
    await writeFile(path.join(source, 'src', 'one.ts'), 'one old\n'); await writeFile(path.join(source, 'src', 'two.ts'), 'two old\n');
    await assert.rejects(store.apply(scope), /selected checkout differs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent duplicate applications produce one receipt and a rerunnable applied state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-app-concurrent-'));
  try {
    const source = path.join(root, 'source'); await mkdir(source);
    await writeFile(path.join(source, 'app.js'), 'const total = 7;\n'); await writeFile(path.join(source, 'cart.js'), 'const tax = 0;\n');
    const handles = new DirectoryHandleRegistry(); const sourceHandle = await handles.register(source);
    const store = new ApplicationFixStore(path.join(root, 'state')); await store.initialize();
    const stagedFiles = (await stageApplicationContext(handles, sourceHandle, analysis)).files;
    const proposal = await store.propose({ handles, sourceHandle, analysis, target: 'web', stagedFiles, changes: [{ relativePath: 'app.js', text: 'const total = 12;\n' }, { relativePath: 'cart.js', text: 'const tax = 5;\n' }], rationale: 'Correct total and tax.' });
    const scope = { organizationId: 'local', projectId: 'project_one', testId: 'test_one', proposalId: proposal.id, actorUid: 'guest', handles, sourceHandle };
    await store.decide({ ...scope, kind: 'approve' });
    const receipts = await Promise.all([store.apply(scope), store.apply(scope), store.apply(scope)]);
    assert.equal(new Set(receipts.map((item) => item.id)).size, 1);
    assert.equal(store.receipt(scope)?.id, receipts[0]!.id);
    assert.equal((await store.validateApplied(scope)).receipt.id, receipts[0]!.id);
    assert.equal(await readFile(path.join(source, 'cart.js'), 'utf8'), 'const tax = 5;\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
