import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CloudPatrolTestVersion, LibraryTest, PatrolSavedTest, PlaywrightGenerationDraft, PortableLibrary, PortableLibraryTest, SavedWebTestVersion, SuiteChange, TestLibraryScope, TestLibrarySnapshot, TestStorageCopyResult, TestStorageMode, TestStorageSettings, TestSuite } from '@sayspec/contracts';
import type { LocalWorkspaceStore } from '../local-workspace.ts';
import type { SavedWebTestStore } from '../execution/saved-web-tests.ts';
import type { PatrolRunStore } from '../flutter/patrol-store.ts';
import type { CloudUploadQueue } from './cloud-upload-queue.ts';
import { FolderTestLibrary, JUST_RECORDED, type FolderTest } from './folder-test-library.ts';
import { isTestFile } from './test-file-format.ts';
import type { TestStorageSettingsStore } from './test-storage-settings.ts';
import { INSTRUCTIONS_FILE, carryInstructions, type InstructionsLocation } from './test-instructions.ts';

type Identity = { name?: string; email?: string };
type TargetType = 'web' | 'flutter';
/**
 * Where this machine reads and writes a project's tests.
 * `guest`: Local storage of a guest project (the guest workspace).
 * `files`: a storage folder, or Local storage of a signed-in project (a folder SaySpec keeps).
 * `cloud`: SaySpec Cloud, read and written by the renderer through Firebase.
 * `missing-folder`: Folder storage whose folder this machine has not been given yet.
 */
type Backend = { kind: 'guest' } | { kind: 'files'; library: FolderTestLibrary } | { kind: 'cloud' } | { kind: 'missing-folder' };

/** The test ID a recording's generated Web test gets outside the guest workspace. */
export const recordingTestId = (recordingId: string) => `test_${recordingId.replace(/^recording_/, '').replaceAll('-', '_')}`;
const MISSING_FOLDER = 'This project keeps its tests in a folder. Choose where that folder is on this Mac under Settings → Test storage.';

/**
 * Routes test storage and retrieval for every storage a project can use.
 * SaySpec Cloud is read and written by the renderer; everything on this
 * machine (Local and Folder storage) goes through here.
 *
 * For file-backed storage the files are the source of truth. Each listing
 * copies new or changed files into the local version stores, which is what
 * runs, fixes and coding agents read, so every feature works the same in every
 * storage. Anything SaySpec saves (a generated test, an applied fix, an
 * import) is written back to the files.
 *
 * SaySpec Cloud works the same way for Flutter tests, with the renderer as the
 * go-between: a test saved here is queued until the renderer uploads it, and
 * the renderer pulls the cloud's current versions into the local store.
 */
export class TestStorage {
  readonly #settings: TestStorageSettingsStore;
  readonly #localWorkspace: LocalWorkspaceStore;
  readonly #webTests: SavedWebTestStore;
  readonly #patrolTests: PatrolRunStore;
  readonly #cloudUploads: CloudUploadQueue;
  readonly #localRoot: string;
  readonly #gitIdentity: (directory: string) => Promise<Identity>;
  #identity: Identity | null = null;

  /** `localRoot` is where SaySpec keeps Local storage for signed-in projects. */
  constructor(input: { settings: TestStorageSettingsStore; localWorkspace: LocalWorkspaceStore; webTests: SavedWebTestStore; patrolTests: PatrolRunStore; cloudUploads: CloudUploadQueue; localRoot: string; gitIdentity?: (directory: string) => Promise<Identity> }) {
    this.#settings = input.settings; this.#localWorkspace = input.localWorkspace; this.#webTests = input.webTests; this.#patrolTests = input.patrolTests; this.#cloudUploads = input.cloudUploads;
    this.#localRoot = path.resolve(input.localRoot);
    this.#gitIdentity = input.gitIdentity ?? readGitIdentity;
  }

  /** The signed-in person, written as the author of tests saved to files. */
  setIdentity(value: Identity | null) { this.#identity = value && (value.name?.trim() || value.email?.trim()) ? { name: value.name?.trim() || undefined, email: value.email?.trim() || undefined } : null; }

  /** The signed-in person, if any: Git falls back to it when a repository has no author configured. */
  author(): Identity | null { return this.#identity ? { ...this.#identity } : null; }

  /** Guest projects start on Local and signed-in projects on SaySpec Cloud until told otherwise. */
  mode(scope: TestLibraryScope): TestStorageMode { return this.#settings.get(scope.projectId)?.mode ?? (scope.organizationId === 'local' ? 'local' : 'cloud'); }

  /** SaySpec Cloud tests are authorized by Firebase; every other storage is authorized by being on this machine. */
  isCloud(scope: TestLibraryScope) { return this.mode(scope) === 'cloud'; }

  /** Tests kept as files on this machine (a storage folder, or a signed-in project's Local storage). */
  usesFiles(scope: TestLibraryScope) { const kind = this.#backend(scope).kind; return kind === 'files' || kind === 'missing-folder'; }

  async configure(scope: TestLibraryScope, value: { mode: TestStorageMode; targetType: TargetType; directory?: string }) {
    // Folder storage without a folder is allowed: a teammate's machine learns the choice before it knows where their checkout is.
    if (value.mode === 'cloud' && scope.organizationId === 'local') throw new Error('Sign in to keep tests in SaySpec Cloud.');
    const before = { mode: this.mode(scope), instructions: this.instructionsLocation(scope) };
    await this.#settings.configure(scope.projectId, value);
    // SAYSPEC.md moves with the tests; a copy already in the new storage wins.
    if (before.mode !== value.mode) await carryInstructions(before.instructions, this.instructionsLocation(scope)).catch(() => undefined);
    return this.settingsView(scope);
  }

  /**
   * Where the project's SAYSPEC.md lives on this machine: next to its tests.
   * A SaySpec Cloud project keeps this Mac's copy where its Local storage would
   * be, so switching to Local keeps it. Undefined when the storage folder is unknown.
   */
  instructionsLocation(scope: TestLibraryScope): InstructionsLocation | undefined {
    if (this.mode(scope) === 'folder') { const directory = this.#settings.get(scope.projectId)?.directory; return directory ? { directory, createIfMissing: false } : undefined; }
    try { return { directory: this.#localDirectory(scope), createIfMissing: true }; } catch { return undefined; }
  }

  async forget(projectId: string) { await this.#settings.forget(projectId); }

  async settingsView(scope: TestLibraryScope): Promise<TestStorageSettings> {
    const entry = this.#settings.get(scope.projectId);
    const mode = this.mode(scope);
    if (mode !== 'folder' || !entry?.directory) return { projectId: scope.projectId, mode };
    const available = await stat(entry.directory).then((value) => value.isDirectory(), () => false);
    return { projectId: scope.projectId, mode, folder: { label: path.basename(entry.directory), displayPath: displayPath(entry.directory), available } };
  }

  /** The folder behind Folder storage, for Show in Finder. */
  folderPath(projectId: string) { const entry = this.#settings.get(projectId); return entry?.mode === 'folder' ? entry.directory : undefined; }

  async library(scope: TestLibraryScope): Promise<TestLibrarySnapshot> {
    const backend = this.#backend(scope);
    if (backend.kind === 'files') {
      const { tests, suites, folderTests } = await backend.library.snapshot(scope.projectId);
      const issues = await this.#sync(scope, backend.library, folderTests);
      return { storage: this.mode(scope), suites, tests: tests.map((test) => issues.has(test.id) ? { ...test, issue: issues.get(test.id) } : test) };
    }
    const snapshot = this.#guest(scope, backend);
    return {
      storage: 'local',
      tests: snapshot.tests.filter((test) => test.projectId === scope.projectId && test.status !== 'archived').map((test): LibraryTest => ({ id: test.id, projectId: test.projectId, title: test.title, status: test.status, createdAt: test.createdAt, authorLabel: 'You', ...(test.recordingId ? { recordingId: test.recordingId } : {}) })),
      suites: snapshot.suites.filter((suite) => suite.projectId === scope.projectId),
    };
  }

  /** Brings the local version stores up to date with file-backed storage, e.g. before a run freezes versions. */
  async sync(scope: TestLibraryScope) {
    const backend = this.#backend(scope);
    if (backend.kind === 'files') await this.#sync(scope, backend.library, (await backend.library.scan()).tests);
  }

  async has(scope: TestLibraryScope, testId: string) {
    const backend = this.#backend(scope);
    if (backend.kind === 'files') return Boolean(await backend.library.find(testId));
    return this.#guest(scope, backend).tests.some((test) => test.id === testId && test.projectId === scope.projectId && test.status !== 'archived');
  }

  async renameTest(input: TestLibraryScope & { testId: string; title: string }) {
    const backend = this.#backend(input);
    if (backend.kind === 'files') return backend.library.rename(input.testId, input.title);
    this.#guest(input, backend); await this.#localWorkspace.renameTest(input);
  }

  async deleteTest(input: TestLibraryScope & { testId: string }) {
    const backend = this.#backend(input);
    if (backend.kind === 'files') return backend.library.remove(input.testId);
    this.#guest(input, backend); await this.#localWorkspace.deleteTest(input);
  }

  async saveSuite(input: TestLibraryScope & SuiteChange): Promise<TestSuite> {
    const backend = this.#backend(input);
    if (backend.kind === 'files') return backend.library.saveSuite(input);
    this.#guest(input, backend);
    const { organizationId: _organizationId, ...change } = input;
    return this.#localWorkspace.saveSuite(change);
  }

  async deleteSuite(input: TestLibraryScope & { suiteId: string }) {
    const backend = this.#backend(input);
    if (backend.kind === 'files') return backend.library.deleteSuite(input.suiteId);
    this.#guest(input, backend); await this.#localWorkspace.deleteSuite(input);
  }

  async moveTest(input: TestLibraryScope & { testId: string; targetSuiteId: string | null }) {
    const backend = this.#backend(input);
    if (backend.kind === 'files') return backend.library.move(input.testId, input.targetSuiteId);
    this.#guest(input, backend); await this.#localWorkspace.moveTestToSuite(input);
  }

  /** Saves a validated generated Web test in the project's storage and returns its version. */
  async saveGeneratedWebTest(generated: PlaywrightGenerationDraft): Promise<SavedWebTestVersion> {
    const backend = this.#backend(generated);
    if (backend.kind === 'missing-folder') throw new Error(MISSING_FOLDER);
    if (backend.kind === 'files') {
      // Generating again from the same recording updates that recording's test wherever it was moved.
      const existing = (await backend.library.scan()).tests.find((test) => test.header.recording === generated.recordingId);
      const version = await this.#webTests.saveGenerated(existing?.id ?? recordingTestId(generated.recordingId), generated);
      await this.#writeWebVersion(backend.library, version, { suite: JUST_RECORDED });
      return version;
    }
    const testId = backend.kind === 'guest'
      ? (await this.#localWorkspace.saveGeneratedTest({ projectId: generated.projectId, recordingId: generated.recordingId, title: generated.title, folder: 'Generated tests', tags: ['recording'], status: 'generated', versionCount: 0 })).id
      : recordingTestId(generated.recordingId);
    return this.#webTests.saveGenerated(testId, generated);
  }

  /** Records a saved Patrol test in the project's storage. */
  async savePatrolTest(test: PatrolSavedTest) {
    const backend = this.#backend(test);
    if (backend.kind === 'missing-folder') throw new Error(MISSING_FOLDER);
    if (backend.kind === 'files') await backend.library.write({ id: test.id, title: test.title, source: test.source, author: await this.#author(backend.library.root), recordingId: test.recordingCaptureId, entrypoint: test.relativePath, suite: JUST_RECORDED });
    else if (backend.kind === 'guest') await this.#localWorkspace.saveGeneratedTest({ projectId: test.projectId, recordingId: test.recordingCaptureId!, title: test.title, folder: 'Generated tests', tags: ['flutter', 'patrol'], status: 'generated', versionCount: test.version, testId: test.id });
    else await this.#cloudUploads.add({ organizationId: test.organizationId, projectId: test.projectId, testId: test.id, versionId: test.versionId });
  }

  /**
   * Records a new version of an existing Patrol test (an applied fix): file
   * storage gets the new source in the test's current file, and SaySpec Cloud
   * gets it on the next upload. A guest project reads versions from this Mac's store.
   */
  async savePatrolVersion(test: PatrolSavedTest) {
    const backend = this.#backend(test);
    if (backend.kind === 'missing-folder') throw new Error(MISSING_FOLDER);
    if (backend.kind === 'files') await backend.library.write({ id: test.id, title: test.title, source: test.source, author: await this.#author(backend.library.root), recordingId: test.recordingCaptureId, entrypoint: test.relativePath, suite: null });
    else if (backend.kind === 'cloud') await this.#cloudUploads.add({ organizationId: test.organizationId, projectId: test.projectId, testId: test.id, versionId: test.versionId });
  }

  /** Flutter tests saved on this Mac that SaySpec Cloud does not hold yet, each at its latest version. */
  pendingCloudPatrolTests(scope: TestLibraryScope): PatrolSavedTest[] {
    if (!this.isCloud(scope)) return [];
    return this.#cloudUploads.pending(scope).flatMap((entry) => this.#patrolTests.versions(scope.projectId, scope.organizationId, entry.testId).slice(0, 1));
  }

  /** SaySpec Cloud now holds `versionId`, so the test is no longer pending unless a newer version was saved meanwhile. */
  async markCloudPatrolUploaded(scope: TestLibraryScope, testId: string, versionId: string) {
    const entry = this.#cloudUploads.pending(scope).find((item) => item.testId === testId);
    if (!entry) return;
    const versions = this.#patrolTests.versions(scope.projectId, scope.organizationId, testId);
    const uploaded = versions.find((item) => item.versionId === versionId);
    const queued = versions.find((item) => item.versionId === entry.versionId);
    if (uploaded && (!queued || queued.version <= uploaded.version)) await this.#cloudUploads.remove(scope, testId, entry.versionId);
  }

  /**
   * Saves SaySpec Cloud's current Flutter test versions in the local store,
   * which is what runs read. A test with an upload still pending keeps this
   * Mac's newer version until the upload succeeds.
   */
  async pullCloudPatrolTests(scope: TestLibraryScope, versions: readonly CloudPatrolTestVersion[]) {
    if (!this.isCloud(scope)) throw new Error('This project does not keep its tests in SaySpec Cloud.');
    const failed: string[] = [];
    for (const version of versions) {
      if (this.#cloudUploads.has(scope, version.testId)) continue;
      try {
        if (createHash('sha256').update(version.source).digest('hex') !== version.contentHash) throw new Error('its source does not match its hash');
        await this.#patrolTests.saveTest({
          ...scope, testId: version.testId, title: version.title, relativePath: version.relativePath, source: version.source, state: 'published',
          ...(version.recordingId ? { recordingCaptureId: version.recordingId } : {}), ...(version.dependencies ? { dependencies: version.dependencies } : {}),
          ...(version.appVersion ? { appVersion: version.appVersion } : {}), ...(version.provider ? { provider: version.provider } : {}),
        });
      } catch (error) { failed.push(`“${version.title}”: ${error instanceof Error ? error.message : 'it could not be saved'}`); }
    }
    if (failed.length) throw new Error(`Some tests could not be copied from SaySpec Cloud. ${failed.join('; ')}`);
  }

  /**
   * Where a file-backed project's tests are, for committing them to Git: the
   * files of `testIds` (relative to the folder) with their titles, or, without
   * IDs, a filter for the files SaySpec keeps there. Undefined when the tests
   * are not files on this machine.
   */
  async gitLocation(scope: TestLibraryScope, testIds?: readonly string[]): Promise<{ directory: string; paths?: string[]; titles: string[]; include?: (relativePath: string) => boolean } | undefined> {
    const backend = this.#backend(scope);
    if (backend.kind !== 'files' || !await backend.library.available()) return undefined;
    const { library } = backend;
    if (!testIds?.length) {
      // The folder may be a whole repository; only test files, their support files, suite markers and SAYSPEC.md are SaySpec's.
      const include = (relativePath: string) => isTestFile(path.posix.basename(relativePath), library.framework) || relativePath.startsWith('.sayspec/') || path.posix.basename(relativePath) === '.gitkeep' || relativePath === INSTRUCTIONS_FILE;
      return { directory: library.root, titles: [], include };
    }
    const found = (await library.scan()).tests.filter((test) => testIds.includes(test.id));
    return { directory: library.root, paths: found.flatMap((test) => [test.relativePath, `.sayspec/files/${test.id}`]), titles: found.map((test) => test.title) };
  }

  /** Writes a new Web version (an applied fix) back to file-backed storage; other storage already holds it. */
  async saveWebVersion(version: SavedWebTestVersion) {
    const backend = this.#backend(version);
    if (backend.kind === 'files') await this.#writeWebVersion(backend.library, version, { suite: null });
  }

  /** Lists an imported Web test in the project's storage. */
  async saveImportedWebTest(version: SavedWebTestVersion) {
    const backend = this.#backend(version);
    if (backend.kind === 'files') return this.#writeWebVersion(backend.library, version, { suite: null });
    if (backend.kind === 'guest') await this.#localWorkspace.indexImportedTest({ projectId: version.projectId, testId: version.testId, title: version.title });
  }

  /** Every test and suite in the project's storage on this machine, with each test's latest source. */
  async export(scope: TestLibraryScope): Promise<PortableLibrary> {
    const backend = this.#backend(scope);
    if (backend.kind === 'files') {
      const { suites, folderTests } = await backend.library.snapshot(scope.projectId);
      await this.#sync(scope, backend.library, folderTests);
      return { suites: suites.map((suite) => suite.name), tests: folderTests.map((test) => this.#portable(scope, { id: test.id, title: test.title, suite: test.suite, createdAt: test.createdAt, recordingId: test.header.recording, authorLabel: test.header.author })) };
    }
    const { tests, suites } = await this.library(scope);
    return { suites: suites.map((suite) => suite.name), tests: tests.map((test) => this.#portable(scope, { id: test.id, title: test.title, suite: suites.find((suite) => suite.testIds.includes(test.id))?.name ?? null, createdAt: test.createdAt, recordingId: test.recordingId })) };
  }

  /**
   * Copies tests into Local or Folder storage without switching the project to
   * it. Tests keep their IDs, titles, suites and authors; a test already in the
   * destination is updated rather than duplicated.
   */
  async import(scope: TestLibraryScope, target: { mode: Exclude<TestStorageMode, 'cloud'>; targetType: TargetType; directory?: string }, library: PortableLibrary): Promise<TestStorageCopyResult> {
    const result: TestStorageCopyResult = { copied: 0, failed: [] };
    const framework = target.targetType === 'flutter' ? 'patrol' : 'playwright';
    const needsSource = (test: PortableLibraryTest) => framework === 'playwright' ? test.web : test.patrol;
    if (target.mode === 'local' && scope.organizationId === 'local') return this.#importIntoGuest(scope, library, needsSource, result);
    const directory = target.mode === 'folder' ? target.directory ?? this.#settings.get(scope.projectId)?.directory : this.#localDirectory(scope);
    if (!directory) throw new Error('Choose a folder for this project’s tests.');
    const destination = new FolderTestLibrary(directory, framework, { createIfMissing: target.mode === 'local' });
    if (!await destination.available()) throw new Error('The chosen folder is unavailable.');
    for (const name of library.suites) if (name !== JUST_RECORDED) await destination.ensureSuite(name);
    const author = await this.#author(directory);
    for (const test of library.tests) {
      try {
        if (!needsSource(test)) throw new Error('Its source is not on this Mac.');
        const suite = test.suite ? (test.suite === JUST_RECORDED ? JUST_RECORDED : await destination.ensureSuite(test.suite)) : null;
        const common = { id: test.id, title: test.title, author: test.authorLabel || author, recordingId: test.recordingId, suite, created: test.createdAt };
        if (test.web) {
          const entry = test.web.files.find((file) => file.relativePath === test.web!.runtime.entrypoint);
          if (!entry) throw new Error('It has no entry file.');
          await destination.write({ ...common, source: entry.text, entrypoint: test.web.runtime.entrypoint, steps: test.web.steps.map((step) => ({ instruction: step.instruction, assertion: step.assertion })), supportFiles: test.web.files.filter((file) => file !== entry).map((file) => ({ relativePath: file.relativePath, text: file.text })) });
        } else await destination.write({ ...common, source: test.patrol!.source, entrypoint: test.patrol!.relativePath, recordingId: test.patrol!.recordingCaptureId ?? test.recordingId });
        result.copied += 1;
      } catch (error) { result.failed.push({ title: test.title, reason: error instanceof Error ? error.message : 'It could not be copied.' }); }
    }
    await this.#sync(scope, destination, (await destination.scan()).tests);
    return result;
  }

  async #importIntoGuest(scope: TestLibraryScope, library: PortableLibrary, needsSource: (test: PortableLibraryTest) => unknown, result: TestStorageCopyResult) {
    const project = this.#localWorkspace.snapshot().projects.find((item) => item.id === scope.projectId);
    if (!project) throw new Error('Local project was not found.');
    const copied: PortableLibraryTest[] = [];
    for (const test of library.tests) {
      try {
        if (!needsSource(test)) throw new Error('Its source is not on this Mac.');
        if (test.web) {
          const entry = test.web.files.find((file) => file.relativePath === test.web!.runtime.entrypoint);
          if (!entry) throw new Error('It has no entry file.');
          await this.#webTests.saveFolderVersion({ ...scope, testId: test.id, title: test.title, recordingId: test.recordingId, entrypoint: test.web.runtime.entrypoint, files: test.web.files, steps: test.web.steps, runtime: test.web.runtime, provenance: test.web.provenance });
        } else await this.#patrolTests.saveTest({ ...scope, testId: test.id, title: test.title, relativePath: test.patrol!.relativePath, source: test.patrol!.source, ...(test.patrol!.recordingCaptureId ? { recordingCaptureId: test.patrol!.recordingCaptureId } : {}), ...(test.patrol!.dependencies ? { dependencies: test.patrol!.dependencies } : {}), ...(test.patrol!.provider ? { provider: test.patrol!.provider } : {}), ...(test.patrol!.appVersion ? { appVersion: test.patrol!.appVersion } : {}) });
        await this.#localWorkspace.saveGeneratedTest({ testId: test.id, projectId: scope.projectId, title: test.title, folder: 'Copied tests', tags: [], status: 'generated', versionCount: 1, ...(test.recordingId ? { recordingId: test.recordingId } : {}) });
        copied.push(test); result.copied += 1;
      } catch (error) { result.failed.push({ title: test.title, reason: error instanceof Error ? error.message : 'It could not be copied.' }); }
    }
    const suiteIds = new Map<string, string>();
    for (const name of library.suites) {
      if (name === JUST_RECORDED) continue;
      const existing = this.#localWorkspace.snapshot().suites.find((suite) => suite.projectId === scope.projectId && suite.name.toLowerCase() === name.toLowerCase());
      suiteIds.set(name, existing?.id ?? (await this.#localWorkspace.saveSuite({ projectId: scope.projectId, suiteId: `suite_${randomUUID()}`, expectedRevision: 0, name, testIds: [] })).id);
    }
    // A test with a recording lands in a "Just Recorded" suite; everything else goes where it was.
    for (const test of copied) if (test.suite !== JUST_RECORDED) await this.#localWorkspace.moveTestToSuite({ projectId: scope.projectId, testId: test.id, targetSuiteId: test.suite ? suiteIds.get(test.suite) ?? null : null });
    return result;
  }

  #portable(scope: TestLibraryScope, test: Omit<PortableLibraryTest, 'web' | 'patrol'>): PortableLibraryTest {
    const web = this.#webTests.versions(scope.organizationId, scope.projectId, test.id).sort((left, right) => right.version - left.version)[0];
    const patrol = this.#patrolTests.versions(scope.projectId, scope.organizationId, test.id)[0];
    return {
      ...test,
      ...(web ? { web: { title: web.title, steps: web.steps, files: web.files, runtime: web.runtime, provenance: web.provenance, ...(web.recordingId ? { recordingId: web.recordingId } : {}) } } : {}),
      ...(patrol ? { patrol: { title: patrol.title, relativePath: patrol.relativePath, source: patrol.source, ...(patrol.recordingCaptureId ? { recordingCaptureId: patrol.recordingCaptureId } : {}), ...(patrol.dependencies ? { dependencies: patrol.dependencies } : {}), ...(patrol.provider ? { provider: patrol.provider } : {}), ...(patrol.appVersion ? { appVersion: patrol.appVersion } : {}) } } : {}),
    };
  }

  #backend(scope: TestLibraryScope): Backend {
    const entry = this.#settings.get(scope.projectId);
    const mode = this.mode(scope);
    const framework = (entry?.targetType ?? this.#localWorkspace.snapshot().projects.find((project) => project.id === scope.projectId)?.targetType) === 'flutter' ? 'patrol' : 'playwright';
    if (mode === 'folder') return entry?.directory ? { kind: 'files', library: new FolderTestLibrary(entry.directory, framework) } : { kind: 'missing-folder' };
    if (mode === 'cloud') return { kind: 'cloud' };
    if (scope.organizationId === 'local') return { kind: 'guest' };
    return { kind: 'files', library: new FolderTestLibrary(this.#localDirectory(scope), framework, { createIfMissing: true }) };
  }

  /** Local storage for a signed-in project: a folder SaySpec keeps, in the same format as Folder storage. */
  #localDirectory(scope: TestLibraryScope) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/.test(scope.organizationId) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/.test(scope.projectId)) throw new Error('Project scope is invalid.');
    return path.join(this.#localRoot, scope.organizationId, scope.projectId);
  }

  #guest(scope: TestLibraryScope, backend: Backend) {
    if (backend.kind === 'missing-folder') throw new Error(MISSING_FOLDER);
    if (backend.kind === 'cloud') throw new Error('This project keeps its tests in SaySpec Cloud.');
    const snapshot = this.#localWorkspace.snapshot();
    if (!snapshot.projects.some((project) => project.id === scope.projectId)) throw new Error('Local project was not found.');
    return snapshot;
  }

  async #writeWebVersion(library: FolderTestLibrary, version: SavedWebTestVersion, options: { suite: string | null }) {
    const entry = version.files.find((file) => file.relativePath === version.runtime.entrypoint);
    if (!entry) throw new Error('The saved test has no entry file.');
    await library.write({
      id: version.testId, title: version.title, source: entry.text, author: await this.#author(library.root),
      recordingId: version.recordingId, entrypoint: version.runtime.entrypoint, suite: options.suite,
      steps: version.steps.map((step) => ({ instruction: step.instruction, assertion: step.assertion })),
      supportFiles: version.files.filter((file) => file !== entry).map((file) => ({ relativePath: file.relativePath, text: file.text })),
    });
  }

  /** Returns, per test, why its file could not become a runnable version. */
  async #sync(scope: TestLibraryScope, library: FolderTestLibrary, tests: readonly FolderTest[]) {
    const issues = new Map<string, string>();
    for (const test of tests) {
      const fileName = path.posix.basename(test.relativePath);
      try {
        if (library.framework === 'playwright') {
          const entrypoint = test.header.entrypoint?.endsWith('.spec.ts') ? test.header.entrypoint : fileName;
          const support = (await library.supportFiles(test.id)).filter((file) => file.relativePath !== entrypoint);
          await this.#webTests.saveFolderVersion({ ...scope, testId: test.id, title: test.title, recordingId: test.header.recording, entrypoint, files: [{ relativePath: entrypoint, text: test.source }, ...support], steps: test.header.steps });
        } else {
          const relativePath = test.header.entrypoint && /^patrol_test\/[A-Za-z0-9_./-]+\.dart$/.test(test.header.entrypoint) ? test.header.entrypoint : `patrol_test/${fileName}`;
          await this.#patrolTests.saveTest({ ...scope, testId: test.id, title: test.title, relativePath, source: test.source, ...(test.header.recording ? { recordingCaptureId: test.header.recording } : {}) });
        }
      } catch (error) { issues.set(test.id, error instanceof Error ? error.message : 'This file cannot be run by SaySpec.'); }
    }
    return issues;
  }

  async #author(directory: string) {
    const identity = this.#identity ?? await this.#gitIdentity(directory).catch(() => ({}) as Identity);
    const name = identity.name || (identity.email ? undefined : os.userInfo().username);
    return name && identity.email ? `${name} <${identity.email}>` : name ?? identity.email;
  }
}


function displayPath(directory: string) {
  const home = os.homedir();
  return directory === home || directory.startsWith(`${home}${path.sep}`) ? `~${directory.slice(home.length)}` : directory;
}

function git(directory: string, key: string) {
  return new Promise<string | undefined>((resolve) => execFile('git', ['config', '--get', key], { cwd: directory, timeout: 3_000 }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined)));
}

/** The folder's git identity: the same name a commit of the test would carry. */
async function readGitIdentity(directory: string): Promise<Identity> {
  const [name, email] = await Promise.all([git(directory, 'user.name'), git(directory, 'user.email')]);
  return { name, email };
}
