import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deviceReportFiles, instrumentationFailure, ownerOf, patrolBundleName, readableLog, splitPatrolLog } from './patrol-log.ts';
import { PatrolRunStore } from './patrol-store.ts';

const ESC = '\x1b';
// Shape of a real two-file `patrol test -t a -t b --verbose --show-flutter-logs` run.
const combined = [
  '• Building apk with entrypoint test_bundle.dart...',
  '✓ Completed building apk with entrypoint test_bundle.dart (10.0s)',
  '\t: Starting 3 tests on Slim_1(AVD) - 17',
  '🧪 sign_in_test signs in',
  `        ⏳   1. ${ESC}[33mtap${ESC}[0m widgets with key [<'sign_in_submit'>].`,
  `${ESC}[A${ESC}[K        ✅   1. ${ESC}[33mtap${ESC}[0m widgets with key [<'sign_in_submit'>].`,
  `${ESC}[A${ESC}[K✅ signs in ${ESC}[90m(/sign_in_test.dart)${ESC}[0m ${ESC}[90m(2s)${ESC}[0m`,
  '🧪 sign_in_test_two shows an error',
  "        ⏳   1. enterText widgets with key [<'email'>].",
  "        ❌   1. enterText widgets with key [<'email'>].",
  'I/flutter: WaitUntilVisibleTimeoutException: finder "email" did not find any widgets',
  '❌ shows an error (/sign_in_test_two.dart) (31s)',
  '🧪 sign_in_test signs out',
  '✅ signs out (/sign_in_test.dart) (1s)',
  '\t: Finished 3 tests on Slim_1(AVD) - 17',
  'Test summary:',
  '📝 Total: 3',
].join('\n');

test('bundle names and owners follow Patrol\'s test bundle naming', () => {
  assert.equal(patrolBundleName('patrol_test/sign_in_test.dart'), 'sign_in_test');
  assert.equal(patrolBundleName('patrol_test/auth/sign_in_test.dart'), 'auth.sign_in_test');
  const owner = ownerOf(['patrol_test/sign_in_test.dart', 'patrol_test/sign_in_test_two.dart']);
  assert.equal(owner('sign_in_test_two shows an error'), 'patrol_test/sign_in_test_two.dart');
  assert.equal(owner('sign_in_test signs in'), 'patrol_test/sign_in_test.dart');
  assert.equal(owner('other_test anything'), undefined);
});

test('a combined Patrol log reads as text and splits into one log per saved file', () => {
  const readable = readableLog(combined);
  assert.doesNotMatch(readable, new RegExp(`${ESC}\\[`));
  // The pending step is collapsed into its outcome.
  assert.doesNotMatch(readable, /⏳ {3}1\. tap/);
  assert.match(readable, /✅ {3}1\. tap widgets/);
  const segments = splitPatrolLog(readable, ['patrol_test/sign_in_test.dart', 'patrol_test/sign_in_test_two.dart', 'patrol_test/never_started_test.dart']);
  const first = segments.get('patrol_test/sign_in_test.dart')!;
  const second = segments.get('patrol_test/sign_in_test_two.dart')!;
  assert.match(first, /^🧪 sign_in_test signs in/);
  assert.match(first, /🧪 sign_in_test signs out/, 'both tests of one file are in its log');
  assert.doesNotMatch(first, /shows an error|Building apk|Finished 3 tests/);
  assert.match(second, /WaitUntilVisibleTimeoutException/);
  assert.match(second, /❌ shows an error/);
  assert.doesNotMatch(second, /signs out/);
  assert.equal(segments.has('patrol_test/never_started_test.dart'), false);
});

test('an instrumentation crash that ran zero tests is read from the device log', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-log-'));
  try {
    const device = path.join(project, 'build', 'app', 'outputs', 'androidTest-results', 'connected', 'debug');
    await mkdir(path.join(device, 'CPH2769 - 16', 'testlog'), { recursive: true });
    await writeFile(path.join(device, 'TEST-CPH2769 - 16-_app-.xml'), '<testsuite tests="0" failures="0"></testsuite>');
    await writeFile(path.join(device, 'CPH2769 - 16', 'testlog', 'test-results.log'), 'INSTRUMENTATION_RESULT: stream=Fatal exception when setting up.\njava.lang.IllegalStateException: Permission requested but not granted!\nat androidx.test.orchestrator.AndroidTestOrchestrator.grantRuntimePermissions(AndroidTestOrchestrator.java:227)\n\nINSTRUMENTATION_CODE: -1\n');
    const failure = await instrumentationFailure(project);
    assert.match(failure ?? '', /^Fatal exception when setting up\.\njava\.lang\.IllegalStateException: Permission requested but not granted!/);
    const files = (await deviceReportFiles(project)).map((file) => file.relativePath).sort();
    assert.deepEqual(files, ['device/connected/debug/CPH2769_-_16/testlog/test-results.log', 'device/connected/debug/TEST-CPH2769_-_16-_app-.xml']);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('a run log returns a test\'s own slice, and the whole run for a test that never started', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-run-log-'));
  try {
    const store = new PatrolRunStore(root); await store.initialize();
    const source = `import 'package:patrol/patrol.dart';\nvoid main(){ patrolTest('t', ($) async {}); }\n`;
    const one = await store.saveTest({ projectId: 'project_one', organizationId: 'local', title: 'One', relativePath: 'patrol_test/one_test.dart', source });
    const two = await store.saveTest({ projectId: 'project_one', organizationId: 'local', title: 'Two', relativePath: 'patrol_test/two_test.dart', source: `${source}// two\n` });
    const run = await store.createRun({ organizationId: 'local', projectId: 'project_one', testIds: [one.id, two.id], name: 'Nightly' });
    const scope = { organizationId: 'local', projectId: 'project_one', runId: run.id };
    assert.equal(await store.readRunLog(scope), 'This run has no combined log.');
    const artifact = await store.writeRunArtifact(run.id, 'patrol-run.log', Buffer.from('build…\n🧪 one_test t\n✅ t (/one_test.dart) (1s)\n'));
    await store.updateRun(run.id, { state: 'finished', artifacts: [artifact] });
    const base = { schemaVersion: 1 as const, projectId: 'project_one', organizationId: 'local', runtime: { deviceId: 'd', deviceName: 'd', platform: 'android' as const, entrypoint: '', testFileHashes: {}, environmentHash: '' }, deviceId: 'd', leaseId: 'l', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), detail: '', passed: 0, failed: 0, skipped: 0, runner: 'desktop-local-patrol' as const, runId: run.id };
    const passedId = 'patrol_attempt_one';
    await store.recordAttempt({ ...base, id: passedId, testId: one.id, versionId: one.versionId, testContentHash: one.contentHash, state: 'passed', summary: '1 Patrol test(s) passed.', tests: [], artifacts: [await store.writeArtifact(passedId, 'test.log', Buffer.from('🧪 one_test t\n✅ t (/one_test.dart) (1s)'))] });
    await store.recordAttempt({ ...base, id: 'patrol_attempt_two', testId: two.id, versionId: two.versionId, testContentHash: two.contentHash, state: 'infrastructure-error', summary: 'This test did not start on the device.', tests: [], artifacts: [] });
    const own = await store.readRunLog(scope, passedId);
    assert.match(own, /^1 Patrol test\(s\) passed\./);
    assert.match(own, /🧪 one_test t/);
    assert.doesNotMatch(own, /build…/);
    const fallback = await store.readRunLog(scope, 'patrol_attempt_two');
    assert.match(fallback, /did not start on the device, so it has no log of its own/);
    assert.match(fallback, /build…/);
    await assert.rejects(store.readRunLog({ ...scope, projectId: 'project_two' }, passedId), /unknown in this project/);
    await store.deleteRun(scope);
    assert.equal(store.allRuns().length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
