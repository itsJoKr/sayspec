import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CreateLocalProjectInput, LocalProject, LocalTest, LocalWorkspaceSnapshot, SuiteChange, TestSuite } from '@sayspec/contracts';

type StoredWorkspace = { schemaVersion: 1; projects: LocalProject[]; tests: LocalTest[]; suites: TestSuite[] };
const emptyWorkspace = (): StoredWorkspace => ({ schemaVersion: 1, projects: [], tests: [], suites: [] });
const JUST_RECORDED = 'Just Recorded';
// "Just Recorded" suites are staging areas for fresh recordings: tests are moved out of them, never into them, and they disappear once empty.
export const isJustRecordedSuite = (suite: Pick<TestSuite, 'name' | 'sourceRecordingId'>) => Boolean(suite.sourceRecordingId) && suite.name === JUST_RECORDED;

function cleanText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim().slice(0, maxLength);
}

function cleanBaseUrl(value: unknown) {
  const input = cleanText(value, 'Base URL', 2_048);
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Web projects require a complete URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Base URL must use HTTP(S) and cannot contain credentials.');
  return url.href;
}

export class LocalWorkspaceStore {
  readonly #filePath: string;
  #state: StoredWorkspace = emptyWorkspace();
  #write = Promise.resolve();

  constructor(filePath: string) { this.#filePath = filePath; }

  async initialize() {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, 'utf8')) as Partial<StoredWorkspace>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.tests)) throw new Error('Unsupported local workspace data.');
      this.#state = { schemaVersion: 1, projects: parsed.projects, tests: parsed.tests, suites: Array.isArray(parsed.suites) ? parsed.suites : [] };
      if (this.#pruneSuites()) await this.#persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.#persist();
    }
  }

  snapshot(): LocalWorkspaceSnapshot {
    return structuredClone(this.#state);
  }

  async createProject(input: CreateLocalProjectInput): Promise<LocalProject> {
    const name = cleanText(input.name, 'Project name', 100);
    if (input.targetType !== 'web' && input.targetType !== 'flutter') throw new Error('Choose Web or Flutter.');
    if (input.targetType === 'flutter' && !input.sourceLabel) throw new Error('A Flutter source folder is required.');
    const baseUrl = input.targetType === 'web' ? cleanBaseUrl(input.baseUrl) : undefined;
    const project: LocalProject = {
      id: `local_project_${randomUUID()}`,
      name,
      targetType: input.targetType,
      ...(baseUrl ? { baseUrl } : {}),
      ...(input.sourceLabel ? { sourceLabel: cleanText(input.sourceLabel, 'Source folder', 200) } : {}),
      createdAt: new Date().toISOString(),
    };
    this.#state.projects.push(project);
    await this.#persist();
    return structuredClone(project);
  }

  async deleteProject(input: { projectId: string }): Promise<void> {
    if (!this.#state.projects.some((project) => project.id === input.projectId)) throw new Error('Local project was not found.');
    this.#state.projects = this.#state.projects.filter((project) => project.id !== input.projectId);
    this.#state.tests = this.#state.tests.filter((test) => test.projectId !== input.projectId);
    this.#state.suites = this.#state.suites.filter((suite) => suite.projectId !== input.projectId);
    await this.#persist();
  }

  async renameTest(input: { projectId: string; testId: string; title: string }): Promise<LocalTest> {
    const test = this.#findTest(input.projectId, input.testId);
    test.title = cleanText(input.title, 'Test name', 120);
    await this.#persist();
    return structuredClone(test);
  }

  async deleteTest(input: { projectId: string; testId: string }): Promise<void> {
    const test = this.#findTest(input.projectId, input.testId);
    this.#state.tests = this.#state.tests.filter((item) => item !== test);
    this.#pruneSuites();
    await this.#persist();
  }

  async saveSuite(input: SuiteChange): Promise<TestSuite> {
    if (!this.#state.projects.some((project) => project.id === input.projectId)) throw new Error('Local project was not found.');
    if (!/^suite_[a-zA-Z0-9_-]{1,127}$/.test(input.suiteId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('Suite revision or ID is invalid.');
    const name = cleanText(input.name, 'Suite name', 120);
    if (!Array.isArray(input.testIds) || input.testIds.length > 500 || new Set(input.testIds).size !== input.testIds.length || input.testIds.some((id) => !this.#state.tests.some((test) => test.projectId === input.projectId && test.id === id && test.status !== 'archived'))) throw new Error('Suite membership must contain unique active tests from this project.');
    const suite = this.#state.suites.find((item) => item.id === input.suiteId && item.projectId === input.projectId);
    if ((suite?.revision ?? 0) !== input.expectedRevision || (!suite && input.expectedRevision !== 0)) throw new Error('Suite changed elsewhere. Reload before saving.');
    const updated: TestSuite = { id: input.suiteId, projectId: input.projectId, name, testIds: [...input.testIds], revision: input.expectedRevision + 1, updatedAt: new Date().toISOString(), ...(input.sourceRecordingId ? { sourceRecordingId: input.sourceRecordingId } : suite?.sourceRecordingId ? { sourceRecordingId: suite.sourceRecordingId } : {}) };
    if (suite) Object.assign(suite, updated); else this.#state.suites.push(updated);
    await this.#persist(); return structuredClone(updated);
  }

  /** Deletes a suite that holds no tests. */
  async deleteSuite(input: { projectId: string; suiteId: string }): Promise<void> {
    const suite = this.#state.suites.find((item) => item.id === input.suiteId && item.projectId === input.projectId);
    if (!suite) throw new Error('The suite was not found.');
    if (suite.testIds.length) throw new Error('Only an empty suite can be deleted. Move its tests out first.');
    this.#state.suites = this.#state.suites.filter((item) => item !== suite);
    await this.#persist();
  }

  async moveTestToSuite(input: { projectId: string; testId: string; targetSuiteId: string | null }): Promise<void> {
    const test = this.#findTest(input.projectId, input.testId);
    if (test.status === 'archived') throw new Error('Archived tests cannot be moved.');
    if (input.targetSuiteId !== null && !/^suite_[a-zA-Z0-9_-]{1,127}$/.test(input.targetSuiteId)) throw new Error('Suite ID is invalid.');
    const suites = this.#state.suites.filter((suite) => suite.projectId === input.projectId);
    const target = input.targetSuiteId === null ? undefined : suites.find((suite) => suite.id === input.targetSuiteId);
    if (input.targetSuiteId && !target) throw new Error('The destination suite was not found.');
    if (target && isJustRecordedSuite(target) && !target.testIds.includes(test.id)) throw new Error('Tests cannot be moved into a Just Recorded suite.');
    const alreadyInTarget = target?.testIds.includes(test.id) ?? false;
    for (const suite of suites) {
      const shouldContain = suite === target;
      const nextTestIds = suite.testIds.filter((id) => id !== test.id);
      if (shouldContain && !nextTestIds.includes(test.id)) nextTestIds.push(test.id);
      if (JSON.stringify(nextTestIds) !== JSON.stringify(suite.testIds)) {
        suite.testIds = nextTestIds;
        suite.revision += 1;
        suite.updatedAt = new Date().toISOString();
      }
    }
    if (target && !alreadyInTarget && !target.testIds.includes(test.id)) target.testIds.push(test.id);
    this.#pruneSuites();
    await this.#persist();
  }

  async saveGeneratedTest(input: Omit<LocalTest, 'id' | 'createdAt'> & { testId?: string }): Promise<LocalTest> {
    if (!this.#state.projects.some((project) => project.id === input.projectId)) throw new Error('Local project was not found.');
    if (input.recordingId) {
      const existing = this.#state.tests.find((test) => test.projectId === input.projectId && test.recordingId === input.recordingId);
      if (existing) {
        if (existing.status !== 'archived') existing.status = 'generated';
        if (existing.status !== 'archived') {
          existing.versionCount = Math.max(existing.versionCount, input.versionCount);
          existing.tags = [...new Set([...existing.tags, ...input.tags])];
        }
        if (existing.status !== 'archived' && !this.#state.suites.some((suite) => suite.projectId === existing.projectId && (suite.sourceRecordingId === existing.recordingId || suite.testIds.includes(existing.id)))) this.#ensureRecordingSuite(existing);
        await this.#persist();
        return structuredClone(existing);
      }
    }
    if (input.testId && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(input.testId)) throw new Error('Generated test ID is invalid.');
    const { testId, ...fields } = input;
    const test: LocalTest = { ...fields, title: cleanText(input.title, 'Test name', 120), id: testId ?? `local_test_${randomUUID()}`, createdAt: new Date().toISOString() };
    this.#state.tests.push(test);
    if (test.recordingId) this.#ensureRecordingSuite(test);
    await this.#persist(); return structuredClone(test);
  }

  async indexImportedTest(input: { projectId: string; testId: string; title: string }): Promise<LocalTest> {
    if (!this.#state.projects.some((project) => project.id === input.projectId && project.targetType === 'web')) throw new Error('Local Web project was not found.');
    if (!/^import_[a-zA-Z0-9_-]{1,127}$/.test(input.testId) || this.#state.tests.some((test) => test.id === input.testId)) throw new Error('Imported test ID already exists or is invalid.');
    const test: LocalTest = { id: input.testId, projectId: input.projectId, title: cleanText(input.title, 'Test name', 120), folder: 'Imported tests', tags: ['import'], status: 'generated', versionCount: 1, createdAt: new Date().toISOString() };
    this.#state.tests.push(test); await this.#persist(); return structuredClone(test);
  }

  #findTest(projectId: string, testId: string) {
    const test = this.#state.tests.find((item) => item.id === testId && item.projectId === projectId);
    if (!test) throw new Error('Local test was not found.');
    return test;
  }

  /** Drops deleted or archived tests from suite membership and removes Just Recorded suites left empty. */
  #pruneSuites() {
    const active = new Set(this.#state.tests.filter((test) => test.status !== 'archived').map((test) => `${test.projectId}\u0000${test.id}`));
    let changed = false;
    for (const suite of this.#state.suites) {
      const testIds = suite.testIds.filter((id) => active.has(`${suite.projectId}\u0000${id}`));
      if (testIds.length === suite.testIds.length) continue;
      suite.testIds = testIds;
      suite.revision += 1;
      suite.updatedAt = new Date().toISOString();
      changed = true;
    }
    const suites = this.#state.suites.filter((suite) => !(isJustRecordedSuite(suite) && suite.testIds.length === 0));
    if (suites.length !== this.#state.suites.length) { this.#state.suites = suites; changed = true; }
    return changed;
  }

  #ensureRecordingSuite(test: LocalTest) {
    const suites = this.#state.suites.filter((suite) => suite.projectId === test.projectId);
    const recordingSuite = suites.find((suite) => suite.sourceRecordingId === test.recordingId);
    if (suites.some((suite) => suite.testIds.includes(test.id)) || recordingSuite) {
      if (recordingSuite?.name.startsWith('Recorded · ')) {
        recordingSuite.name = JUST_RECORDED;
        recordingSuite.revision += 1;
        recordingSuite.updatedAt = new Date().toISOString();
      }
      return;
    }
    this.#state.suites.push({
      id: `suite_${randomUUID()}`,
      projectId: test.projectId,
      name: JUST_RECORDED,
      testIds: [test.id],
      revision: 1,
      updatedAt: new Date().toISOString(),
      sourceRecordingId: test.recordingId,
    });
  }

  async #persist() {
    const serialized = `${JSON.stringify(this.#state, null, 2)}\n`;
    this.#write = this.#write.then(async () => {
      const temporary = `${this.#filePath}.tmp`;
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#filePath);
    });
    await this.#write;
  }
}
