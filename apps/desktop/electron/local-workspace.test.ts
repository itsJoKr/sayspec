import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalWorkspaceStore } from './local-workspace.ts';

test('guest projects and generated tests persist locally across app sessions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-local-workspace-'));
  try {
    const file = path.join(root, 'workspace.json');
    const first = new LocalWorkspaceStore(file); await first.initialize();
    const project = await first.createProject({ name: 'Guest storefront', targetType: 'web', baseUrl: 'http://127.0.0.1:3000' });
    assert.equal(project.baseUrl, 'http://127.0.0.1:3000/');
    await assert.rejects(first.createProject({ name: 'Invalid URL', targetType: 'web', baseUrl: 'not-a-url' }), /complete URL/i);
    const saved = await first.saveGeneratedTest({ projectId: project.id, title: 'Checkout succeeds', folder: '', tags: [], status: 'published', versionCount: 1 });
    await first.renameTest({ projectId: project.id, testId: saved.id, title: 'Checkout with card' });
    assert.equal(first.snapshot().tests[0].title, 'Checkout with card');
    await first.deleteTest({ projectId: project.id, testId: saved.id });
    const restored = new LocalWorkspaceStore(file); await restored.initialize();
    assert.equal(restored.snapshot().projects[0].name, 'Guest storefront');
    assert.deepEqual(restored.snapshot().tests, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Flutter guest projects require a source folder', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-local-workspace-'));
  try {
    const store = new LocalWorkspaceStore(path.join(root, 'workspace.json')); await store.initialize();
    await assert.rejects(store.createProject({ name: 'Mobile', targetType: 'flutter' }), /source folder is required/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('generated recording appears once in the guest test library and keeps its renamed title', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-local-generated-'));
  try {
    const file = path.join(root, 'workspace.json');
    const store = new LocalWorkspaceStore(file); await store.initialize();
    const project = await store.createProject({ name: 'Web', targetType: 'web', baseUrl: 'https://example.test' });
    const input = { projectId: project.id, recordingId: 'recording_one', title: 'Recorded checkout', folder: 'Generated tests', tags: ['recording'], status: 'generated' as const, versionCount: 0 };
    const first = await store.saveGeneratedTest(input);
    await store.renameTest({ projectId: project.id, testId: first.id, title: 'My checkout test' });
    const second = await store.saveGeneratedTest({ ...input, title: 'New AI title' });
    assert.equal(second.id, first.id);
    const reopened = new LocalWorkspaceStore(file); await reopened.initialize();
    assert.equal(reopened.snapshot().tests.length, 1);
    assert.equal(reopened.snapshot().tests[0].title, 'My checkout test');
    assert.equal(reopened.snapshot().tests[0].recordingId, 'recording_one');
    assert.equal(reopened.snapshot().suites.length, 1);
    assert.equal(reopened.snapshot().suites[0].name, 'Just Recorded');
    assert.deepEqual(reopened.snapshot().suites[0].testIds, [first.id]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('guest suites persist, reject stale edits, cross-project and deleted members', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-local-suites-'));
  try {
    const file = path.join(root, 'workspace.json'); const store = new LocalWorkspaceStore(file); await store.initialize();
    const project = await store.createProject({ name: 'A', targetType: 'web', baseUrl: 'https://example.test' });
    const other = await store.createProject({ name: 'B', targetType: 'web', baseUrl: 'https://example.test' });
    const testA = await store.saveGeneratedTest({ projectId: project.id, title: 'A', folder: '', tags: [], status: 'generated', versionCount: 1 });
    const testB = await store.saveGeneratedTest({ projectId: other.id, title: 'B', folder: '', tags: [], status: 'generated', versionCount: 1 });
    const change = { projectId: project.id, suiteId: 'suite_smoke', expectedRevision: 0, name: 'Smoke', testIds: [testA.id] };
    const created = await store.saveSuite(change); assert.equal(created.revision, 1);
    const secondSuite = await store.saveSuite({ projectId: project.id, suiteId: 'suite_other', expectedRevision: 0, name: 'Other', testIds: [] });
    await store.moveTestToSuite({ projectId: project.id, testId: testA.id, targetSuiteId: secondSuite.id });
    assert.deepEqual(store.snapshot().suites.map((suite) => suite.testIds), [[], [testA.id]]);
    await assert.rejects(store.saveSuite(change), /changed elsewhere/);
    await assert.rejects(store.saveSuite({ ...change, expectedRevision: 1, testIds: [testB.id] }), /active tests from this project/);
    await store.deleteTest({ projectId: project.id, testId: testA.id });
    await assert.rejects(store.saveSuite({ ...change, expectedRevision: 1 }), /active tests/);
    const reopened = new LocalWorkspaceStore(file); await reopened.initialize();
    assert.deepEqual(reopened.snapshot().suites.map((suite) => [suite.id, suite.testIds]), [['suite_smoke', []], ['suite_other', []]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Just Recorded suites never receive moved tests and disappear once empty', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-local-just-recorded-'));
  try {
    const file = path.join(root, 'workspace.json'); const store = new LocalWorkspaceStore(file); await store.initialize();
    const project = await store.createProject({ name: 'Web', targetType: 'web', baseUrl: 'https://example.test' });
    const recorded = (recordingId: string) => store.saveGeneratedTest({ projectId: project.id, recordingId, title: recordingId, folder: 'Generated tests', tags: ['recording'], status: 'generated', versionCount: 0 });
    const first = await recorded('recording_one'); const second = await recorded('recording_two');
    const [firstInbox, secondInbox] = store.snapshot().suites;
    assert.deepEqual([firstInbox.name, secondInbox.name], ['Just Recorded', 'Just Recorded']);
    const auth = await store.saveSuite({ projectId: project.id, suiteId: 'suite_auth', expectedRevision: 0, name: 'Auth', testIds: [] });
    await assert.rejects(store.moveTestToSuite({ projectId: project.id, testId: first.id, targetSuiteId: secondInbox.id }), /Just Recorded/);
    await store.moveTestToSuite({ projectId: project.id, testId: first.id, targetSuiteId: auth.id });
    assert.deepEqual(store.snapshot().suites.map((suite) => [suite.name, suite.testIds]), [['Just Recorded', [second.id]], ['Auth', [first.id]]]);
    await store.deleteTest({ projectId: project.id, testId: second.id });
    assert.deepEqual(store.snapshot().suites.map((suite) => [suite.name, suite.testIds]), [['Auth', [first.id]]]);
    await store.moveTestToSuite({ projectId: project.id, testId: first.id, targetSuiteId: null });
    assert.deepEqual(store.snapshot().suites.map((suite) => suite.name), ['Auth'], 'user-created suites stay even when empty');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reopening a workspace clears archived members and empty Just Recorded suites', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-local-prune-'));
  try {
    const file = path.join(root, 'workspace.json');
    const projectId = 'local_project_one'; const at = new Date().toISOString();
    const suite = (id: string, name: string, testIds: string[]) => ({ id, projectId, name, testIds, revision: 1, updatedAt: at, sourceRecordingId: `recording_${id}` });
    await writeFile(file, JSON.stringify({ schemaVersion: 1, projects: [{ id: projectId, name: 'Web', targetType: 'web', baseUrl: 'https://example.test/', createdAt: at }], tests: [
      { id: 'test_old', projectId, title: 'Old', folder: '', tags: [], status: 'archived', versionCount: 1, createdAt: at },
      { id: 'test_kept', projectId, title: 'Kept', folder: '', tags: [], status: 'generated', versionCount: 1, createdAt: at },
    ], suites: [suite('suite_empty', 'Just Recorded', []), suite('suite_mixed', 'Just Recorded', ['test_old', 'test_kept']), suite('suite_renamed', 'Login', [])] }));
    const store = new LocalWorkspaceStore(file); await store.initialize();
    assert.deepEqual(store.snapshot().suites.map((item) => [item.id, item.testIds]), [['suite_mixed', ['test_kept']], ['suite_renamed', []]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deleting a guest project removes only its tests and suites', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-local-delete-'));
  try {
    const file = path.join(root, 'workspace.json');
    const store = new LocalWorkspaceStore(file); await store.initialize();
    const doomed = await store.createProject({ name: 'Doomed', targetType: 'web', baseUrl: 'https://example.test' });
    const kept = await store.createProject({ name: 'Kept', targetType: 'web', baseUrl: 'https://example.test' });
    await store.saveGeneratedTest({ projectId: doomed.id, recordingId: 'recording_doomed', title: 'Gone', folder: '', tags: [], status: 'generated', versionCount: 1 });
    const survivor = await store.saveGeneratedTest({ projectId: kept.id, recordingId: 'recording_kept', title: 'Stays', folder: '', tags: [], status: 'generated', versionCount: 1 });
    await store.deleteProject({ projectId: doomed.id });
    await assert.rejects(store.deleteProject({ projectId: doomed.id }), /not found/);
    const reopened = new LocalWorkspaceStore(file); await reopened.initialize();
    const snapshot = reopened.snapshot();
    assert.deepEqual(snapshot.projects.map((project) => project.id), [kept.id]);
    assert.deepEqual(snapshot.tests.map((item) => item.id), [survivor.id]);
    assert.deepEqual(snapshot.suites.map((suite) => suite.projectId), [kept.id]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
