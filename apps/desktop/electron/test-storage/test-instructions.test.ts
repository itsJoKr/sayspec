import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectAgentWorkspaceManager, projectInstructionsNote } from '../coding-agent/project-agent-workspace.ts';
import { SavedWebTestStore } from '../execution/saved-web-tests.ts';
import { PatrolRunStore } from '../flutter/patrol-store.ts';
import { LocalWorkspaceStore } from '../local-workspace.ts';
import { testInstructionsSkill, TEST_INSTRUCTIONS_QUESTION } from '../setup/setup-agent-skill.ts';
import { INSTRUCTIONS_FILE, instructionsTemplate, reconcileCloudInstructions, TestInstructions } from './test-instructions.ts';
import { TestStorage } from './test-storage.ts';
import { TestStorageSettingsStore } from './test-storage-settings.ts';

const WRITTEN = '# Test instructions\n\n- Use data-testid selectors.\n';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-test-instructions-'));
  const folder = path.join(root, 'repo', 'e2e'); await mkdir(folder, { recursive: true });
  const settings = new TestStorageSettingsStore(path.join(root, 'test-storage.json')); await settings.initialize();
  const localWorkspace = new LocalWorkspaceStore(path.join(root, 'workspace.json')); await localWorkspace.initialize();
  const webTests = new SavedWebTestStore(path.join(root, 'web')); await webTests.initialize();
  const patrolTests = new PatrolRunStore(path.join(root, 'patrol')); await patrolTests.initialize();
  const storage = new TestStorage({ settings, localWorkspace, webTests, patrolTests, localRoot: path.join(root, 'local-tests'), gitIdentity: async () => ({}) });
  const instructions = new TestInstructions((scope) => storage.instructionsLocation(scope));
  return { root, folder, storage, instructions, webTests, patrolTests, scope: { organizationId: 'org_team', projectId: 'project_shop' } };
}

test('cloud reconciliation downloads teammates’ changes, uploads local edits and ignores starter text', () => {
  const template = instructionsTemplate('web');
  assert.equal(reconcileCloudInstructions({ local: null, synced: null, cloud: null }), 'none');
  assert.equal(reconcileCloudInstructions({ local: template, synced: null, cloud: null }), 'none');
  assert.equal(reconcileCloudInstructions({ local: WRITTEN, synced: null, cloud: null }), 'upload');
  assert.equal(reconcileCloudInstructions({ local: null, synced: null, cloud: WRITTEN }), 'download');
  assert.equal(reconcileCloudInstructions({ local: template, synced: null, cloud: WRITTEN }), 'download');
  assert.equal(reconcileCloudInstructions({ local: 'old', synced: 'old', cloud: WRITTEN }), 'download');
  assert.equal(reconcileCloudInstructions({ local: WRITTEN, synced: 'old', cloud: 'old' }), 'upload');
  assert.equal(reconcileCloudInstructions({ local: WRITTEN, synced: null, cloud: WRITTEN }), 'mark-synced');
  assert.equal(reconcileCloudInstructions({ local: WRITTEN, synced: WRITTEN, cloud: WRITTEN }), 'none');
  // Both changed: the edit made on this Mac wins.
  assert.equal(reconcileCloudInstructions({ local: WRITTEN, synced: 'old', cloud: 'teammate' }), 'upload');
});

test('SAYSPEC.md sits next to the tests of Local and Folder storage, and only real instructions reach agents', async () => {
  const { root, folder, storage, instructions, scope } = await fixture();
  try {
    await storage.configure(scope, { mode: 'local', targetType: 'web' });
    assert.equal(instructions.path(scope), path.join(root, 'local-tests', 'org_team', 'project_shop', INSTRUCTIONS_FILE));
    assert.equal((await instructions.view(scope)).written, false);
    const created = await instructions.ensure(scope, 'web');
    assert.equal(await readFile(created, 'utf8'), instructionsTemplate('web'));
    assert.equal(await instructions.read(scope), null, 'starter text is not instructions');
    await writeFile(created, WRITTEN);
    await instructions.ensure(scope, 'web');
    assert.equal(await instructions.read(scope), WRITTEN, 'ensure never overwrites');
    assert.equal((await instructions.view(scope)).written, true);
    // The folder scan does not mistake the file for a test.
    assert.equal((await storage.library(scope)).tests.length, 0);

    await storage.configure({ organizationId: 'org_team', projectId: 'project_folder' }, { mode: 'folder', targetType: 'web' });
    assert.equal((await instructions.view({ organizationId: 'org_team', projectId: 'project_folder' })).state, 'missing-folder');
    await assert.rejects(instructions.ensure({ organizationId: 'org_team', projectId: 'project_folder' }, 'web'), /Choose where that folder is/);
    await storage.configure({ organizationId: 'org_team', projectId: 'project_folder' }, { mode: 'folder', targetType: 'web', directory: folder });
    assert.equal(instructions.path({ organizationId: 'org_team', projectId: 'project_folder' }), path.join(folder, INSTRUCTIONS_FILE));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('switching storage carries the instructions over without replacing a copy already there', async () => {
  const { root, folder, storage, instructions, scope } = await fixture();
  try {
    await storage.configure(scope, { mode: 'local', targetType: 'web' });
    await writeFile(await instructions.ensure(scope, 'web'), WRITTEN);
    await storage.configure(scope, { mode: 'folder', targetType: 'web', directory: folder });
    assert.equal(await readFile(path.join(folder, INSTRUCTIONS_FILE), 'utf8'), WRITTEN);

    await writeFile(path.join(folder, INSTRUCTIONS_FILE), '# The repository’s own\n');
    await storage.configure(scope, { mode: 'local', targetType: 'web' });
    await storage.configure(scope, { mode: 'folder', targetType: 'web' });
    assert.equal(await readFile(path.join(folder, INSTRUCTIONS_FILE), 'utf8'), '# The repository’s own\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a SaySpec Cloud project keeps a local copy in step with the shared text', async () => {
  const { root, storage, instructions, scope } = await fixture();
  try {
    await storage.configure(scope, { mode: 'cloud', targetType: 'web' });
    assert.deepEqual(await instructions.syncCloud(scope, null), {});
    assert.deepEqual(await instructions.syncCloud(scope, WRITTEN), {});
    assert.equal(await instructions.read(scope), WRITTEN, 'a teammate’s text is written to this Mac');

    const edited = `${WRITTEN}- Sign in as the QA admin account.\n`;
    await writeFile(instructions.path(scope)!, edited);
    assert.deepEqual(await instructions.syncCloud(scope, WRITTEN), { upload: edited });
    assert.deepEqual(await instructions.syncCloud(scope, edited), {}, 'after the upload arrives both agree');

    const teammate = `${edited}- Never place real orders.\n`;
    await instructions.syncCloud(scope, teammate);
    assert.equal(await instructions.read(scope), teammate);

    await writeFile(instructions.path(scope)!, 'x'.repeat(65 * 1024));
    await assert.rejects(instructions.syncCloud(scope, teammate), /larger than 64 KB/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('generation and fix workspaces get the instructions read-only at their root, and drop stale copies', async () => {
  const { root, webTests, patrolTests, scope } = await fixture();
  try {
    let text: string | null = WRITTEN;
    const workspaces = new ProjectAgentWorkspaceManager(path.join(root, 'agents'), webTests, patrolTests, async () => text);
    const first = await workspaces.open(scope, 'generation', 'recording_one');
    assert.equal(first.instructionsFile, INSTRUCTIONS_FILE);
    assert.equal(await readFile(path.join(first.rootDirectory, INSTRUCTIONS_FILE), 'utf8'), WRITTEN);
    assert.match(projectInstructionsNote(first), /SAYSPEC\.md at the workspace root/);
    await workspaces.release(first);

    text = null;
    const second = await workspaces.open(scope, 'fix', 'attempt_one');
    assert.equal(second.instructionsFile, undefined);
    assert.equal(projectInstructionsNote(second), '');
    await assert.rejects(access(path.join(second.rootDirectory, INSTRUCTIONS_FILE)));
    await workspaces.release(second);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the instructions session asks the user how to make tests better and writes only SAYSPEC.md', () => {
  const skill = testInstructionsSkill('flutter', { instructionsPath: '/tmp/tests/SAYSPEC.md', testsDirectory: '/tmp/tests' });
  assert.ok(skill.includes(TEST_INSTRUCTIONS_QUESTION));
  assert.match(skill, /\/tmp\/tests\/SAYSPEC\.md/);
  assert.match(skill, /No source code folder is selected/);
  assert.match(skill, /Patrol/);
  assert.match(skill, /only file you write/);
  assert.match(skill, /Test account usernames and passwords may go in the file/);
  assert.match(skill, /Never write real personal credentials/);
});
