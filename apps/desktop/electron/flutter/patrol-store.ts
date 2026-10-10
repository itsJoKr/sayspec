import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readableLog } from './patrol-log.ts';
import type { CodingAgentProviderId, FailureAnalysis, PatrolAttempt, PatrolDeviceLease, PatrolRun, PatrolRuntimeManifest, PatrolSavedTest } from '@sayspec/contracts';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/;

/**
 * Stores saved Patrol tests and their execution attempts.
 *
 * Attempts are append-only: a retry creates a new attempt with its own
 * artifacts, so an earlier failure is never rewritten by a later pass.
 */
export class PatrolRunStore {
  readonly #root: string;
  readonly #testsPath: string;
  readonly #attemptsPath: string;
  readonly #leasesPath: string;
  readonly #analysesPath: string;
  readonly #runsPath: string;
  #runs: PatrolRun[] = [];
  #tests: PatrolSavedTest[] = [];
  #attempts: PatrolAttempt[] = [];
  #leases: PatrolDeviceLease[] = [];
  #analyses: FailureAnalysis[] = [];

  constructor(root: string) {
    this.#root = root;
    this.#testsPath = path.join(root, 'tests.json');
    this.#attemptsPath = path.join(root, 'attempts.json');
    this.#leasesPath = path.join(root, 'leases.json');
    this.#analysesPath = path.join(root, 'analyses.json');
    this.#runsPath = path.join(root, 'runs.json');
  }

  async initialize() {
    await mkdir(this.#root, { recursive: true });
    const loaded = await readJson<Array<PatrolSavedTest & { versionId?: string; version?: number }>>(this.#testsPath) ?? [];
    this.#tests = loaded.map((test) => ({ ...test, versionId: test.versionId ?? `patrol_version_${randomUUID()}`, version: test.version ?? 1 }));
    this.#attempts = await readJson<PatrolAttempt[]>(this.#attemptsPath) ?? [];
    this.#leases = await readJson<PatrolDeviceLease[]>(this.#leasesPath) ?? [];
    this.#analyses = await readJson<FailureAnalysis[]>(this.#analysesPath) ?? [];
    this.#runs = await readJson<PatrolRun[]>(this.#runsPath) ?? [];
    // Leases and runs never outlive the process that held them.
    const now = new Date().toISOString();
    for (const lease of this.#leases) if (!lease.releasedAt) lease.releasedAt = now;
    this.#runs = this.#runs.map((run) => run.state === 'running' ? { ...run, state: 'interrupted', finishedAt: now, activeTestId: undefined } : run);
    for (const attempt of this.#attempts) if (!attempt.finishedAt) Object.assign(attempt, { state: 'canceled', finishedAt: now, summary: 'The app quit while this attempt was running.' });
    await Promise.all([this.#persistTests(), this.#persistLeases(), this.#persistRuns(), writeFile(this.#attemptsPath, JSON.stringify(this.#attempts, null, 2))]);
  }

  listTests(projectId: string, organizationId: string) {
    const latest = new Map<string, PatrolSavedTest>();
    for (const test of this.#tests.filter((item) => item.projectId === projectId && item.organizationId === organizationId).sort((left, right) => right.version - left.version)) if (!latest.has(test.id)) latest.set(test.id, test);
    return [...latest.values()].sort((left, right) => left.title.localeCompare(right.title));
  }

  versions(projectId: string, organizationId: string, testId: string) {
    return this.#tests.filter((test) => test.projectId === projectId && test.organizationId === organizationId && test.id === testId).sort((left, right) => right.version - left.version);
  }

  async saveTest(input: { testId?: string; projectId: string; organizationId: string; title: string; relativePath: string; source: string; recordingCaptureId?: string; dependencies?: Readonly<Record<string, string>>; validationAttemptId?: string; provider?: CodingAgentProviderId; validatedRuntime?: PatrolRuntimeManifest; state?: PatrolSavedTest['state'] }): Promise<PatrolSavedTest> {
    if (!SAFE_ID.test(input.projectId) || !SAFE_ID.test(input.organizationId)) throw new Error('Patrol test scope is invalid.');
    if (!/^patrol_test\/[A-Za-z0-9_./-]+\.dart$/.test(input.relativePath) || input.relativePath.includes('..')) throw new Error('A Patrol test must live under patrol_test/ with a .dart extension, because that is the folder patrol_cli discovers.');
    if (!input.source.includes("package:patrol/patrol.dart") || !/patrolTest\s*\(/.test(input.source)) throw new Error('The saved source is not a Patrol test.');
    if (input.source.length > 512 * 1024) throw new Error('The Patrol test source exceeds the 512 KiB budget.');
    const existing = this.#tests.filter((test) => test.projectId === input.projectId && test.organizationId === input.organizationId && (input.testId ? test.id === input.testId : test.relativePath === input.relativePath)).sort((left, right) => right.version - left.version)[0];
    const contentHash = createHash('sha256').update(input.source).digest('hex');
    // Repeated publication of the same bytes is idempotent. Its provenance,
    // dependency pins and validating attempt belong to the original version.
    if (existing?.contentHash === contentHash) return structuredClone(existing);
    const test: PatrolSavedTest = {
      schemaVersion: 1,
      id: input.testId ?? existing?.id ?? `patrol_test_${randomUUID()}`,
      versionId: `patrol_version_${randomUUID()}`,
      version: (existing?.version ?? 0) + 1,
      projectId: input.projectId,
      organizationId: input.organizationId,
      title: input.title.slice(0, 200) || 'Patrol test',
      relativePath: input.relativePath,
      source: input.source,
      contentHash,
      createdAt: new Date().toISOString(),
      ...(input.recordingCaptureId ? { recordingCaptureId: input.recordingCaptureId } : {}),
      ...(input.dependencies ? { dependencies: input.dependencies } : {}),
      ...(input.validationAttemptId ? { validationAttemptId: input.validationAttemptId } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.validatedRuntime ? { validatedRuntime: input.validatedRuntime } : {}),
      state: input.state ?? existing?.state ?? 'generated',
    };
    this.#tests = [...this.#tests, test];
    await this.#persistTests();
    return test;
  }

  test(testId: string, versionId?: string) {
    const found = this.#tests.filter((item) => item.id === testId && (!versionId || item.versionId === versionId)).sort((left, right) => right.version - left.version)[0];
    if (!found) throw new Error('That Patrol test is not saved on this machine.');
    return found;
  }

  version(versionId: string) {
    const found = this.#tests.find((item) => item.versionId === versionId);
    if (!found) throw new Error('That Patrol test version is not saved on this machine.');
    return found;
  }

  async markValidated(testId: string, versionId: string, runtime?: PatrolRuntimeManifest) {
    const found = this.test(testId, versionId);
    const updated: PatrolSavedTest = { ...found, state: found.state === 'published' ? 'published' : 'execution-validated', ...(runtime ? { validatedRuntime: runtime } : {}) };
    this.#tests = this.#tests.map((item) => item.versionId === versionId ? updated : item);
    await this.#persistTests(); return updated;
  }

  /** Freezes each test at its latest saved version, in the given order. */
  async createRun(input: { organizationId: string; projectId: string; testIds: readonly string[]; name: string }): Promise<PatrolRun> {
    if (!SAFE_ID.test(input.projectId) || !SAFE_ID.test(input.organizationId)) throw new Error('Patrol run scope is invalid.');
    const testIds = [...new Set(input.testIds)];
    if (!testIds.length) throw new Error('Choose at least one saved Patrol test.');
    const latest = this.listTests(input.projectId, input.organizationId);
    const items = testIds.map((testId) => {
      const test = latest.find((item) => item.id === testId);
      if (!test) throw new Error('A selected test has no saved Patrol version in this project.');
      return { testId: test.id, versionId: test.versionId, version: test.version, title: test.title, relativePath: test.relativePath, contentHash: test.contentHash };
    });
    const run: PatrolRun = {
      schemaVersion: 1, id: `patrol_run_${randomUUID()}`, organizationId: input.organizationId, projectId: input.projectId,
      name: input.name.trim().slice(0, 120) || 'Test run', state: 'queued', createdAt: new Date().toISOString(), items,
    };
    this.#runs = [...this.#runs, run];
    await this.#persistRuns();
    return structuredClone(run);
  }

  run(input: { organizationId: string; projectId: string; runId: string }) {
    const found = this.#runs.find((run) => run.id === input.runId && run.organizationId === input.organizationId && run.projectId === input.projectId);
    if (!found) throw new Error('That test run is unknown in this project.');
    return structuredClone(found);
  }

  async updateRun(runId: string, change: Partial<Pick<PatrolRun, 'state' | 'deviceId' | 'deviceName' | 'startedAt' | 'finishedAt' | 'activeTestId' | 'artifacts' | 'analysis'>>) {
    const found = this.#runs.find((run) => run.id === runId);
    if (!found) throw new Error('That test run is unknown.');
    const updated: PatrolRun = { ...found, ...change };
    if (!updated.activeTestId) delete updated.activeTestId;
    if (!updated.analysis) delete updated.analysis;
    this.#runs = this.#runs.map((run) => run.id === runId ? updated : run);
    await this.#persistRuns();
    return structuredClone(updated);
  }

  async deleteRun(input: { organizationId: string; projectId: string; runId: string }) {
    if (this.run(input).state === 'running') throw new Error('Stop the run before deleting it.');
    this.#runs = this.#runs.filter((run) => run.id !== input.runId);
    await this.#persistRuns();
    await rm(path.join(this.#root, 'artifacts', input.runId), { recursive: true, force: true });
  }

  /** Every run on this machine, for reconciling state owned by other managers. */
  allRuns() { return structuredClone(this.#runs); }

  /** Runs of a project, oldest first, with every attempt made inside them. */
  runs(projectId: string, organizationId: string) {
    const runs = this.#runs.filter((run) => run.projectId === projectId && run.organizationId === organizationId);
    const ids = new Set(runs.map((run) => run.id));
    return structuredClone({ runs, attempts: this.#attempts.filter((attempt) => attempt.runId && ids.has(attempt.runId)) });
  }

  #persistRuns() { return writeFile(this.#runsPath, JSON.stringify(this.#runs, null, 2)); }

  #persistTests() { return writeFile(this.#testsPath, JSON.stringify(this.#tests, null, 2)); }

  #persistLeases() { return writeFile(this.#leasesPath, JSON.stringify(this.#leases, null, 2)); }

  async recordAttempt(attempt: PatrolAttempt) {
    this.#attempts = [...this.#attempts.filter((item) => item.id !== attempt.id), attempt];
    await writeFile(this.#attemptsPath, JSON.stringify(this.#attempts, null, 2));
    return attempt;
  }

  attempts(projectId: string, organizationId: string, testId: string) {
    return this.#attempts.filter((item) => item.projectId === projectId && item.organizationId === organizationId && item.testId === testId);
  }

  attempt(attemptId: string) {
    return this.#attempts.find((item) => item.id === attemptId);
  }

  failedAttempt(input: { organizationId: string; projectId: string; testId: string; attemptId: string }) {
    const attempt = this.#attempts.find((item) => item.id === input.attemptId && item.organizationId === input.organizationId && item.projectId === input.projectId && item.testId === input.testId);
    if (!attempt || !attempt.finishedAt || !['failed', 'blocked', 'infrastructure-error'].includes(attempt.state)) throw new Error('A finished failed Patrol attempt was not found in this project.');
    const version = this.#tests.find((item) => item.versionId === attempt.versionId && item.id === input.testId && item.organizationId === input.organizationId && item.projectId === input.projectId);
    if (!version || version.contentHash !== attempt.testContentHash || createHash('sha256').update(version.source).digest('hex') !== version.contentHash) throw new Error('The failed Patrol attempt has no intact saved source version.');
    return { attempt: structuredClone(attempt), version: structuredClone(version) };
  }

  failureAnalyses(input: { organizationId: string; projectId: string; testId: string; attemptId: string }) {
    this.failedAttempt(input);
    return structuredClone(this.#analyses.filter((item) => item.organizationId === input.organizationId && item.projectId === input.projectId && item.testId === input.testId && item.attemptId === input.attemptId));
  }

  async saveFailureAnalysis(analysis: FailureAnalysis) {
    const { attempt, version } = this.failedAttempt(analysis);
    if (analysis.versionId !== version.versionId || analysis.testVersionHash !== attempt.testContentHash || this.#analyses.some((item) => item.id === analysis.id)) throw new Error('Patrol analysis provenance is stale or duplicated.');
    this.#analyses.push(structuredClone(analysis));
    await writeFile(this.#analysesPath, JSON.stringify(this.#analyses, null, 2));
    return structuredClone(analysis);
  }

  /** Acquires an exclusive lease so two runs never drive one device at once. */
  async acquireLease(input: { deviceId: string; attemptId: string }): Promise<PatrolDeviceLease> {
    const held = this.#leases.find((lease) => lease.deviceId === input.deviceId && !lease.releasedAt);
    if (held) throw new Error(`The device is already running attempt ${held.attemptId}. Wait for it to finish or cancel it.`);
    const lease: PatrolDeviceLease = { id: `lease_${randomUUID()}`, deviceId: input.deviceId, attemptId: input.attemptId, acquiredAt: new Date().toISOString() };
    this.#leases = [...this.#leases, lease];
    await this.#persistLeases();
    return lease;
  }

  async releaseLease(leaseId: string) {
    const lease = this.#leases.find((item) => item.id === leaseId);
    if (!lease || lease.releasedAt) return;
    lease.releasedAt = new Date().toISOString();
    await this.#persistLeases();
  }

  leases() { return this.#leases.map((lease) => ({ ...lease })); }

  activeLeases() { return this.#leases.filter((lease) => !lease.releasedAt); }

  async writeArtifact(attemptId: string, relativePath: string, bytes: Buffer) {
    if (relativePath.includes('..') || path.isAbsolute(relativePath)) throw new Error('Artifact path is invalid.');
    const absolute = path.join(this.#root, 'artifacts', attemptId, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
    return { relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, mimeType: mimeFor(relativePath) };
  }

  /** Stores run-level evidence (the combined log, device reports) next to attempt artifacts. */
  async writeRunArtifact(runId: string, relativePath: string, bytes: Buffer) {
    if (!SAFE_ID.test(runId)) throw new Error('Run scope is invalid.');
    return this.writeArtifact(runId, relativePath, bytes);
  }

  /** Absolute path of a recorded run artifact after an integrity check; main-process use only. */
  async runArtifactPath(runId: string, relativePath: string) {
    const run = this.#runs.find((item) => item.id === runId);
    const recorded = run?.artifacts?.find((item) => item.relativePath === relativePath);
    if (!run || !recorded || relativePath.includes('..') || path.isAbsolute(relativePath)) throw new Error('Artifact was not found in this run.');
    const absolute = path.join(this.#root, 'artifacts', runId, relativePath);
    const bytes = await readFile(absolute);
    if (bytes.byteLength !== recorded.byteLength || createHash('sha256').update(bytes).digest('hex') !== recorded.sha256) throw new Error('Run artifact failed integrity verification.');
    return absolute;
  }

  async readRunArtifact(input: { organizationId: string; projectId: string; runId: string; relativePath: string }) {
    this.run(input);
    return readFile(await this.runArtifactPath(input.runId, input.relativePath));
  }

  /**
   * Plain-text log of one test of a run, or of the whole run.
   *
   * A test's own log is its slice of the combined output, headed by its result
   * and errors. A test that never started has no slice, so the combined output
   * is returned instead, because that is where the reason is.
   */
  async readRunLog(scope: { organizationId: string; projectId: string; runId: string }, attemptId?: string) {
    const run = this.run(scope);
    const runLog = run.artifacts?.some((item) => item.relativePath === 'patrol-run.log') ? (await this.readRunArtifact({ ...scope, relativePath: 'patrol-run.log' })).toString('utf8') : '';
    if (!attemptId) return runLog || 'This run has no combined log.';
    const attempt = this.#attempts.find((item) => item.id === attemptId && item.runId === run.id && item.organizationId === run.organizationId && item.projectId === run.projectId);
    if (!attempt) throw new Error('That test result is not part of this run.');
    const header = [attempt.summary, attempt.detail, ...attempt.tests.flatMap((test) => test.errors)].filter(Boolean).join('\n\n');
    // Attempts from before runs were batched kept the whole Patrol log per test.
    const own = attempt.artifacts.find((item) => item.relativePath === 'test.log') ?? attempt.artifacts.find((item) => item.relativePath === 'patrol-run.log');
    const divider = `\n\n${'─'.repeat(48)}\n\n`;
    if (own) return `${header}${divider}${readableLog((await this.readArtifact({ ...scope, testId: attempt.testId, attemptId: attempt.id, relativePath: own.relativePath })).bytes.toString('utf8'))}`;
    return runLog ? `${header}${divider}This test did not start on the device, so it has no log of its own. The full run output follows.${divider}${runLog}` : header;
  }

  async readArtifact(input: { organizationId: string; projectId: string; testId: string; attemptId: string; relativePath: string }) {
    const { organizationId, projectId, testId, attemptId, relativePath } = input;
    if (![organizationId, projectId, testId, attemptId].every((id) => SAFE_ID.test(id))) throw new Error('Artifact scope is invalid.');
    if (!relativePath || relativePath.includes('..') || path.isAbsolute(relativePath)) throw new Error('Artifact path is invalid.');
    const attempt = this.#attempts.find((item) => item.id === attemptId && item.organizationId === organizationId && item.projectId === projectId && item.testId === testId);
    const recorded = attempt?.artifacts.find((item) => item.relativePath === relativePath);
    if (!recorded) throw new Error('Artifact was not found in this attempt.');
    const bytes = await readFile(path.join(this.#root, 'artifacts', attemptId, relativePath));
    if (bytes.byteLength !== recorded.byteLength || createHash('sha256').update(bytes).digest('hex') !== recorded.sha256) throw new Error('Patrol artifact failed integrity verification.');
    return { bytes, mimeType: recorded.mimeType };
  }

  async listArtifacts(attemptId: string) {
    const root = path.join(this.#root, 'artifacts', attemptId);
    const found: string[] = [];
    const walk = async (directory: string, prefix: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${prefix}${entry.name}/`);
        else found.push(`${prefix}${entry.name}`);
      }
    };
    await walk(root, '');
    return found;
  }
}

function mimeFor(relativePath: string) {
  if (relativePath.endsWith('.json')) return 'application/json';
  if (relativePath.endsWith('.png')) return 'image/png';
  if (relativePath.endsWith('.mp4')) return 'video/mp4';
  if (relativePath.endsWith('.xml')) return 'application/xml';
  return 'text/plain';
}

async function readJson<T>(candidate: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(candidate, 'utf8')) as T; } catch { return undefined; }
}

/** Hash used to detect a structurally different run environment. */
export function environmentHash(input: Pick<PatrolRuntimeManifest, 'flutterVersion' | 'patrolCliVersion' | 'patrolPackageVersion' | 'deviceId' | 'entrypoint'>) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
