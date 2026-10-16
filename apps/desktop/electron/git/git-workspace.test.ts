import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FailureAnalysis, GitTarget, PlaywrightGenerationDraft } from '@sayspec/contracts';
import { ApplicationFixStore, stageApplicationContext } from '../execution/application-fix.ts';
import { SavedWebTestStore } from '../execution/saved-web-tests.ts';
import { PatrolRunStore } from '../flutter/patrol-store.ts';
import { DirectoryHandleRegistry } from '../jobs/directory-handles.ts';
import { LocalWorkspaceStore } from '../local-workspace.ts';
import { CloudUploadQueue } from '../test-storage/cloud-upload-queue.ts';
import { TestStorage } from '../test-storage/test-storage.ts';
import { TestStorageSettingsStore } from '../test-storage/test-storage-settings.ts';
import { parseGitTarget, resolveGitTarget, subjectFrom } from './git-targets.ts';
import { GitWorkspace, compareUrl, parseRemote, parseStatus } from './git-workspace.ts';

const GIT = execFileSync('/usr/bin/which', ['git']).toString().trim();
const git = (cwd: string, ...args: string[]) => execFileSync(GIT, args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim();
/** `git status --porcelain` lines as Git prints them: a leading space means unstaged. */
const porcelain = (cwd: string) => execFileSync(GIT, ['status', '--porcelain'], { cwd }).toString().split('\n').filter(Boolean).sort();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const analysis: FailureAnalysis = { schemaVersion: 1, id: 'analysis_one', organizationId: 'local', projectId: 'project_one', testId: 'test_one', attemptId: 'attempt_one', versionId: 'version_one', testVersionHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), createdAt: new Date().toISOString(), status: 'complete', provider: 'claude-code', expected: '12', actual: '7', category: 'application', explanation: 'The catalog price is wrong.', limitations: 'One run.', nextStep: 'Fix the price.', evidenceIds: ['e01'], evidence: [{ id: 'e01', kind: 'framework', label: 'assertion', text: 'Expected 12, actual 7 in lib/catalog.dart' }] };

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-git-'));
  const remote = path.join(root, 'remote.git'); const source = path.join(root, 'shop');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  await mkdir(path.join(source, 'lib'), { recursive: true });
  git(source, 'init', '-q', '-b', 'main'); git(source, 'config', 'user.name', 'Dev Person'); git(source, 'config', 'user.email', 'dev@example.com');
  await writeFile(path.join(source, 'lib', 'catalog.dart'), 'const price = 7;\n');
  await writeFile(path.join(source, 'lib', 'other.dart'), 'const other = 1;\n');
  await writeFile(path.join(source, 'notes.md'), 'notes\n');
  git(source, 'add', '.'); git(source, 'commit', '-q', '-m', 'Initial');
  git(source, 'remote', 'add', 'origin', remote); git(source, 'push', '-q', '-u', 'origin', 'main');
  return { root, remote, source };
}

function workspace(root: string, gh?: string) {
  const opened: string[] = [];
  const instance = new GitWorkspace({ storePath: path.join(root, 'state', 'commits.json'), tool: async (name) => name === 'git' ? GIT : gh, openExternal: async (url) => { opened.push(url); } });
  return { instance, opened };
}

async function appliedFix(source: string, root: string, before?: () => Promise<void>) {
  const handles = new DirectoryHandleRegistry(); const sourceHandle = await handles.register(source);
  const store = new ApplicationFixStore(path.join(root, 'fixes')); await store.initialize();
  await before?.();
  const staged = await stageApplicationContext(handles, sourceHandle, analysis);
  const proposal = await store.propose({ handles, sourceHandle, analysis, target: 'flutter', stagedFiles: staged.files, changes: [{ relativePath: 'lib/catalog.dart', text: 'const price = 12;\n' }], rationale: 'The catalog price was seven instead of twelve. Use the documented price.' });
  await store.decide({ organizationId: 'local', projectId: 'project_one', testId: 'test_one', proposalId: proposal.id, kind: 'approve', actorUid: 'guest', handles, sourceHandle });
  await store.apply({ organizationId: 'local', projectId: 'project_one', testId: 'test_one', proposalId: proposal.id, actorUid: 'guest', handles, sourceHandle });
  const target: GitTarget = { kind: 'application-fix', organizationId: 'local', projectId: 'project_one', testId: 'test_one', proposalId: proposal.id, sourceHandle };
  return { handles, store, target, resolve: () => resolveGitTarget(target, { applicationFixes: store, handles }) };
}

test('remote URLs lose credentials and map to the host’s pull request page', () => {
  const github = parseRemote('git@github.com:acme/shop.git');
  assert.deepEqual([github.host, github.webUrl, github.repository], ['github', 'https://github.com/acme/shop', 'acme/shop']);
  assert.equal(compareUrl(github, 'main', 'sayspec/fix-price'), 'https://github.com/acme/shop/compare/main...sayspec/fix-price?expand=1');
  const token = parseRemote('https://user:ghp_secret@github.example.com/team/app.git');
  assert.equal(token.url.includes('secret'), false); assert.equal(token.host, 'github'); assert.equal(token.webUrl, 'https://github.example.com/team/app');
  assert.match(compareUrl(parseRemote('ssh://git@gitlab.com/acme/shop.git'), 'main', 'sayspec/x')!, /^https:\/\/gitlab\.com\/acme\/shop\/-\/merge_requests\/new\?merge_request%5Bsource_branch%5D=sayspec%2Fx&merge_request%5Btarget_branch%5D=main$/);
  assert.match(compareUrl(parseRemote('https://bitbucket.org/acme/shop.git'), 'develop', 'sayspec/x')!, /pull-requests\/new\?source=sayspec%2Fx&dest=develop$/);
  assert.equal(compareUrl(parseRemote('/srv/git/shop.git'), 'main', 'x'), undefined);
  assert.deepEqual(parseStatus(' M lib/a.dart\0R  lib/new.dart\0lib/old.dart\0?? tests/new_test.dart\0 D gone.dart\0'), [
    { path: 'lib/a.dart', status: 'modified' }, { path: 'lib/new.dart', status: 'renamed' }, { path: 'lib/old.dart', status: 'deleted' }, { path: 'tests/new_test.dart', status: 'untracked' }, { path: 'gone.dart', status: 'deleted' },
  ]);
  assert.equal(subjectFrom('Fix: ', 'The cart total doubled the tax. Compute it once.'), 'Fix: The cart total doubled the tax');
  assert.throws(() => parseGitTarget({ kind: 'source', sourceHandle: '../etc' }), /invalid/);
  assert.throws(() => parseGitTarget({ kind: 'tests', organizationId: 'org', projectId: 'p', testIds: ['../x'] }), /invalid/);
});

test('an applied application fix is committed alone to a new SaySpec branch, pushed, and opened as a pull request', async () => {
  const { root, remote, source } = await repository();
  try {
    const fix = await appliedFix(source, root);
    // The developer's own work in progress: an edit, a staged file and an untracked file.
    await writeFile(path.join(source, 'lib', 'other.dart'), 'const other = 2;\n');
    await writeFile(path.join(source, 'notes.md'), 'more notes\n'); git(source, 'add', 'notes.md');
    await writeFile(path.join(source, 'scratch.txt'), 'scratch\n');
    const { instance, opened } = workspace(root); await instance.initialize();
    const spec = await fix.resolve();
    const view = await instance.view(spec);
    assert.equal(view.status.repository, true); assert.equal(view.status.branch, 'main'); assert.equal(view.status.remote?.name, 'origin');
    assert.deepEqual(view.changes, [{ path: 'lib/catalog.dart', status: 'modified' }]);
    assert.equal(view.blocked, undefined);
    assert.match(view.suggestedBranch, /^sayspec\/fix-the-catalog-price-was-seven-instead-of-[a-z0-9]{6}$/);
    assert.match(view.suggestedMessage, /^Fix: The catalog price was seven instead of twelve\n\n/);
    await assert.rejects(instance.commit(spec, { paths: ['lib/catalog.dart'], message: 'x', branch: { kind: 'current' } }), /only adds commits to branches it created/);
    await assert.rejects(instance.commit(spec, { paths: ['lib/other.dart'], message: 'x', branch: { kind: 'new', name: 'sayspec/x' } }), /moved on/);
    await assert.rejects(instance.commit(spec, { paths: ['lib/catalog.dart'], message: 'x', branch: { kind: 'new', name: '-bad name' } }), /valid branch name/);

    const record = await instance.commit(spec, { paths: ['lib/catalog.dart'], message: view.suggestedMessage, branch: { kind: 'new', name: view.suggestedBranch } });
    assert.equal(git(source, 'branch', '--show-current'), view.suggestedBranch);
    assert.equal(git(source, 'show', '--name-only', '--format=', 'HEAD'), 'lib/catalog.dart');
    assert.equal(git(source, 'show', 'HEAD:lib/catalog.dart'), 'const price = 12;');
    assert.equal(git(source, 'log', '-1', '--format=%an <%ae>'), 'Dev Person <dev@example.com>');
    assert.deepEqual(porcelain(source), [' M lib/other.dart', '?? scratch.txt', 'M  notes.md']);
    assert.deepEqual([record.baseBranch, record.createdBranch, record.commit], ['main', true, git(source, 'rev-parse', 'HEAD')]);

    const after = await instance.view(await fix.resolve());
    assert.deepEqual(after.changes, []); assert.equal(after.commits[0]?.id, record.id);
    assert.deepEqual(after.status.sayspecBranch, { name: view.suggestedBranch, baseBranch: 'main' });

    await assert.rejects(instance.pullRequest(spec, record.id), /Push the branch/);
    const pushed = await instance.push(spec, record.id);
    assert.equal(pushed.remote, 'origin'); assert.ok(pushed.pushedAt);
    assert.equal(git(remote, 'rev-parse', `refs/heads/${view.suggestedBranch}`), record.commit);
    await assert.rejects(instance.pullRequest(spec, record.id), /in your Git host/);
    git(source, 'remote', 'set-url', 'origin', 'https://github.com/acme/shop.git');
    await instance.pullRequest(spec, record.id);
    assert.deepEqual(opened, [`https://github.com/acme/shop/compare/main...${view.suggestedBranch}?expand=1`]);
    // Another target cannot act on this commit.
    await assert.rejects(instance.push({ ...spec, key: 'application-fix:local/project_one/other' }, record.id), /not one SaySpec made/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the GitHub CLI creates the pull request, and a second commit joins the same SaySpec branch', async () => {
  const { root, source } = await repository();
  try {
    const fix = await appliedFix(source, root);
    const log = path.join(root, 'gh.log'); const gh = path.join(root, 'gh');
    await writeFile(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$2" in create) echo "Creating pull request"; echo "https://github.com/acme/shop/pull/7";; esac\n`); await chmod(gh, 0o755);
    const { instance, opened } = workspace(root, gh); await instance.initialize();
    const spec = await fix.resolve();
    const first = await instance.commit(spec, { paths: ['lib/catalog.dart'], message: 'Fix: price\n\nUse twelve.', branch: { kind: 'new', name: 'sayspec/fix-price' } });
    await instance.push(spec, first.id);
    git(source, 'remote', 'set-url', 'origin', 'git@github.com:acme/shop.git');
    assert.equal((await instance.view(spec)).status.pullRequests, 'github-cli');
    const created = await instance.pullRequest(spec, first.id);
    assert.equal(created.pullRequestUrl, 'https://github.com/acme/shop/pull/7'); assert.deepEqual(opened, ['https://github.com/acme/shop/pull/7']);
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    assert.match(calls[0], /^pr list --repo acme\/shop --head sayspec\/fix-price --state open/);
    assert.match(calls[1], /^pr create --repo acme\/shop --base main --head sayspec\/fix-price --title Fix: price --body Use twelve\.\n?/);

    // A test file in the same repository, committed onto the checked-out SaySpec branch.
    await mkdir(path.join(source, 'e2e'), { recursive: true }); await writeFile(path.join(source, 'e2e', 'cart_test.dart'), 'void main() {}\n');
    await writeFile(path.join(source, 'lib', 'app.dart'), 'app\n');
    const tests = { key: 'tests:local/project_one:all', keyPrefix: 'tests:local/project_one:', directory: path.join(source, 'e2e'), include: (file: string) => file.endsWith('_test.dart'), branchStem: 'tests', message: 'Update SaySpec tests' };
    const view = await instance.view(tests);
    assert.deepEqual(view.changes, [{ path: 'e2e/cart_test.dart', status: 'untracked' }]);
    assert.deepEqual(view.status.sayspecBranch, { name: 'sayspec/fix-price', baseBranch: 'main' });
    const second = await instance.commit(tests, { paths: ['e2e/cart_test.dart'], message: 'Update SaySpec tests', branch: { kind: 'current' } });
    assert.deepEqual([second.branch, second.baseBranch, second.createdBranch], ['sayspec/fix-price', 'main', false]);
    assert.deepEqual(porcelain(source), ['?? lib/app.dart']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SaySpec refuses to commit more than the fix and undoes a commit its hooks reject', async () => {
  const { root, source } = await repository();
  try {
    // The fixed file already had an uncommitted edit, so a commit would carry it too.
    const dirty = await appliedFix(source, root, async () => { await writeFile(path.join(source, 'lib', 'catalog.dart'), 'const price = 7; // wip\n'); });
    const { instance } = workspace(root); await instance.initialize();
    const view = await instance.view(await dirty.resolve());
    assert.match(view.blocked ?? '', /had uncommitted edits before the fix/);
    await assert.rejects(instance.commit(await dirty.resolve(), { paths: ['lib/catalog.dart'], message: 'x', branch: { kind: 'new', name: 'sayspec/x' } }), /had uncommitted edits/);
  } finally { await rm(root, { recursive: true, force: true }); }

  const second = await repository();
  try {
    const fix = await appliedFix(second.source, second.root);
    const { instance } = workspace(second.root); await instance.initialize();
    await writeFile(path.join(second.source, 'lib', 'catalog.dart'), 'const price = 13;\n');
    assert.match((await instance.view(await fix.resolve())).blocked ?? '', /changed after SaySpec applied the fix/);
    await writeFile(path.join(second.source, 'lib', 'catalog.dart'), 'const price = 12;\n');
    const hook = path.join(second.source, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\necho "lint failed: catalog.dart" >&2\nexit 1\n'); await chmod(hook, 0o755);
    await assert.rejects(instance.commit(await fix.resolve(), { paths: ['lib/catalog.dart'], message: 'Fix: price', branch: { kind: 'new', name: 'sayspec/fix-price' } }), /Git did not commit\. lint failed: catalog\.dart/);
    assert.equal(git(second.source, 'branch', '--show-current'), 'main');
    assert.equal(git(second.source, 'branch', '--list', 'sayspec/fix-price'), '');
    assert.deepEqual(porcelain(second.source), [' M lib/catalog.dart']);
    assert.deepEqual((await instance.view(await fix.resolve())).commits, []);
  } finally { await rm(second.root, { recursive: true, force: true }); }
});

function draft(): PlaywrightGenerationDraft {
  const source = "import { test } from '@playwright/test';\n\ntest('checkout', async ({ page }) => {\n  await page.goto('/');\n});\n";
  return {
    schemaVersion: 1, id: 'generation_one', organizationId: 'org_team', projectId: 'project_shop', recordingId: 'recording_11111111-2222-3333-4444-555555555555', state: 'draft', title: 'Checkout',
    steps: [{ id: 'step_one', instruction: 'Open the cart', assertion: 'The cart lists two items', intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }],
    files: [{ id: 'file_one', relativePath: 'tests/checkout.spec.ts', text: source, sha256: sha(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' }],
    runtime: { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: 'tests/checkout.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, requirements: [] },
    provenance: { provider: 'codex', cliVersion: 'fixture', generatedAt: new Date().toISOString(), inputRevisionHash: 'a'.repeat(64), recordingId: 'recording_11111111-2222-3333-4444-555555555555', selectedEvidenceEventIds: [], executionValidated: true, published: false },
    unresolvedQuestions: [], warnings: [], validation: { status: 'passed', attempts: 1, passed: 1, failed: 0, summary: 'Passed', validatedAt: new Date().toISOString() },
  };
}

test('tests in a storage folder commit without the app code around them; cloud tests have no Git', async () => {
  const { root, source } = await repository();
  try {
    const folder = path.join(source, 'e2e'); await mkdir(folder);
    const settings = new TestStorageSettingsStore(path.join(root, 'test-storage.json')); await settings.initialize();
    const localWorkspace = new LocalWorkspaceStore(path.join(root, 'workspace.json')); await localWorkspace.initialize();
    const webTests = new SavedWebTestStore(path.join(root, 'web')); await webTests.initialize();
    const patrolTests = new PatrolRunStore(path.join(root, 'patrol')); await patrolTests.initialize();
    const cloudUploads = new CloudUploadQueue(path.join(root, 'cloud-uploads.json')); await cloudUploads.initialize();
    const storage = new TestStorage({ settings, localWorkspace, webTests, patrolTests, cloudUploads, localRoot: path.join(root, 'local-tests'), gitIdentity: async () => ({ name: 'Dev Person', email: 'dev@example.com' }) });
    const scope = { organizationId: 'org_team', projectId: 'project_shop' };
    await storage.configure(scope, { mode: 'folder', targetType: 'web', directory: folder });
    const version = await storage.saveGeneratedWebTest(draft());
    await writeFile(path.join(source, 'lib', 'other.dart'), 'const other = 3;\n');
    await writeFile(path.join(folder, 'README.md'), 'not a test\n');
    const handles = new DirectoryHandleRegistry();
    const { instance } = workspace(root); await instance.initialize();

    const all = await resolveGitTarget({ kind: 'tests', ...scope }, { handles, testStorage: storage });
    const view = await instance.view(all);
    assert.equal(view.changes.length, 1); assert.match(view.changes[0].path, /^e2e\/Just Recorded\/checkout\.spec\.ts$/);
    assert.equal(view.suggestedMessage, 'Update SaySpec tests');
    const one = await resolveGitTarget({ kind: 'tests', ...scope, testIds: [version.testId] }, { handles, testStorage: storage });
    assert.equal((await instance.view(one)).suggestedMessage, 'Update SaySpec test “Checkout”');
    const record = await instance.commit(one, { paths: [view.changes[0].path], message: 'Update SaySpec test “Checkout”', branch: { kind: 'new', name: 'sayspec/test-checkout' } });
    assert.equal(git(source, 'show', '--name-only', '--format=', 'HEAD'), 'e2e/Just Recorded/checkout.spec.ts');
    // The project-wide view lists commits made for single tests too.
    assert.equal((await instance.view(all)).commits[0]?.id, record.id);
    assert.deepEqual((await instance.view(all)).changes, []);

    await storage.configure(scope, { mode: 'cloud', targetType: 'web' });
    const cloud = await instance.view(await resolveGitTarget({ kind: 'tests', ...scope }, { handles, testStorage: storage }));
    assert.deepEqual([cloud.status.repository, cloud.status.note], [false, undefined]);
    const sourceView = await instance.view(await resolveGitTarget({ kind: 'source', sourceHandle: await handles.register(source) }, { handles }));
    assert.deepEqual([sourceView.status.repository, sourceView.status.branch, sourceView.changes], [true, 'sayspec/test-checkout', []]);
    const plain = await mkdtemp(path.join(tmpdir(), 'sayspec-plain-'));
    try { assert.equal((await instance.view(await resolveGitTarget({ kind: 'source', sourceHandle: await handles.register(plain) }, { handles }))).status.note, 'This folder is not a Git repository.'); }
    finally { await rm(plain, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
