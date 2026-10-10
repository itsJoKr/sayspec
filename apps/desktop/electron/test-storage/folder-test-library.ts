import { mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isSafeRelativePath, type LibraryTest, type TestSuite } from '@sayspec/contracts';
import { fileTestId, isTestFile, isValidTestId, parseTestFile, serializeTestFile, suiteFolderName, suiteIdFor, testFileStem, testFileSuffix, type TestFileHeader, type TestFileStep, type TestFramework } from './test-file-format.ts';

export const JUST_RECORDED = 'Just Recorded';
const SKIPPED_FOLDERS = new Set(['node_modules', 'build', 'dist', 'test-results', 'playwright-report']);
const SUPPORT_ROOT = path.join('.sayspec', 'files');
const MAX_DEPTH = 8;
const MAX_FILES = 5_000;
const MAX_TEST_BYTES = 512 * 1024;

export interface FolderTest {
  id: string; title: string; header: TestFileHeader; source: string;
  /** Path from the storage root, with `/` separators. */
  relativePath: string;
  /** The suite folder the test sits in; tests at the root are unassigned. */
  suite: string | null;
  createdAt: string;
}
export interface FolderSupportFile { relativePath: string; text: string }
export interface FolderTestWrite {
  id: string; title: string; source: string;
  author?: string; recordingId?: string; entrypoint?: string; steps?: readonly TestFileStep[];
  /** Extra files the test imports, kept under `.sayspec/files/<id>/` so moving a test between suites never breaks them. */
  supportFiles?: readonly FolderSupportFile[];
  /** Suite for a new test; an existing test stays where it is. */
  suite?: string | null;
  /** Creation time for a new test copied from another storage. */
  created?: string;
}

/**
 * Tests stored as files in a folder the user chose, usually inside a git
 * repository. Every top-level folder is a suite; tests at the root are
 * unassigned. Metadata lives in each file's header, so there is no index to
 * keep in sync and a teammate's `git pull` is picked up on the next scan.
 */
export class FolderTestLibrary {
  readonly root: string;
  readonly framework: TestFramework;
  readonly #createIfMissing: boolean;

  /** `createIfMissing` is for a folder SaySpec owns (Local storage); a folder the user chose must already exist. */
  constructor(root: string, framework: TestFramework, options: { createIfMissing?: boolean } = {}) { this.root = path.resolve(root); this.framework = framework; this.#createIfMissing = options.createIfMissing ?? false; }

  async available() {
    if (this.#createIfMissing) await mkdir(this.root, { recursive: true });
    return stat(this.root).then((value) => value.isDirectory(), () => false);
  }

  async scan(): Promise<{ tests: FolderTest[]; suites: string[] }> {
    if (!await this.available()) throw new Error('The test storage folder is unavailable. Choose it again under Settings → Test storage.');
    const folders = (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && this.#visibleFolder(entry.name)).map((entry) => entry.name).sort((left, right) => left.localeCompare(right));
    const files: string[] = [];
    await this.#walk('', 0, files);
    const tests: FolderTest[] = []; const ids = new Set<string>();
    for (const relativePath of files.sort((left, right) => left.localeCompare(right))) {
      const absolute = path.join(this.root, relativePath);
      const metadata = await stat(absolute);
      if (metadata.size > MAX_TEST_BYTES) continue;
      const { header, source } = parseTestFile(await readFile(absolute, 'utf8'));
      // A copied file keeps its original's @id; the copy gets a path-derived ID instead of shadowing it.
      const id = isValidTestId(header.id) && !ids.has(header.id) ? header.id : fileTestId(relativePath);
      ids.add(id);
      const segments = relativePath.split('/');
      tests.push({
        id, header, source, relativePath,
        title: header.title || path.basename(relativePath).slice(0, -testFileSuffix(this.framework).length).replace(/[-_]+/g, ' ').trim() || 'Untitled test',
        suite: segments.length > 1 ? segments[0] : null,
        createdAt: header.created && !Number.isNaN(Date.parse(header.created)) ? header.created : metadata.birthtime.toISOString(),
      });
    }
    // A folder is a suite when it holds tests, or is a new suite that is still empty. Helper folders in a
    // repository (fixtures, utils) are not suites.
    const suites: string[] = [];
    for (const folder of folders) {
      if (tests.some((test) => test.suite === folder)) { suites.push(folder); continue; }
      const entries = await readdir(path.join(this.root, folder)).catch(() => ['?']);
      if (entries.every((name) => name === '.gitkeep' || name === '.DS_Store')) suites.push(folder);
    }
    return { tests, suites };
  }

  async snapshot(projectId: string): Promise<{ tests: LibraryTest[]; suites: TestSuite[]; folderTests: FolderTest[] }> {
    const { tests, suites } = await this.scan();
    const updatedAt = new Date().toISOString();
    return {
      folderTests: tests,
      tests: tests.map((test) => ({ id: test.id, projectId, title: test.title, status: 'generated', createdAt: test.createdAt, relativePath: test.relativePath, ...(test.header.recording ? { recordingId: test.header.recording } : {}), ...(test.header.author ? { authorLabel: authorLabel(test.header.author) } : {}) })),
      suites: suites.map((name) => {
        const members = tests.filter((test) => test.suite === name);
        // The renderer treats a named "Just Recorded" suite with a source recording as the staging area for fresh tests.
        const recording = name === JUST_RECORDED ? members.find((test) => test.header.recording)?.header.recording ?? 'folder' : undefined;
        return { id: suiteIdFor(name), projectId, name, testIds: members.map((test) => test.id), revision: 1, updatedAt, ...(recording ? { sourceRecordingId: recording } : {}) };
      }),
    };
  }

  async find(testId: string) { return (await this.scan()).tests.find((test) => test.id === testId); }

  async supportFiles(testId: string): Promise<FolderSupportFile[]> {
    if (!isValidTestId(testId)) return [];
    const base = path.join(this.root, SUPPORT_ROOT, testId);
    const found: FolderSupportFile[] = [];
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) return;
      const entries = await readdir(path.join(base, relative), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const next = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(next, depth + 1);
        else if (entry.isFile() && isSafeRelativePath(next)) found.push({ relativePath: next, text: await readFile(path.join(base, next), 'utf8') });
      }
    };
    await walk('', 0);
    return found.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  /** Creates a test file, or updates the one with the same ID (or recording) in place, keeping its title, author and location. */
  async write(input: FolderTestWrite): Promise<FolderTest> {
    if (!isValidTestId(input.id)) throw new Error('Test ID is invalid.');
    const { tests } = await this.scan();
    const existing = tests.find((test) => test.id === input.id) ?? (input.recordingId ? tests.find((test) => test.header.recording === input.recordingId) : undefined);
    const now = new Date().toISOString();
    let relativePath: string; let header: TestFileHeader;
    if (existing) {
      relativePath = existing.relativePath;
      header = { ...existing.header, id: existing.id, author: existing.header.author || input.author, entrypoint: input.entrypoint ?? existing.header.entrypoint, recording: existing.header.recording ?? input.recordingId, steps: [...(input.steps ?? existing.header.steps)] };
      if (existing.source !== input.source) header.updated = now;
    } else {
      const folder = input.suite ? suiteFolderName(input.suite) : '';
      if (folder) await mkdir(path.join(this.root, folder), { recursive: true });
      relativePath = await this.#freeName(folder, testFileStem(input.title, this.framework));
      header = { id: input.id, title: input.title.trim(), author: input.author, created: input.created && !Number.isNaN(Date.parse(input.created)) ? input.created : now, recording: input.recordingId, entrypoint: input.entrypoint, steps: [...(input.steps ?? [])] };
    }
    const body = serializeTestFile(header, input.source);
    // Saving the same version again must not touch the file, or it shows up as a change in git.
    if (!existing || existing.source !== input.source || JSON.stringify(existing.header) !== JSON.stringify(header)) await atomicWrite(path.join(this.root, relativePath), body);
    if (input.supportFiles) await this.#writeSupportFiles(existing?.id ?? input.id, input.supportFiles);
    return { id: existing?.id ?? input.id, title: header.title || existing?.title || input.title, header, source: input.source, relativePath, suite: relativePath.includes('/') ? relativePath.split('/')[0] : null, createdAt: header.created ?? now };
  }

  /** Renames the test's title and its file, so the folder stays readable in a git diff. */
  async rename(testId: string, title: string) {
    const clean = title.trim().slice(0, 120);
    if (!clean) throw new Error('Test name is required.');
    const test = await this.#require(testId);
    const folder = test.suite ?? '';
    const current = path.posix.basename(test.relativePath);
    const wanted = `${testFileStem(clean, this.framework)}${testFileSuffix(this.framework)}`;
    const relativePath = current === wanted ? test.relativePath : await this.#freeName(folder, testFileStem(clean, this.framework));
    await atomicWrite(path.join(this.root, relativePath), serializeTestFile({ ...test.header, id: test.id, title: clean }, test.source));
    if (relativePath !== test.relativePath) await unlink(path.join(this.root, test.relativePath));
  }

  async remove(testId: string) {
    const test = await this.#require(testId);
    await unlink(path.join(this.root, test.relativePath));
    await rm(path.join(this.root, SUPPORT_ROOT, test.id), { recursive: true, force: true });
    await this.#pruneJustRecorded();
  }

  /** Creates a suite folder, or renames the one behind `suiteId`. */
  async saveSuite(input: { projectId: string; suiteId: string; name: string }): Promise<TestSuite> {
    const name = suiteFolderName(input.name);
    const { suites, tests } = await this.scan();
    const current = suites.find((folder) => suiteIdFor(folder) === input.suiteId);
    if (current !== name) {
      const taken = suites.some((folder) => folder.toLowerCase() === name.toLowerCase() && folder !== current) || (current?.toLowerCase() !== name.toLowerCase() && await stat(path.join(this.root, name)).then(() => true, () => false));
      if (taken) throw new Error(`A suite or folder named “${name}” already exists.`);
      if (current) await rename(path.join(this.root, current), path.join(this.root, name));
      else { await mkdir(path.join(this.root, name)); await writeFile(path.join(this.root, name, '.gitkeep'), ''); }
    }
    return { id: suiteIdFor(name), projectId: input.projectId, name, testIds: tests.filter((test) => test.suite === (current ?? name)).map((test) => test.id), revision: 1, updatedAt: new Date().toISOString() };
  }

  /** Makes sure a suite folder exists, keeping an existing one (and its tests) as it is. */
  async ensureSuite(name: string) {
    const folder = suiteFolderName(name);
    const existing = (await readdir(this.root, { withFileTypes: true })).find((entry) => entry.isDirectory() && entry.name.toLowerCase() === folder.toLowerCase());
    if (existing) return existing.name;
    await mkdir(path.join(this.root, folder)); await writeFile(path.join(this.root, folder, '.gitkeep'), '');
    return folder;
  }

  async move(testId: string, suiteId: string | null) {
    const { tests, suites } = await this.scan();
    const test = tests.find((item) => item.id === testId);
    if (!test) throw new Error('The test was not found in the storage folder.');
    const target = suiteId === null ? null : suites.find((folder) => suiteIdFor(folder) === suiteId);
    if (suiteId !== null && !target) throw new Error('The destination suite was not found.');
    if (target === test.suite) return;
    if (target === JUST_RECORDED) throw new Error('Tests cannot be moved into a Just Recorded suite.');
    const relativePath = await this.#freeName(target ?? '', path.posix.basename(test.relativePath).slice(0, -testFileSuffix(this.framework).length));
    await rename(path.join(this.root, test.relativePath), path.join(this.root, relativePath));
    await this.#pruneJustRecorded();
  }

  async #require(testId: string) {
    const test = await this.find(testId);
    if (!test) throw new Error('The test was not found in the storage folder.');
    return test;
  }

  #visibleFolder(name: string) { return !name.startsWith('.') && !SKIPPED_FOLDERS.has(name); }

  async #walk(relative: string, depth: number, files: string[]): Promise<void> {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    for (const entry of await readdir(path.join(this.root, relative), { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && this.#visibleFolder(entry.name)) await this.#walk(next, depth + 1, files);
      else if (entry.isFile() && isTestFile(entry.name, this.framework) && files.length < MAX_FILES) files.push(next);
    }
  }

  async #freeName(folder: string, stem: string) {
    const suffix = testFileSuffix(this.framework);
    for (let attempt = 1; attempt < 1_000; attempt += 1) {
      const name = `${stem}${attempt === 1 ? '' : `${this.framework === 'patrol' ? '_' : '-'}${attempt}`}${suffix}`;
      const relativePath = folder ? `${folder}/${name}` : name;
      if (!await stat(path.join(this.root, relativePath)).then(() => true, () => false)) return relativePath;
    }
    throw new Error('Could not find a free file name for the test.');
  }

  async #writeSupportFiles(testId: string, files: readonly FolderSupportFile[]) {
    const base = path.join(this.root, SUPPORT_ROOT, testId);
    await rm(base, { recursive: true, force: true });
    for (const file of files) {
      if (!isSafeRelativePath(file.relativePath)) throw new Error('A support file path is unsafe.');
      const destination = path.join(base, file.relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await atomicWrite(destination, file.text);
    }
  }

  /** "Just Recorded" only stages fresh tests, so its folder goes away once it holds none. */
  async #pruneJustRecorded() {
    const folder = path.join(this.root, JUST_RECORDED);
    const entries = await readdir(folder).catch(() => undefined);
    if (!entries || entries.some((name) => name !== '.gitkeep' && name !== '.DS_Store')) return;
    await rm(path.join(folder, '.gitkeep'), { force: true }); await rm(path.join(folder, '.DS_Store'), { force: true });
    await rmdir(folder).catch(() => undefined);
  }
}

/** "Jane Doe <jane@example.com>" reads as "Jane Doe" in the library. */
export function authorLabel(author: string) { return author.replace(/\s*<[^>]*>\s*$/, '').trim() || author.replace(/[<>]/g, '').trim(); }

async function atomicWrite(destination: string, body: string) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.tmp`);
  await writeFile(temporary, body, 'utf8');
  await rename(temporary, destination);
}
