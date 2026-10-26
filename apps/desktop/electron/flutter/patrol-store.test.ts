import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PatrolRunConsoleEvent } from '@sayspec/contracts';
import { PatrolRunStore } from './patrol-store.ts';
import { assertSafeTestPath, PatrolRunner, readStoredTest } from './patrol-runner.ts';
import { FailureAnalysisManager } from '../execution/failure-analysis.ts';
import { serializeTestFile } from '../test-storage/test-file-format.ts';

const source = (title: string) => `// SAYSPEC_GENERATED\nimport 'package:patrol/patrol.dart';\nvoid main(){ patrolTest('${title}', (\$) async {}); }\n`;

test('Patrol publication appends immutable versions and reopens exact source and attempts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-store-'));
  try {
    const store = new PatrolRunStore(root); await store.initialize();
    const first = await store.saveTest({ projectId: 'project_one', organizationId: 'local', title: 'Receipt', relativePath: 'patrol_test/receipt_test.dart', source: source('v1'), recordingCaptureId: 'flutter_capture_one', dependencies: { patrol: '4.10.0' }, state: 'published' });
    const second = await store.saveTest({ testId: first.id, projectId: 'project_one', organizationId: 'local', title: 'Receipt', relativePath: 'patrol_test/receipt_test.dart', source: source('v2'), recordingCaptureId: 'flutter_capture_one', dependencies: { patrol: '4.10.0' }, state: 'published' });
    assert.equal(second.id, first.id); assert.notEqual(second.versionId, first.versionId); assert.equal(second.version, 2);
    assert.equal(store.test(first.id, first.versionId).source, source('v1'));
    assert.equal(store.listTests('project_one', 'local')[0].versionId, second.versionId);
    const duplicate = await store.saveTest({ testId: second.id, projectId: 'project_one', organizationId: 'local', title: 'Changed title', relativePath: second.relativePath, source: second.source, dependencies: { patrol: '0.0.0' }, validationAttemptId: 'patrol_attempt_other', state: 'generated' });
    assert.deepEqual(duplicate, second, 'duplicate publication must retain immutable metadata');
    // The same source in another file (a test moved to a suite) is what runs from now on.
    const moved = await store.saveTest({ testId: second.id, projectId: 'project_one', organizationId: 'local', title: 'Receipt', relativePath: 'patrol_test/Cart/receipt_test.dart', source: second.source });
    assert.deepEqual([moved.version, moved.relativePath, moved.state], [3, 'patrol_test/Cart/receipt_test.dart', 'published']);
    assert.equal(store.listTests('project_one', 'local')[0].versionId, moved.versionId);
    const attempt = { schemaVersion: 1, id: 'patrol_attempt_one', testId: first.id, versionId: first.versionId, projectId: 'project_one', organizationId: 'local', testContentHash: first.contentHash, runtime: { deviceId: 'emulator-5554', deviceName: 'Slim', platform: 'android', entrypoint: first.relativePath, testFileHashes: { [first.relativePath]: first.contentHash }, environmentHash: 'e'.repeat(64) }, state: 'failed', deviceId: 'emulator-5554', leaseId: 'lease_one', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: 'Failed', detail: 'Expected v1', passed: 0, failed: 1, skipped: 0, tests: [], artifacts: [], runner: 'desktop-local-patrol' } as const;
    await store.recordAttempt(attempt);
    const reopened = new PatrolRunStore(root); await reopened.initialize();
    assert.equal(reopened.versions('project_one', 'local', first.id).length, 3);
    assert.equal(reopened.test(first.id, first.versionId).contentHash, first.contentHash);
    assert.equal(reopened.attempt(attempt.id)?.versionId, first.versionId);
    assert.equal(reopened.attempt(attempt.id)?.detail, 'Expected v1');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Patrol artifacts require matching attempt scope and saved bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-artifact-'));
  try {
    const store = new PatrolRunStore(root); await store.initialize();
    const artifact = await store.writeArtifact('patrol_attempt_one', 'run.log', Buffer.from('original'));
    await store.recordAttempt({ schemaVersion: 1, id: 'patrol_attempt_one', testId: 'patrol_test_one', versionId: 'patrol_version_one', projectId: 'project_one', organizationId: 'local', testContentHash: 'a'.repeat(64), runtime: { deviceId: 'emulator-5554', deviceName: 'Slim', platform: 'android', entrypoint: 'patrol_test/one_test.dart', testFileHashes: {}, environmentHash: 'e'.repeat(64) }, state: 'failed', deviceId: 'emulator-5554', leaseId: '', startedAt: new Date().toISOString(), summary: 'Failed', detail: '', passed: 0, failed: 1, skipped: 0, tests: [], artifacts: [artifact], runner: 'desktop-local-patrol' });
    const scope = { organizationId: 'local', projectId: 'project_one', testId: 'patrol_test_one', attemptId: 'patrol_attempt_one', relativePath: 'run.log' };
    assert.equal((await store.readArtifact(scope)).bytes.toString(), 'original');
    await assert.rejects(store.readArtifact({ ...scope, projectId: 'project_other' }), /not found/);
    await assert.rejects(store.readArtifact({ ...scope, relativePath: '../run.log' }), /invalid/);
    await writeFile(path.join(root, 'artifacts', 'patrol_attempt_one', 'run.log'), 'tampered');
    await assert.rejects(store.readArtifact(scope), /integrity/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Patrol replay refuses a saved version from another project before device access', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-scope-'));
  try {
    const store = new PatrolRunStore(root); await store.initialize();
    const saved = await store.saveTest({ organizationId: 'org_one', projectId: 'project_one', title: 'One', relativePath: 'patrol_test/one_test.dart', source: source('one') });
    const runner = new PatrolRunner({ store, captures: { devices: async () => { throw new Error('Device lookup must not happen.'); } } as never });
    await assert.rejects(runner.run({ organizationId: 'org_other', projectId: 'project_other', testId: saved.id, versionId: saved.versionId, deviceId: 'emulator-5554' }, root), /outside this project/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Patrol materialization refuses symbolic-link paths before writing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-path-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-outside-'));
  try {
    await symlink(outside, path.join(root, 'patrol_test'));
    await assert.rejects(assertSafeTestPath(root, 'patrol_test/receipt_test.dart'), /symbolic link/);
    await rm(path.join(root, 'patrol_test'));
    await mkdir(path.join(root, 'patrol_test'));
    await symlink(path.join(outside, 'target.dart'), path.join(root, 'patrol_test', 'receipt_test.dart'));
    await assert.rejects(assertSafeTestPath(root, 'patrol_test/receipt_test.dart'), /symbolic link/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('a test stored in patrol_test/ runs from its own file, header included, and is never written over', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-stored-'));
  try {
    const body = source('cart');
    const file = path.join(root, 'patrol_test', 'Cart', 'cart_test.dart');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, serializeTestFile({ id: 'test_cart', title: 'Cart', steps: [] }, body));
    const stored = { relativePath: 'patrol_test/Cart/cart_test.dart', contentHash: createHash('sha256').update(body).digest('hex') };
    assert.equal(await readStoredTest(root, stored), await readFile(file, 'utf8'));
    await assert.rejects(readStoredTest(root, { ...stored, contentHash: createHash('sha256').update(source('older')).digest('hex') }), /changed after this version was saved/);
    await assert.rejects(readStoredTest(root, { ...stored, relativePath: 'patrol_test/cart_test.dart' }), /no longer in the project/);
    assert.equal(await readFile(file, 'utf8'), serializeTestFile({ id: 'test_cart', title: 'Cart', steps: [] }, body));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed Patrol source and artifacts produce a cited durable application analysis', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-analysis-'));
  try {
    const store = new PatrolRunStore(root); await store.initialize();
    const saved = await store.saveTest({ organizationId: 'local', projectId: 'project_one', title: 'Receipt', relativePath: 'patrol_test/receipt_test.dart', source: source('receipt') });
    const artifact = await store.writeArtifact('patrol_attempt_failure', 'patrol-run.log', Buffer.from('Expected 12, actual 7'));
    await store.recordAttempt({ schemaVersion: 1, id: 'patrol_attempt_failure', testId: saved.id, versionId: saved.versionId, projectId: 'project_one', organizationId: 'local', testContentHash: saved.contentHash, runtime: { deviceId: 'emulator-5554', deviceName: 'Slim', platform: 'android', entrypoint: saved.relativePath, testFileHashes: { [saved.relativePath]: saved.contentHash }, environmentHash: 'e'.repeat(64) }, state: 'failed', deviceId: 'emulator-5554', leaseId: '', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: 'Receipt assertion failed', detail: 'Expected 12, actual 7', passed: 0, failed: 1, skipped: 0, tests: [{ id: 'receipt', title: 'receipt', outcome: 'failed', durationMs: 1, errors: ['Expected 12, actual 7'] }], artifacts: [artifact], runner: 'desktop-local-patrol' });
    const agent = { async invoke(input: { prompt: string }) { assert.match(input.prompt, /Expected 12, actual 7/); return { cliVersion: 'fixture', output: { expected: '12', actual: '7', category: 'application', explanation: 'The price calculation differs from the saved assertion.', limitations: 'The source was not inspected.', nextStep: 'Review application price calculation.', evidenceIds: ['e03', 'e05'] } }; } };
    const manager = new FailureAnalysisManager({} as never, agent as never, store);
    const analysis = await manager.analyzePatrol({ organizationId: 'local', projectId: 'project_one', testId: saved.id, attemptId: 'patrol_attempt_failure', provider: 'codex' });
    assert.equal(analysis.status, 'complete'); assert.equal(analysis.category, 'application');
    assert.ok(analysis.evidenceIds.every((id) => analysis.evidence.some((entry) => entry.id === id)));
    const reopened = new PatrolRunStore(root); await reopened.initialize();
    assert.equal(reopened.failureAnalyses(analysis)[0]?.id, analysis.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Patrol test runs freeze versions, record every test as a run attempt and never outlive the process', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-run-'));
  try {
    const store = new PatrolRunStore(root); await store.initialize();
    const login = await store.saveTest({ projectId: 'project_one', organizationId: 'local', title: 'Login', relativePath: 'patrol_test/login_test.dart', source: source('login') });
    const cart = await store.saveTest({ projectId: 'project_one', organizationId: 'local', title: 'Cart', relativePath: 'patrol_test/cart_test.dart', source: source('cart') });
    await assert.rejects(() => store.createRun({ organizationId: 'local', projectId: 'project_one', testIds: [], name: 'Empty' }), /at least one/);
    await assert.rejects(() => store.createRun({ organizationId: 'local', projectId: 'project_two', testIds: [login.id], name: 'Elsewhere' }), /no saved Patrol version/);
    const run = await store.createRun({ organizationId: 'local', projectId: 'project_one', testIds: [login.id, cart.id, login.id], name: '  Nightly  ' });
    assert.equal(run.state, 'queued'); assert.equal(run.name, 'Nightly');
    assert.deepEqual(run.items.map((item) => item.versionId), [login.versionId, cart.versionId]);
    await store.saveTest({ testId: login.id, projectId: 'project_one', organizationId: 'local', title: 'Login', relativePath: login.relativePath, source: source('login v2') });
    assert.equal(store.run({ organizationId: 'local', projectId: 'project_one', runId: run.id }).items[0].versionId, login.versionId, 'a later version must not rewrite the run');

    // Without a source folder every test is blocked before anything executes;
    // each still becomes an inspectable attempt of this run and the run finishes.
    const consoleEvents: PatrolRunConsoleEvent[] = [];
    const runner = new PatrolRunner({ store, captures: { devices: async () => [] } as never, events: { onConsole: (event) => consoleEvents.push(event) } });
    const started = await runner.startRun({ organizationId: 'local', projectId: 'project_one', runId: run.id, deviceId: 'emulator-5554' }, '');
    assert.equal(started.state, 'running'); assert.equal(started.activeTestId, undefined, 'a test becomes active only when Patrol starts it');
    await assert.rejects(() => runner.startRun({ organizationId: 'local', projectId: 'project_one', runId: run.id, deviceId: 'emulator-5554' }, ''), /already running/);
    let finished = started;
    for (let poll = 0; poll < 100 && finished.state === 'running'; poll += 1) { await new Promise((resolve) => setTimeout(resolve, 20)); finished = store.run({ organizationId: 'local', projectId: 'project_one', runId: run.id }); }
    assert.equal(finished.state, 'finished'); assert.equal(finished.activeTestId, undefined);
    const { runs, attempts } = store.runs('project_one', 'local');
    assert.equal(runs.length, 1);
    assert.deepEqual(attempts.map((attempt) => [attempt.testId, attempt.versionId, attempt.state, attempt.runId]), [[login.id, login.versionId, 'blocked', run.id], [cart.id, cart.versionId, 'blocked', run.id]]);

    // The run's console streams why it could not run, and a view attaching
    // later gets the same text; after a restart the recorded reason stands in.
    const scope = { organizationId: 'local', projectId: 'project_one', runId: run.id };
    for (let poll = 0; poll < 100 && !consoleEvents.some((event) => event.text.includes('The run finished.')); poll += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const streamed = consoleEvents.map((event) => event.text).join('');
    assert.ok(consoleEvents.every((event, index) => event.runId === run.id && event.startedAt === started.startedAt && event.seq === index + 1));
    assert.equal(streamed, 'Checking emulator-5554, Flutter and Patrol…\nBlocked: Select the Flutter project folder before running a Patrol test.\nThe run finished.\n');
    assert.deepEqual(await runner.console(scope), { text: streamed, seq: consoleEvents.length });
    assert.deepEqual(await new PatrolRunner({ store, captures: { devices: async () => [] } as never }).console(scope), { text: 'Select the Flutter project folder before running a Patrol test.', seq: 0 });
    await assert.rejects(() => runner.console({ ...scope, projectId: 'project_two' }), /unknown in this project/);

    await store.updateRun(run.id, { state: 'running', activeTestId: cart.id });
    const reopened = new PatrolRunStore(root); await reopened.initialize();
    assert.equal(reopened.run({ organizationId: 'local', projectId: 'project_one', runId: run.id }).state, 'interrupted');
    await reopened.deleteRun({ organizationId: 'local', projectId: 'project_one', runId: run.id });
    assert.equal(reopened.runs('project_one', 'local').runs.length, 0);
    assert.equal(reopened.attempts('project_one', 'local', login.id).length, 1, 'deleting a run keeps its attempts');
  } finally { await rm(root, { recursive: true, force: true }); }
});
