import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PlaywrightGenerationDraft } from '@sayspec/contracts';
import { SavedWebTestStore } from '../execution/saved-web-tests.ts';
import { PatrolRunStore } from '../flutter/patrol-store.ts';
import { LocalWorkspaceStore } from '../local-workspace.ts';
import { CloudUploadQueue } from './cloud-upload-queue.ts';
import { FolderTestLibrary } from './folder-test-library.ts';
import { dartSuiteFolderName, moveDartImports, parseTestFile, serializeTestFile } from './test-file-format.ts';
import { TestStorage } from './test-storage.ts';
import { TestStorageSettingsStore } from './test-storage-settings.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const SOURCE = "import { test, expect } from '@playwright/test';\n\ntest('checkout', async ({ page }) => {\n  await page.goto('/');\n});\n";
function draft(source = SOURCE, recordingId = 'recording_11111111-2222-3333-4444-555555555555'): PlaywrightGenerationDraft {
  return {
    schemaVersion: 1, id: 'generation_one', organizationId: 'org_team', projectId: 'project_shop', recordingId, state: 'draft', title: 'Checkout with saved address',
    steps: [{ id: 'step_one', instruction: 'Open the cart', assertion: 'The cart lists two items', intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }],
    files: [{ id: 'file_one', relativePath: 'tests/checkout.spec.ts', text: source, sha256: sha(source), byteLength: Buffer.byteLength(source), mimeType: 'text/typescript' }],
    runtime: { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: 'tests/checkout.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, requirements: [] },
    provenance: { provider: 'codex', cliVersion: 'fixture', generatedAt: new Date().toISOString(), inputRevisionHash: 'a'.repeat(64), recordingId, selectedEvidenceEventIds: [], executionValidated: true, published: false },
    unresolvedQuestions: [], warnings: [], validation: { status: 'passed', attempts: 1, passed: 1, failed: 0, summary: 'Passed', validatedAt: new Date().toISOString() },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-test-storage-'));
  const folder = path.join(root, 'repo', 'e2e'); await mkdir(folder, { recursive: true });
  const settings = new TestStorageSettingsStore(path.join(root, 'test-storage.json')); await settings.initialize();
  const localWorkspace = new LocalWorkspaceStore(path.join(root, 'workspace.json')); await localWorkspace.initialize();
  const webTests = new SavedWebTestStore(path.join(root, 'web')); await webTests.initialize();
  const patrolTests = new PatrolRunStore(path.join(root, 'patrol')); await patrolTests.initialize();
  const cloudUploads = new CloudUploadQueue(path.join(root, 'cloud-uploads.json')); await cloudUploads.initialize();
  const storage = new TestStorage({ settings, localWorkspace, webTests, patrolTests, cloudUploads, localRoot: path.join(root, 'local-tests'), gitIdentity: async () => ({ name: 'Git Person', email: 'git@example.com' }) });
  return { root, folder, settings, localWorkspace, webTests, patrolTests, cloudUploads, storage, scope: { organizationId: 'org_team', projectId: 'project_shop' } };
}

test('the header round-trips metadata and leaves the source byte-for-byte intact', () => {
  const header = { id: 'test_one', title: 'Checkout', author: 'Jane Doe <jane@example.com>', created: '2026-09-26T10:00:00.000Z', steps: [{ instruction: 'Open\nthe cart', assertion: 'Two items' }] };
  const parsed = parseTestFile(serializeTestFile(header, SOURCE));
  assert.equal(parsed.source, SOURCE);
  assert.deepEqual(parsed.header, { id: 'test_one', title: 'Checkout', author: 'Jane Doe <jane@example.com>', created: '2026-09-26T10:00:00.000Z', steps: [{ instruction: 'Open the cart', assertion: 'Two items' }] });
  // Source comments that look like tags are not header fields.
  const plain = "// @ts-expect-error: fixture\nimport x from 'y';\n";
  assert.deepEqual(parseTestFile(plain), { header: { steps: [] }, source: plain });
  assert.equal(parseTestFile(serializeTestFile({ steps: [] }, '\nleading blank')).source, '\nleading blank');
});

test('Local storage for a guest project keeps using the guest workspace', async () => {
  const { root, localWorkspace, webTests, storage } = await fixture();
  try {
    const project = await localWorkspace.createProject({ name: 'Shop', targetType: 'web', baseUrl: 'https://shop.test' });
    const generated = await storage.saveGeneratedWebTest({ ...draft(), organizationId: 'local', projectId: project.id });
    const library = await storage.library({ organizationId: 'local', projectId: project.id });
    assert.equal(library.storage, 'local');
    assert.deepEqual(library.tests.map((item) => [item.id, item.title, item.authorLabel]), [[generated.testId, 'Checkout with saved address', 'You']]);
    assert.equal(library.suites[0].name, 'Just Recorded');
    assert.equal(webTests.versions('local', project.id, generated.testId).length, 1);
    await assert.rejects(storage.library({ organizationId: 'org_team', projectId: 'project_cloud' }), /keeps its tests in SaySpec Cloud/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('folder storage writes generated tests as files in a Just Recorded suite folder, with their author', async () => {
  const { root, folder, webTests, storage, scope } = await fixture();
  try {
    await storage.configure(scope, { mode: 'folder', targetType: 'web', directory: folder });
    storage.setIdentity({ name: 'Jane Doe', email: 'jane@example.com' });
    const version = await storage.saveGeneratedWebTest(draft());
    const text = await readFile(path.join(folder, 'Just Recorded', 'checkout-with-saved-address.spec.ts'), 'utf8');
    assert.match(text, /^\/\/ SaySpec test/);
    assert.match(text, /\/\/ @author: Jane Doe <jane@example.com>/);
    assert.match(text, /\/\/ @step: Open the cart\n\/\/ @expect: The cart lists two items/);
    assert.ok(text.endsWith(SOURCE));

    const library = await storage.library(scope);
    assert.equal(library.storage, 'folder');
    assert.deepEqual(library.tests.map((item) => [item.id, item.title, item.authorLabel, item.relativePath]), [[version.testId, 'Checkout with saved address', 'Jane Doe', 'Just Recorded/checkout-with-saved-address.spec.ts']]);
    assert.equal(library.suites[0].name, 'Just Recorded');
    assert.ok(library.suites[0].sourceRecordingId);
    // Reading the file back does not create a second version.
    assert.equal(webTests.versions(scope.organizationId, scope.projectId, version.testId).length, 1);

    // Without a signed-in person, the folder's git identity is the author.
    storage.setIdentity(null);
    await storage.saveGeneratedWebTest(draft(SOURCE, 'recording_99999999-2222-3333-4444-555555555555'));
    assert.ok((await storage.library(scope)).tests.some((item) => item.authorLabel === 'Git Person'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('suites are folders: create, move into, rename and empty Just Recorded disappearing', async () => {
  const { root, folder, storage, scope } = await fixture();
  try {
    await storage.configure(scope, { mode: 'folder', targetType: 'web', directory: folder });
    const version = await storage.saveGeneratedWebTest(draft());
    const suite = await storage.saveSuite({ ...scope, suiteId: 'suite_new', expectedRevision: 0, name: 'Checkout flows', testIds: [] });
    await assert.rejects(storage.saveSuite({ ...scope, suiteId: 'suite_other', expectedRevision: 0, name: 'checkout flows', testIds: [] }), /already exists/);
    // Helper folders in a repository are not suites, and cannot be taken over by one.
    await mkdir(path.join(folder, 'fixtures')); await writeFile(path.join(folder, 'fixtures', 'cart.json'), '{}');
    assert.deepEqual((await storage.library(scope)).suites.map((item) => item.name), ['Checkout flows', 'Just Recorded']);
    await assert.rejects(storage.saveSuite({ ...scope, suiteId: 'suite_fixtures', expectedRevision: 0, name: 'fixtures', testIds: [] }), /already exists/);
    await storage.moveTest({ ...scope, testId: version.testId, targetSuiteId: suite.id });
    assert.deepEqual((await readdir(folder)).sort(), ['Checkout flows', 'fixtures']);
    await assert.rejects(storage.deleteSuite({ ...scope, suiteId: suite.id }), /Only an empty suite/);
    await assert.rejects(storage.moveTest({ ...scope, testId: version.testId, targetSuiteId: 'suite_missing' }), /not found/);

    await storage.saveSuite({ ...scope, suiteId: suite.id, expectedRevision: 1, name: 'Payments', testIds: [version.testId] });
    await storage.renameTest({ ...scope, testId: version.testId, title: 'Pay with saved card' });
    const library = await storage.library(scope);
    assert.deepEqual(library.suites.map((item) => [item.name, item.testIds]), [['Payments', [version.testId]]]);
    assert.deepEqual(library.tests.map((item) => [item.title, item.relativePath]), [['Pay with saved card', 'Payments/pay-with-saved-card.spec.ts']]);

    await storage.moveTest({ ...scope, testId: version.testId, targetSuiteId: null });
    assert.equal((await storage.library(scope)).tests[0].relativePath, 'pay-with-saved-card.spec.ts');
    // The emptied suite folder can be deleted; the helper folder next to it is not a suite and stays.
    await storage.deleteSuite({ ...scope, suiteId: (await storage.library(scope)).suites[0].id });
    assert.deepEqual((await storage.library(scope)).suites, []);
    assert.deepEqual((await readdir(folder)).filter((name) => !name.startsWith('.')).sort(), ['fixtures', 'pay-with-saved-card.spec.ts']);
    await storage.deleteTest({ ...scope, testId: version.testId });
    assert.deepEqual((await storage.library(scope)).tests, []);
    assert.equal(await storage.has(scope, version.testId), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an edited or hand-written file becomes the next runnable version, and fixes are written back', async () => {
  const { root, folder, webTests, storage, scope } = await fixture();
  try {
    await storage.configure(scope, { mode: 'folder', targetType: 'web', directory: folder });
    const first = await storage.saveGeneratedWebTest(draft());
    const file = path.join(folder, 'Just Recorded', 'checkout-with-saved-address.spec.ts');
    const edited = (await readFile(file, 'utf8')).replace("page.goto('/')", "page.goto('/cart')");
    await writeFile(file, edited);
    await storage.library(scope);
    const versions = webTests.versions(scope.organizationId, scope.projectId, first.testId).sort((left, right) => right.version - left.version);
    assert.equal(versions.length, 2);
    assert.match(versions[0].files[0].text, /\/cart/);
    assert.equal(versions[0].state, 'generated');
    assert.deepEqual(versions[0].steps, first.steps);

    // A teammate's file with no SaySpec header is listed and runnable too.
    await writeFile(path.join(folder, 'smoke.spec.ts'), SOURCE);
    const library = await storage.library(scope);
    const handWritten = library.tests.find((item) => item.relativePath === 'smoke.spec.ts')!;
    assert.equal(handWritten.title, 'smoke');
    assert.equal(webTests.versions(scope.organizationId, scope.projectId, handWritten.id)[0].runtime.entrypoint, 'smoke.spec.ts');

    // A new version saved by SaySpec (such as an applied fix) replaces the file's source but keeps its header.
    const fixedSource = SOURCE.replace("'/'", "'/checkout'");
    await storage.saveWebVersion({ ...versions[0], files: [{ ...versions[0].files[0], text: fixedSource }] });
    const fixed = parseTestFile(await readFile(file, 'utf8'));
    assert.equal(fixed.source, fixedSource);
    assert.equal(fixed.header.id, first.testId);
    assert.ok(fixed.header.updated);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Patrol folder tests sync into the Patrol store and non-Patrol files are flagged', async () => {
  const { root, folder, patrolTests, storage, scope } = await fixture();
  try {
    await storage.configure(scope, { mode: 'folder', targetType: 'flutter', directory: folder });
    const saved = await patrolTests.saveTest({ ...scope, title: 'Receipt total', relativePath: 'patrol_test/receipt_test.dart', source: "import 'package:patrol/patrol.dart';\nvoid main(){ patrolTest('receipt', ($) async {}); }\n", recordingCaptureId: 'capture_one' });
    await storage.savePatrolTest(saved);
    await writeFile(path.join(folder, 'broken_test.dart'), 'void main() {}\n');
    const library = await storage.library(scope);
    assert.deepEqual(library.tests.map((item) => [item.title, item.relativePath, Boolean(item.issue)]).sort(), [['Receipt total', 'Just Recorded/receipt_total_test.dart', false], ['broken', 'broken_test.dart', true]]);
    assert.equal(patrolTests.listTests(scope.projectId, scope.organizationId).length, 1);
    assert.equal(await new FolderTestLibrary(folder, 'patrol').find(saved.id).then((item) => item?.header.entrypoint), 'patrol_test/receipt_test.dart');
  } finally { await rm(root, { recursive: true, force: true }); }
});

const patrolSource = (label: string) => `import 'package:patrol/patrol.dart';\nvoid main(){ patrolTest('${label}', ($) async {}); }\n`;
const shopTest = (helper: string) => `import 'package:patrol/patrol.dart';\nimport '${helper}';\nvoid main(){ patrolTest('cart', ($) async {}); }\n`;

test('Dart suite folders and moved Dart files keep import paths working', () => {
  assert.equal(dartSuiteFolderName('Cart flows'), 'Cart_flows');
  assert.equal(dartSuiteFolderName('  Košarica & plaćanje '), 'Kosarica_placanje');
  assert.throws(() => dartSuiteFolderName('!!!'), /letter or digit/);
  const source = "import 'package:patrol/patrol.dart';\nimport 'dart:io';\nimport 'support/shop.dart' as shop;\nexport \"../lib/fixtures.dart\";\npart 'cart_part.dart';\n// import 'not/a/directive.dart';\n";
  const inCart = moveDartImports(source, 'patrol_test/cart_test.dart', 'patrol_test/Cart/cart_test.dart');
  assert.equal(inCart, "import 'package:patrol/patrol.dart';\nimport 'dart:io';\nimport '../support/shop.dart' as shop;\nexport \"../../lib/fixtures.dart\";\npart '../cart_part.dart';\n// import 'not/a/directive.dart';\n");
  // Between suites at the same depth only a file next to the test is reached differently.
  assert.equal(moveDartImports("import 'helper.dart';\n" + inCart, 'patrol_test/Cart/cart_test.dart', 'patrol_test/PDP/cart_test.dart'), "import '../Cart/helper.dart';\n" + inCart);
  assert.equal(moveDartImports(source, 'patrol_test/a_test.dart', 'patrol_test/b_test.dart'), source);
});

test('a Flutter project keeps its tests in its patrol_test/, where Patrol runs each file as it is', async () => {
  const { root, folder, patrolTests, storage, scope } = await fixture();
  try {
    const tests = path.join(folder, 'patrol_test');
    await writeFile(path.join(folder, 'pubspec.yaml'), 'name: shop\n');
    await mkdir(path.join(tests, 'support'), { recursive: true });
    await writeFile(path.join(tests, 'support', 'shop.dart'), 'void launch() {}\n');
    await writeFile(path.join(tests, 'cart_test.dart'), shopTest('support/shop.dart'));
    // Choosing the project folder means its patrol_test/.
    await storage.configure(scope, { mode: 'folder', targetType: 'flutter', directory: folder });
    assert.deepEqual((await storage.settingsView(scope)).folder, { label: 'patrol_test', displayPath: tests, available: true });
    assert.equal(storage.inPlaceRoot(scope), tests);
    const [cart] = (await storage.library(scope)).tests;
    assert.equal(cart.relativePath, 'cart_test.dart');
    assert.equal(patrolTests.versions(scope.projectId, scope.organizationId, cart.id)[0].relativePath, 'patrol_test/cart_test.dart');

    // A suite is a folder Dart can import from, read back with its spaces; the helper folder is no suite.
    const suite = await storage.saveSuite({ ...scope, suiteId: 'suite_new', expectedRevision: 0, name: 'Cart flows', testIds: [] });
    assert.equal(suite.name, 'Cart flows');
    await storage.moveTest({ ...scope, testId: cart.id, targetSuiteId: suite.id });
    const moved = parseTestFile(await readFile(path.join(tests, 'Cart_flows', 'cart_test.dart'), 'utf8'));
    assert.equal(moved.header.id, cart.id);
    assert.equal(moved.source, shopTest('../support/shop.dart'));
    assert.deepEqual((await storage.library(scope)).suites.map((item) => [item.name, item.testIds]), [['Cart flows', [cart.id]]]);
    assert.deepEqual((await readdir(tests)).sort(), ['Cart_flows', 'support']);
    // Runs use the moved file itself; no copy is left at the old path.
    const latest = patrolTests.versions(scope.projectId, scope.organizationId, cart.id)[0];
    assert.deepEqual([latest.relativePath, latest.source], ['patrol_test/Cart_flows/cart_test.dart', moved.source]);

    // A generated test lands in Just_Recorded/ and still reaches the helpers it was written against.
    const generated = await patrolTests.saveTest({ ...scope, title: 'Receipt total', relativePath: 'patrol_test/receipt_test.dart', source: shopTest('support/shop.dart'), recordingCaptureId: 'capture_one' });
    await storage.savePatrolTest(generated);
    const file = parseTestFile(await readFile(path.join(tests, 'Just_Recorded', 'receipt_total_test.dart'), 'utf8'));
    assert.deepEqual([file.source, file.header.entrypoint], [shopTest('../support/shop.dart'), undefined]);
    assert.equal(patrolTests.versions(scope.projectId, scope.organizationId, generated.id)[0].relativePath, 'patrol_test/Just_Recorded/receipt_total_test.dart');
    const library = await storage.library(scope);
    assert.deepEqual(library.suites.map((item) => [item.name, Boolean(item.sourceRecordingId)]), [['Cart flows', false], ['Just Recorded', true]]);
    assert.deepEqual((await storage.export(scope)).tests.map((item) => item.suite).sort(), ['Cart flows', 'Just Recorded']);
    await assert.rejects(storage.moveTest({ ...scope, testId: cart.id, targetSuiteId: library.suites[1].id }), /cannot be moved into a Just Recorded suite/);

    // Choosing patrol_test/ itself means the same folder; a folder outside a Flutter project keeps its tests as they are.
    await storage.configure(scope, { mode: 'folder', targetType: 'flutter', directory: tests });
    assert.equal(storage.inPlaceRoot(scope), tests);
    await storage.configure(scope, { mode: 'folder', targetType: 'flutter', directory: root });
    assert.equal(storage.inPlaceRoot(scope), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SaySpec Cloud Flutter tests saved here wait in the upload queue until the renderer uploads them', async () => {
  const { root, patrolTests, cloudUploads, storage, scope } = await fixture();
  try {
    await storage.configure(scope, { mode: 'cloud', targetType: 'flutter' });
    const first = await patrolTests.saveTest({ ...scope, title: 'Receipt total', relativePath: 'patrol_test/receipt_test.dart', source: patrolSource('receipt'), appVersion: '2.4.0+57', state: 'published' });
    await storage.savePatrolTest(first);
    assert.deepEqual(storage.pendingCloudPatrolTests(scope).map((item) => [item.id, item.versionId, item.appVersion]), [[first.id, first.versionId, '2.4.0+57']]);
    // A newer version saved during the upload stays pending after the older one is acknowledged.
    const second = await patrolTests.saveTest({ ...scope, testId: first.id, title: 'Receipt total', relativePath: 'patrol_test/receipt_test.dart', source: patrolSource('receipt v2'), state: 'published' });
    await storage.savePatrolTest(second);
    await storage.markCloudPatrolUploaded(scope, first.id, first.versionId);
    assert.deepEqual(storage.pendingCloudPatrolTests(scope).map((item) => item.versionId), [second.versionId]);
    await storage.markCloudPatrolUploaded(scope, first.id, second.versionId);
    assert.deepEqual(storage.pendingCloudPatrolTests(scope), []);
    // The queue survives a restart.
    await storage.savePatrolTest(second);
    const reloaded = new CloudUploadQueue(path.join(root, 'cloud-uploads.json')); await reloaded.initialize();
    assert.deepEqual(reloaded.pending(scope), [{ ...scope, testId: first.id, versionId: second.versionId }]);
    assert.equal(cloudUploads.has(scope, first.id), true);
    // Projects in other storages never queue uploads.
    await storage.configure(scope, { mode: 'local', targetType: 'flutter' });
    assert.deepEqual(storage.pendingCloudPatrolTests(scope), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SaySpec Cloud Flutter tests are pulled into the Patrol store, keeping newer versions still waiting to upload', async () => {
  const { root, patrolTests, storage, scope } = await fixture();
  try {
    await storage.configure(scope, { mode: 'cloud', targetType: 'flutter' });
    const teammate = { testId: 'patrol_test_teammate', title: 'Teammate checkout', relativePath: 'patrol_test/checkout_test.dart', source: patrolSource('checkout'), contentHash: sha(patrolSource('checkout')), appVersion: '2.4.0+57', dependencies: { patrol: '3.11.0' }, recordingId: 'flutter_capture_teammate', provider: 'codex' as const };
    await storage.pullCloudPatrolTests(scope, [teammate]);
    const pulled = patrolTests.listTests(scope.projectId, scope.organizationId);
    assert.deepEqual(pulled.map((item) => [item.id, item.title, item.contentHash, item.appVersion, item.recordingCaptureId, item.state]), [['patrol_test_teammate', 'Teammate checkout', teammate.contentHash, '2.4.0+57', 'flutter_capture_teammate', 'published']]);
    assert.deepEqual(storage.pendingCloudPatrolTests(scope), [], 'pulled tests are not uploaded back');
    // Pulling the same version again keeps one local version.
    await storage.pullCloudPatrolTests(scope, [teammate]);
    assert.equal(patrolTests.versions(scope.projectId, scope.organizationId, teammate.testId).length, 1);
    // A version made on this Mac and not uploaded yet is not replaced by the cloud's older one.
    const mine = await patrolTests.saveTest({ ...scope, testId: teammate.testId, title: 'Teammate checkout', relativePath: teammate.relativePath, source: patrolSource('checkout, edited here'), state: 'published' });
    await storage.savePatrolTest(mine);
    await storage.pullCloudPatrolTests(scope, [teammate]);
    assert.equal(patrolTests.versions(scope.projectId, scope.organizationId, teammate.testId)[0].contentHash, mine.contentHash);
    // Source that does not match its hash is refused.
    await assert.rejects(storage.pullCloudPatrolTests(scope, [{ ...teammate, testId: 'patrol_test_corrupt', contentHash: 'f'.repeat(64) }]), /Teammate checkout.*hash/);
    await storage.configure(scope, { mode: 'local', targetType: 'flutter' });
    await assert.rejects(storage.pullCloudPatrolTests(scope, [teammate]), /SaySpec Cloud/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('storage settings remember a project’s folder across modes and restarts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-test-storage-settings-'));
  try {
    const file = path.join(root, 'settings.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, projects: { project_old: { mode: 'sayspec' } } }));
    const settings = new TestStorageSettingsStore(file); await settings.initialize();
    // Entries from before the three storages are dropped, so the project falls back to its default.
    assert.equal(settings.get('project_old'), undefined);
    await settings.configure('project_one', { mode: 'folder', targetType: 'web', directory: root });
    await settings.configure('project_one', { mode: 'cloud', targetType: 'web' });
    const restored = new TestStorageSettingsStore(file); await restored.initialize();
    assert.deepEqual(restored.get('project_one'), { mode: 'cloud', targetType: 'web', directory: root });
    await restored.configure('project_one', { mode: 'folder', targetType: 'web' });
    assert.equal(restored.get('project_one')?.directory, root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Local storage for a signed-in project is a folder SaySpec keeps, and Cloud stays with the renderer', async () => {
  const { root, storage, scope } = await fixture();
  try {
    assert.equal(storage.mode(scope), 'cloud');
    assert.equal(storage.isCloud(scope), true);
    await storage.configure(scope, { mode: 'local', targetType: 'web' });
    storage.setIdentity({ name: 'Jane Doe', email: 'jane@example.com' });
    const version = await storage.saveGeneratedWebTest(draft());
    const library = await storage.library(scope);
    assert.equal(library.storage, 'local');
    assert.deepEqual(library.tests.map((item) => [item.id, item.authorLabel]), [[version.testId, 'Jane Doe']]);
    assert.ok((await readdir(path.join(root, 'local-tests', scope.organizationId, scope.projectId))).includes('Just Recorded'));
    assert.deepEqual(await storage.settingsView(scope), { projectId: scope.projectId, mode: 'local' });
    await assert.rejects(storage.configure({ organizationId: 'local', projectId: 'project_guest' }, { mode: 'cloud', targetType: 'web' }), /Sign in/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Folder storage without a folder on this Mac asks for it instead of losing tests', async () => {
  const { root, folder, storage, scope } = await fixture();
  try {
    await storage.configure(scope, { mode: 'folder', targetType: 'web' });
    assert.deepEqual(await storage.settingsView(scope), { projectId: scope.projectId, mode: 'folder' });
    await assert.rejects(storage.library(scope), /Choose where that folder is/);
    await assert.rejects(storage.saveGeneratedWebTest(draft()), /Choose where that folder is/);
    const view = await storage.configure(scope, { mode: 'folder', targetType: 'web', directory: folder });
    assert.equal(view.folder?.label, 'e2e');
    assert.equal(view.folder?.available, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('switching storage copies tests with their suites, authors and sources', async () => {
  const { root, folder, localWorkspace, webTests, storage } = await fixture();
  try {
    // A guest project on Local storage, with a test in a suite and one in Just Recorded.
    const project = await localWorkspace.createProject({ name: 'Shop', targetType: 'web', baseUrl: 'https://shop.test' });
    const guest = { organizationId: 'local', projectId: project.id };
    const moved = await storage.saveGeneratedWebTest({ ...draft(), organizationId: 'local', projectId: project.id });
    const fresh = await storage.saveGeneratedWebTest({ ...draft(SOURCE.replace("'/'", "'/fresh'"), 'recording_99999999-2222-3333-4444-555555555555'), organizationId: 'local', projectId: project.id, title: 'Fresh test' });
    const suite = await storage.saveSuite({ ...guest, suiteId: 'suite_payments', expectedRevision: 0, name: 'Payments', testIds: [] });
    await storage.moveTest({ ...guest, testId: moved.testId, targetSuiteId: suite.id });

    // Local → Folder.
    const exported = await storage.export(guest);
    assert.deepEqual(exported.tests.map((item) => [item.title, item.suite, Boolean(item.web)]).sort(), [['Checkout with saved address', 'Payments', true], ['Fresh test', 'Just Recorded', true]]);
    const copied = await storage.import(guest, { mode: 'folder', targetType: 'web', directory: folder }, exported);
    assert.deepEqual(copied, { copied: 2, failed: [] });
    await storage.configure(guest, { mode: 'folder', targetType: 'web', directory: folder });
    const inFolder = await storage.library(guest);
    assert.deepEqual(inFolder.tests.map((item) => [item.id, item.relativePath]).sort(), [[fresh.testId, 'Just Recorded/fresh-test.spec.ts'], [moved.testId, 'Payments/checkout-with-saved-address.spec.ts']].sort());
    // The copy reuses the saved versions instead of making new ones.
    assert.equal(webTests.versions('local', project.id, moved.testId).length, 1);

    // Folder → Local brings them back into the guest workspace, in the same suites.
    await writeFile(path.join(folder, 'Payments', 'refund.spec.ts'), SOURCE.replace("'/'", "'/refund'"));
    const fromFolder = await storage.export(guest);
    const back = await storage.import(guest, { mode: 'local', targetType: 'web' }, fromFolder);
    assert.equal(back.copied, 3);
    await storage.configure(guest, { mode: 'local', targetType: 'web' });
    const local = await storage.library(guest);
    const payments = local.suites.find((item) => item.name === 'Payments')!;
    assert.equal(local.tests.length, 3);
    assert.equal(payments.testIds.length, 2);
    assert.ok(local.suites.find((item) => item.name === 'Just Recorded')?.testIds.includes(fresh.testId));

    // A test whose source is missing is reported, not silently dropped.
    const failed = await storage.import(guest, { mode: 'folder', targetType: 'web', directory: folder }, { suites: [], tests: [{ id: 'test_missing', title: 'Missing source', suite: null }] });
    assert.deepEqual(failed, { copied: 0, failed: [{ title: 'Missing source', reason: 'Its source is not on this Mac.' }] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
