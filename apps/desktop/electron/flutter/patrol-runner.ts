import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ApplicationPatchLink, FlutterDeviceSummary, PatrolAttempt, PatrolRun, PatrolRunInput, PatrolRuntimeManifest, PatrolSavedTest, PatrolTestOutcome } from '@sayspec/contracts';
import { resolveTool, runFile } from '../setup/environment.ts';
import { environmentHash, PatrolRunStore } from './patrol-store.ts';
import { FlutterCaptureSessionManager } from './session-manager.ts';
import { androidTestRelativePath } from './integration.ts';
import { flutterDeviceId, readIosPatrolWiring, readXcresultCases, removeXcresults, simulatorOsVersion } from './ios-patrol.ts';
import { deviceReportFiles, instrumentationFailure, ownerOf, readableLog, splitPatrolLog, stripAnsi } from './patrol-log.ts';
import { resolveProjectFlutterToolchain } from './toolchain.ts';

type RunControl = { stop: boolean; activeKey?: string };
/** Run lifecycle hooks; a run that failed on the device starts its analysis. */
export type RunEvents = { onRunStarted?: (runId: string) => void; onRunFailed?: (run: PatrolRun, sourcePath: string) => void };
type ActiveProcess = { child?: ChildProcessWithoutNullStreams; leaseId: string; canceled: boolean; log: string[] };
type Preflight = {
  device: FlutterDeviceSummary;
  flutter: Awaited<ReturnType<typeof resolveProjectFlutterToolchain>>;
  patrol: Awaited<ReturnType<typeof resolveTool>> & { path: string };
  patrolPackage: string;
};

const BUILD_TIMEOUT_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 15 * 60_000;
const MAX_LOG_BYTES = 4 * 1024 * 1024;

interface ReporterEvent { type?: string; test?: { id?: number; name?: string; url?: string }; result?: string; time?: number; error?: string; message?: string; suite?: { id?: number }; }

/**
 * Executes saved Patrol tests unchanged on a leased Android device or iOS
 * simulator.
 *
 * Refusals happen before a build starts (no project, no pinned Flutter, no
 * Patrol CLI, no device, device already leased), because a misleading
 * "infrastructure failed" run is worse than a clear block.
 */
export class PatrolRunner {
  readonly #store: PatrolRunStore;
  readonly #captures: FlutterCaptureSessionManager;
  /** Patrol processes by attempt id, or by run id for a whole run. */
  readonly #active = new Map<string, ActiveProcess>();
  /** Test runs executing in this process. */
  readonly #runs = new Map<string, RunControl>();
  readonly #events: RunEvents;

  constructor(options: { store: PatrolRunStore; captures: FlutterCaptureSessionManager; events?: RunEvents }) {
    this.#store = options.store;
    this.#captures = options.captures;
    this.#events = options.events ?? {};
  }

  /** Records a refusal as a real, inspectable attempt. */
  async #recordBlocked(input: Omit<PatrolRunInput, 'sourceHandle'>, test: PatrolSavedTest, state: 'blocked' | 'infrastructure-error' | 'canceled', detail: string, applicationPatch?: ApplicationPatchLink, runId?: string): Promise<PatrolAttempt> {
    const attempt: PatrolAttempt = {
      schemaVersion: 1,
      id: `patrol_attempt_${randomUUID()}`,
      testId: test.id,
      versionId: test.versionId,
      projectId: input.projectId,
      organizationId: input.organizationId,
      testContentHash: test.contentHash,
      runtime: {
        deviceId: input.deviceId, deviceName: input.deviceId, platform: input.deviceId.startsWith('ios:') ? 'ios' : 'android', entrypoint: test.relativePath,
        testFileHashes: { [test.relativePath]: test.contentHash },
        environmentHash: environmentHash({ patrolPackageVersion: undefined, deviceId: input.deviceId, entrypoint: test.relativePath }),
      },
      state,
      deviceId: input.deviceId,
      leaseId: '',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      summary: state === 'canceled' ? 'The Patrol run was canceled.' : state === 'blocked' ? 'The run was blocked before anything executed.' : 'The run could not start.',
      detail,
      passed: 0, failed: 0, skipped: 0, tests: [], artifacts: [], runner: 'desktop-local-patrol', ...(applicationPatch ? { applicationPatch } : {}), ...(runId ? { runId } : {}),
    };
    await this.#store.recordAttempt(attempt);
    return attempt;
  }

  /** Waits for a listed device to become ready, or returns undefined. */
  async #awaitDevice(deviceId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const devices = await this.#captures.devices();
      const device = devices.find((entry) => entry.id === deviceId);
      if (!device) return undefined;
      if (device.state === 'ready') return device;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    const devices = await this.#captures.devices();
    const device = devices.find((entry) => entry.id === deviceId);
    if (device && device.state !== 'ready') throw new Error(`${device.name} is ${device.state}. Boot or authorize the device before running.`);
    return device;
  }

  async shutdown() {
    for (const run of this.#runs.values()) run.stop = true;
    for (const [attemptId, active] of this.#active) {
      active.canceled = true;
      active.child?.kill('SIGTERM');
      await this.#store.releaseLease(active.leaseId);
      this.#active.delete(attemptId);
    }
  }

  log(attemptId: string) { return this.#active.get(attemptId)?.log.join('') ?? ''; }

  async cancel(input: { organizationId: string; projectId: string; testId: string; attemptId: string }): Promise<PatrolAttempt> {
    const { attemptId } = input;
    const active = this.#active.get(attemptId);
    const attempt = this.#store.attempt(attemptId);
    if (!attempt || attempt.organizationId !== input.organizationId || attempt.projectId !== input.projectId || attempt.testId !== input.testId) throw new Error('That Patrol attempt is unknown in this project.');
    if (!active) return attempt;
    await this.#cancelActive(attemptId);
    return this.#store.attempt(attemptId) ?? attempt;
  }

  /**
   * Runs one saved test as a new attempt.
   *
   * The saved source is materialized into the project's `integration_test/`
   * folder, so the executed file is byte-identical to the saved hash; a
   * mismatch aborts before the build.
   */
  async run(input: Omit<PatrolRunInput, 'sourceHandle'>, sourcePath: string, applicationPatch?: ApplicationPatchLink): Promise<PatrolAttempt> {
    const test = this.#store.test(input.testId, input.versionId);
    if (test.organizationId !== input.organizationId || test.projectId !== input.projectId) throw new Error('The selected Patrol version is outside this project.');
    return this.#runTest(input, sourcePath, test, { markValidated: true, restoreSource: false, applicationPatch });
  }

  /** Validates an unsaved candidate and leaves no candidate file behind. */
  async runCandidate(input: Omit<PatrolRunInput, 'sourceHandle' | 'testId'>, sourcePath: string, candidate: { title: string; relativePath: string; source: string }, signal?: AbortSignal): Promise<PatrolAttempt> {
    const test: PatrolSavedTest = {
      schemaVersion: 1,
      id: `patrol_candidate_${randomUUID()}`,
      versionId: `patrol_candidate_version_${randomUUID()}`,
      version: 0,
      projectId: input.projectId,
      organizationId: input.organizationId,
      title: candidate.title,
      relativePath: candidate.relativePath,
      source: candidate.source,
      contentHash: createHash('sha256').update(candidate.source).digest('hex'),
      createdAt: new Date().toISOString(),
      state: 'generated',
    };
    return this.#runTest({ ...input, testId: test.id }, sourcePath, test, { markValidated: false, restoreSource: true, signal });
  }

  /**
   * Starts a run and returns once it is marked running.
   *
   * All tests of the run go to one `patrol test` process with a target per
   * saved file, so the app is built and installed once. Each test still becomes a normal attempt tagged with the run id,
   * with its own result and its own slice of the log; a failing test does not
   * stop the ones after it.
   */
  async startRun(input: { organizationId: string; projectId: string; runId: string; deviceId: string }, sourcePath: string): Promise<PatrolRun> {
    const run = this.#store.run(input);
    if (run.state === 'running' || this.#runs.has(run.id)) throw new Error('This run is already running.');
    if (this.#store.activeLeases().some((lease) => lease.deviceId === input.deviceId)) throw new Error('That device is busy with another run. Wait for it to finish or stop it.');
    const device = (await this.#captures.devices()).find((entry) => entry.id === input.deviceId);
    const control: RunControl = { stop: false };
    this.#runs.set(run.id, control);
    this.#events.onRunStarted?.(run.id);
    const started = await this.#store.updateRun(run.id, { state: 'running', deviceId: input.deviceId, deviceName: device?.name ?? input.deviceId, startedAt: new Date().toISOString(), finishedAt: undefined, activeTestId: undefined, artifacts: undefined, analysis: undefined });
    void (async () => {
      let ranOnDevice = false;
      let artifacts: PatrolAttempt['artifacts'] = [];
      try {
        ({ ranOnDevice, artifacts } = await this.#executeRun(started, input.deviceId, sourcePath, control));
      } catch { /* every failure path records its attempts first */ } finally {
        this.#runs.delete(run.id);
        const finished = await this.#store.updateRun(run.id, { state: control.stop ? 'canceled' : 'finished', finishedAt: new Date().toISOString(), activeTestId: undefined, artifacts }).catch(() => undefined);
        const failed = this.#store.runs(run.projectId, run.organizationId).attempts.some((attempt) => attempt.runId === run.id && attempt.startedAt >= started.startedAt! && ['failed', 'infrastructure-error'].includes(attempt.state));
        if (finished && ranOnDevice && failed && !control.stop) this.#events.onRunFailed?.(finished, sourcePath);
      }
    })();
    return started;
  }

  async #executeRun(run: PatrolRun, deviceId: string, sourcePath: string, control: RunControl): Promise<{ ranOnDevice: boolean; artifacts: PatrolAttempt['artifacts'] }> {
    const items = run.items.map((item) => ({ item, test: this.#store.version(item.versionId) }));
    const scope = (item: PatrolRun['items'][number]) => ({ organizationId: run.organizationId, projectId: run.projectId, testId: item.testId, versionId: item.versionId, deviceId });
    const blockAll = async (state: 'blocked' | 'infrastructure-error' | 'canceled', detail: string) => {
      for (const { item, test } of items) await this.#recordBlocked(scope(item), test, state, detail, undefined, run.id);
      return { ranOnDevice: false, artifacts: [] };
    };
    let preflight: Preflight;
    try { preflight = await this.#preflight(sourcePath, deviceId); }
    catch (error) { return blockAll(error instanceof BlockedRunError ? 'blocked' : 'infrastructure-error', error instanceof Error ? error.message : String(error)); }
    if (control.stop) return blockAll('canceled', 'The run was stopped before Patrol started.');
    let lease: Awaited<ReturnType<PatrolRunStore['acquireLease']>>;
    try { lease = await this.#store.acquireLease({ deviceId: preflight.device.id, attemptId: run.id }); }
    catch (error) { return blockAll('blocked', error instanceof Error ? error.message : String(error)); }

    const startedAt = new Date().toISOString();
    const attempts = new Map<string, PatrolAttempt>();
    for (const { item, test } of items) {
      attempts.set(item.testId, {
        schemaVersion: 1, id: `patrol_attempt_${randomUUID()}`, testId: test.id, versionId: test.versionId, projectId: run.projectId, organizationId: run.organizationId,
        testContentHash: test.contentHash, runtime: runtimeManifest(preflight, test), state: 'building', deviceId: preflight.device.id, leaseId: lease.id,
        startedAt, summary: 'Building the app for this run…', detail: '', passed: 0, failed: 0, skipped: 0, tests: [], artifacts: [], runner: 'desktop-local-patrol', runId: run.id,
      });
    }
    // Attempt writes are serialized: live progress and the final result both
    // rewrite the attempt file.
    let writes = Promise.resolve();
    const save = (attempt: PatrolAttempt) => { attempts.set(attempt.testId, attempt); writes = writes.then(() => this.#store.recordAttempt(attempt)).then(() => undefined, () => undefined); return writes; };
    const finish = (testId: string, change: Partial<PatrolAttempt>) => save({ ...attempts.get(testId)!, ...change, finishedAt: new Date().toISOString() });
    for (const attempt of attempts.values()) await save(attempt);

    const active: ActiveProcess = { leaseId: lease.id, canceled: false, log: [] };
    this.#active.set(run.id, active);
    control.activeKey = run.id;
    if (control.stop) active.canceled = true;
    try {
      const targets: typeof items = [];
      for (const entry of items) {
        try {
          await this.#materialize(sourcePath, entry.test.relativePath, entry.test.source, entry.test.contentHash);
          targets.push(entry);
        } catch (error) {
          await finish(entry.item.testId, { state: 'infrastructure-error', summary: 'The saved test could not be written into the project.', detail: error instanceof Error ? error.message : String(error) });
        }
      }
      if (!targets.length) return { ranOnDevice: false, artifacts: [] };
      // A previous run's report must never be read as this run's result.
      await clearDeviceReports(sourcePath);

      const byFile = new Map(targets.map((entry) => [entry.test.relativePath, entry.item.testId]));
      const owner = ownerOf([...byFile.keys()]);
      const live = new Map<string, PatrolTestOutcome[]>();
      const outcome = await this.#execute({
        active, sourcePath, flutter: preflight.flutter, patrolPath: preflight.patrol.path, device: preflight.device, targets: targets.map((entry) => entry.test.relativePath), showFlutterLogs: true,
        onLine: (raw) => {
          const line = stripAnsi(raw).trim();
          const started = /^🧪\s+(.*)$/.exec(line);
          const startedFile = started ? owner(started[1]!) : undefined;
          if (startedFile) {
            const testId = byFile.get(startedFile)!;
            void this.#store.updateRun(run.id, { activeTestId: testId }).catch(() => undefined);
            if (attempts.get(testId)!.state === 'building') void save({ ...attempts.get(testId)!, state: 'running', summary: 'Running on the device…' });
            return;
          }
          // `✅ <test> (/<file>.dart) (2s)` settles a test before JUnit is written,
          // so the run shows progress and a stopped run keeps finished results.
          const done = /^(✅|❌)\s+(.*?)\s+\((\/[^()]+\.dart)\)(?:\s+\((\d+)s\))?/.exec(line);
          const file = done ? `patrol_test${done[3]}` : undefined;
          if (done && file && byFile.has(file)) {
            const tests = [...(live.get(file) ?? []), { id: `live:${file}:${done[2]}`, title: done[2]!, outcome: done[1] === '✅' ? 'passed' as const : 'failed' as const, durationMs: Number(done[4] ?? 0) * 1000, errors: [] }];
            live.set(file, tests);
            const failed = tests.some((entry) => entry.outcome === 'failed');
            void save({ ...attempts.get(byFile.get(file)!)!, state: failed ? 'failed' : 'passed', summary: failed ? 'Failed on the device; collecting the report…' : 'Passed on the device; collecting the report…' });
          }
        },
      });
      const readable = readableLog(active.log.join(''));
      const segments = splitPatrolLog(readable, [...byFile.keys()]);
      // Gradle's JUnit XML (Android) or the .xcresult bundle (iOS) is the
      // machine-readable record of what ran on the device.
      const report = await readDeviceReport(sourcePath);
      const reported = report.tests;
      const zeroStarted = /Starting 0 tests? on /.test(readable);
      const deviceFailure = reported.length ? undefined : await instrumentationFailure(sourcePath);

      const runArtifacts: PatrolAttempt['artifacts'][number][] = [await this.#store.writeRunArtifact(run.id, 'patrol-run.log', Buffer.from(readable, 'utf8'))];
      if (report.xcresultJson && Buffer.byteLength(report.xcresultJson) <= MAX_LOG_BYTES) runArtifacts.push(await this.#store.writeRunArtifact(run.id, 'device/xcresult-tests.json', Buffer.from(report.xcresultJson, 'utf8')));
      for (const file of await deviceReportFiles(sourcePath)) {
        const bytes = await readFile(file.absolute).catch(() => undefined);
        if (bytes && bytes.byteLength <= MAX_LOG_BYTES) runArtifacts.push(await this.#store.writeRunArtifact(run.id, file.relativePath, bytes));
      }

      for (const { item, test } of targets) {
        const cases = reported.filter((entry) => owner(entry.title) === test.relativePath);
        const tests = cases.length ? cases : live.get(test.relativePath) ?? [];
        const segment = segments.get(test.relativePath);
        const failed = tests.some((entry) => entry.outcome === 'failed');
        const passed = tests.some((entry) => entry.outcome === 'passed');
        const state: PatrolAttempt['state'] = failed ? 'failed' : passed ? 'passed' : outcome.canceled ? 'canceled' : 'infrastructure-error';
        const summary = state === 'failed' ? `${tests.filter((entry) => entry.outcome === 'failed').length} of ${tests.length} Patrol test(s) failed.`
          : state === 'passed' ? `${tests.length} Patrol test(s) passed.`
          : state === 'canceled' ? 'The run was stopped before this test finished.'
          : outcome.failedBuild ? 'The build or device connection failed before this test ran.'
          : zeroStarted ? 'The device did not run any test.'
          : segment ? 'Patrol reported no result for this test.' : 'This test did not start on the device.';
        const detail = state === 'infrastructure-error'
          ? [deviceFailure ? `Android instrumentation failed: ${deviceFailure}` : '', zeroStarted && !deviceFailure ? 'Android instrumentation started 0 tests.' : '', outcome.detail].filter(Boolean).join(' ')
          : '';
        const attempt = attempts.get(item.testId)!;
        const logArtifacts = segment ? [await this.#store.writeArtifact(attempt.id, 'test.log', Buffer.from(segment, 'utf8'))] : [];
        await finish(item.testId, {
          state, summary, detail, tests, artifacts: logArtifacts, exitCode: outcome.exitCode,
          passed: tests.filter((entry) => entry.outcome === 'passed').length,
          failed: tests.filter((entry) => entry.outcome === 'failed').length,
          skipped: tests.filter((entry) => entry.outcome === 'skipped').length,
        });
        if (state === 'passed') await this.#store.markValidated(test.id, test.versionId, attempt.runtime).catch(() => undefined);
      }
      return { ranOnDevice: true, artifacts: runArtifacts };
    } catch (error) {
      for (const [testId, attempt] of attempts) {
        if (!attempt.finishedAt) await finish(testId, { state: active.canceled ? 'canceled' : 'infrastructure-error', summary: 'The Patrol run could not complete.', detail: error instanceof Error ? error.message : String(error) });
      }
      return { ranOnDevice: false, artifacts: [] };
    } finally {
      await writes;
      await this.#store.releaseLease(lease.id);
      this.#active.delete(run.id);
      control.activeKey = undefined;
    }
  }

  /** Stops the run: its Patrol process is canceled and unfinished tests are marked stopped. */
  async stopRun(input: { organizationId: string; projectId: string; runId: string }): Promise<PatrolRun> {
    const run = this.#store.run(input);
    const control = this.#runs.get(run.id);
    if (!control) return run.state === 'running' ? this.#store.updateRun(run.id, { state: 'canceled', finishedAt: new Date().toISOString(), activeTestId: undefined }) : run;
    control.stop = true;
    if (control.activeKey) await this.#cancelActive(control.activeKey);
    return this.#store.run(input);
  }

  async #cancelActive(attemptId: string) {
    const active = this.#active.get(attemptId);
    if (!active) return;
    active.canceled = true;
    active.child?.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    active.child?.kill('SIGKILL');
  }

  /**
   * Checks everything a Patrol build needs before one starts.
   *
   * Callers turn a refusal into durable `blocked` attempts: a wrong device, a
   * missing toolchain or unwired instrumentation must leave a visible record
   * that explains the required action; throwing would only surface as a
   * transient error with no history.
   */
  async #preflight(sourcePath: string, deviceId: string): Promise<Preflight> {
    if (!sourcePath) throw new BlockedRunError('Select the Flutter project folder before running a Patrol test.');
    // A device that is tearing down between runs is not a permanent block, so
    // a listed-but-not-ready device is waited for; only an absent device is
    // refused outright.
    const device = await this.#awaitDevice(deviceId);
    if (!device) throw new BlockedRunError(`The device ${deviceId} is not connected. Reconnect it or boot an emulator, then run again.`);
    if (device.platform === 'ios' && device.kind !== 'emulator') throw new BlockedRunError('Patrol runs on iOS simulators only; a physical iOS device needs a signed release build, which SaySpec does not create.');
    let flutter: Preflight['flutter'];
    try { flutter = await resolveProjectFlutterToolchain(sourcePath); }
    catch (error) { throw new BlockedRunError(error instanceof Error ? error.message : String(error)); }
    const patrol = await resolveTool({ name: 'patrol', versionArgs: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/ });
    if (!patrol.found || !patrol.path) throw new BlockedRunError('The Patrol CLI is not installed. Run Settings → Machine setup.');
    const patrolPackage = await readPatrolPackageVersion(sourcePath);
    if (!patrolPackage) throw new BlockedRunError('The project does not pin a patrol package, so the generated test cannot run.');
    // Patrol executes through the app's Android test instrumentation or iOS
    // XCUITest target. Running Android without it builds and reports zero
    // tests, which would look like a pass, so the run is blocked with the
    // required action instead.
    const wiring = device.platform === 'ios' ? await readIosPatrolWiring(sourcePath) : await readPatrolWiring(sourcePath);
    if (!wiring.ready) throw new BlockedRunError(wiring.detail);
    return { device, flutter, patrol: { ...patrol, path: patrol.path }, patrolPackage };
  }

  async #runTest(input: Omit<PatrolRunInput, 'sourceHandle'>, sourcePath: string, test: PatrolSavedTest, options: { markValidated: boolean; restoreSource: boolean; signal?: AbortSignal; applicationPatch?: ApplicationPatchLink; runId?: string; onStart?: (attemptId: string) => void }): Promise<PatrolAttempt> {
    if (options.signal?.aborted) return this.#recordBlocked(input, test, 'canceled', 'Validation was canceled before Patrol started.', options.applicationPatch, options.runId);
    let preflight: Preflight;
    try {
      preflight = await this.#preflight(sourcePath, input.deviceId);
    } catch (error) {
      return this.#recordBlocked(input, test, error instanceof BlockedRunError ? 'blocked' : 'infrastructure-error', error instanceof Error ? error.message : String(error), options.applicationPatch, options.runId);
    }
    const { device, flutter, patrol } = preflight;
    if (options.signal?.aborted) return this.#recordBlocked(input, test, 'canceled', 'Validation was canceled before Patrol started.', options.applicationPatch, options.runId);

    const attemptId = `patrol_attempt_${randomUUID()}`;
    // A busy device is an actionable block, not a crash: the caller gets an
    // attempt it can inspect alongside the run that currently holds the device.
    let lease: Awaited<ReturnType<PatrolRunStore['acquireLease']>>;
    try {
      lease = await this.#store.acquireLease({ deviceId: device.id, attemptId });
    } catch (error) {
      return this.#recordBlocked(input, test, 'blocked', error instanceof Error ? error.message : String(error), options.applicationPatch, options.runId);
    }
    const work = await mkdtemp(path.join(tmpdir(), 'sayspec-patrol-'));
    const runtime = runtimeManifest(preflight, test);
    let attempt: PatrolAttempt = {
      schemaVersion: 1, id: attemptId, testId: test.id, versionId: test.versionId, projectId: input.projectId, organizationId: input.organizationId,
      testContentHash: test.contentHash, runtime, state: 'preparing', deviceId: device.id, leaseId: lease.id,
      startedAt: new Date().toISOString(), summary: 'Preparing the Patrol run.', detail: '', passed: 0, failed: 0, skipped: 0,
      tests: [], artifacts: [], runner: 'desktop-local-patrol', ...(options.applicationPatch ? { applicationPatch: options.applicationPatch } : {}), ...(options.runId ? { runId: options.runId } : {}),
    };
    this.#active.set(attemptId, { leaseId: lease.id, canceled: false, log: [] });
    options.onStart?.(attemptId);
    const abort = () => {
      const active = this.#active.get(attemptId);
      if (!active) return;
      active.canceled = true;
      active.child?.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    let previousSource: string | undefined;
    let materialized = false;
    await this.#store.recordAttempt(attempt);
    try {
      previousSource = await this.#materialize(sourcePath, test.relativePath, test.source, test.contentHash);
      materialized = true;
      // A previous run's report must never be read as this run's result.
      await clearDeviceReports(sourcePath);
      attempt = { ...attempt, state: 'building', summary: 'Building and launching the instrumented app…' };
      await this.#store.recordAttempt(attempt);
      const outcome = await this.#execute({ active: this.#active.get(attemptId)!, sourcePath, flutter, patrolPath: patrol.path, device, targets: [test.relativePath] });
      // Patrol reports through Gradle's JUnit XML (Android) or the .xcresult
      // bundle (iOS), the machine-readable record of what ran on the device.
      const report = await readDeviceReport(sourcePath, test.relativePath);
      if (report.tests.length) {
        outcome.tests = report.tests;
        outcome.failedBuild = false;
      }
      outcome.summary = summarize(outcome.tests, outcome.canceled, outcome.failedBuild);
      const artifacts = await this.#collect(sourcePath, work, attemptId, report.xcresultJson);
      const apkHash = artifacts.find((item) => item.relativePath === 'app-debug.apk')?.sha256;
      const finished: PatrolAttempt = {
        ...attempt,
        state: outcome.canceled ? 'canceled' : outcome.tests.some((item) => item.outcome === 'failed') ? 'failed' : outcome.failedBuild ? 'infrastructure-error' : outcome.tests.some((item) => item.outcome === 'passed') ? 'passed' : 'infrastructure-error',
        finishedAt: new Date().toISOString(),
        summary: outcome.summary,
        detail: outcome.detail,
        passed: outcome.tests.filter((item) => item.outcome === 'passed').length,
        failed: outcome.tests.filter((item) => item.outcome === 'failed').length,
        skipped: outcome.tests.filter((item) => item.outcome === 'skipped').length,
        tests: outcome.tests,
        artifacts,
        ...(options.applicationPatch ? { applicationPatch: { ...options.applicationPatch, ...(apkHash ? { buildArtifactHash: apkHash, runtimeHash: createHash('sha256').update(JSON.stringify({ receiptId: options.applicationPatch.receiptId, apkHash, environmentHash: runtime.environmentHash })).digest('hex') } : {}) } } : {}),
        exitCode: outcome.exitCode,
      };
      await this.#store.recordAttempt(finished);
      if (finished.state === 'passed' && options.markValidated) {
        await this.#store.markValidated(test.id, test.versionId, finished.runtime);
      }
      return finished;
    } catch (error) {
      const failed: PatrolAttempt = {
        ...attempt,
        state: this.#active.get(attemptId)?.canceled ? 'canceled' : error instanceof BlockedRunError ? 'blocked' : 'infrastructure-error',
        finishedAt: new Date().toISOString(),
        summary: 'The Patrol run could not complete.',
        detail: error instanceof Error ? error.message : String(error),
      };
      await this.#store.recordAttempt(failed);
      return failed;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (options.restoreSource && materialized) await this.#restoreMaterialized(sourcePath, test.relativePath, previousSource, test.contentHash);
      await this.#store.releaseLease(lease.id);
      this.#active.delete(attemptId);
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Writes the saved source and refuses to continue if the file changed. */
  async #materialize(sourcePath: string, relativePath: string, source: string, expectedHash: string) {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await assertSafeTestPath(sourcePath, relativePath);
    const absolute = path.join(sourcePath, relativePath);
    const existing = await readFile(absolute, 'utf8').catch(() => undefined);
    const existingHash = existing === undefined ? undefined : createHash('sha256').update(existing).digest('hex');
    if (existingHash && existingHash !== expectedHash) {
      throw new Error(`${relativePath} in the project differs from the saved test. SaySpec will not overwrite changed source; review that file first.`);
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await assertSafeTestPath(sourcePath, relativePath);
    await writeFile(absolute, source);
    if (createHash('sha256').update(await readFile(absolute)).digest('hex') !== expectedHash) throw new Error('Materialized Patrol source does not match the selected version.');
    return existing;
  }

  async #restoreMaterialized(sourcePath: string, relativePath: string, previous: string | undefined, expectedHash: string) {
    const { writeFile, rm } = await import('node:fs/promises');
    await assertSafeTestPath(sourcePath, relativePath);
    const absolute = path.join(sourcePath, relativePath);
    const current = await readFile(absolute).catch(() => undefined);
    if (!current || createHash('sha256').update(current).digest('hex') !== expectedHash) throw new Error('The Patrol source changed during validation. SaySpec preserved the intervening edit.');
    if (previous === undefined) await rm(absolute, { force: true });
    else await writeFile(absolute, previous);
  }

  async #execute(input: { active: ActiveProcess; sourcePath: string; flutter: Preflight['flutter']; patrolPath: string; device: FlutterDeviceSummary; targets: readonly string[]; showFlutterLogs?: boolean; onLine?: (line: string) => void }) {
    const { active, device } = input;
    // patrol_cli discovers tests under patrol_test/; the targets are passed
    // explicitly so only the saved tests under execution run. Several targets
    // share one generated bundle, so the app is built and installed once.
    // On iOS, patrol_cli asks xcodebuild for the `latest` OS unless told the
    // simulator's own runtime, which fails for an older runtime.
    const osVersion = device.platform === 'ios' ? simulatorOsVersion(device) : undefined;
    const args = ['--flutter-command', input.flutter.flutterPath, 'test', '-d', flutterDeviceId(device), ...(osVersion ? ['--ios', osVersion] : []), ...input.targets.flatMap((target) => ['--target', target]), '--verbose', ...(input.showFlutterLogs ? ['--show-flutter-logs'] : [])];
    const child = spawn(input.patrolPath, args, { cwd: input.sourcePath, env: input.flutter.environment });
    active.child = child;
    const tests = new Map<string, PatrolTestOutcome>();
    let buffer = '';
    let failedBuild = false;
    let canceled = false;
    const timeout = setTimeout(() => { failedBuild = true; child.kill('SIGKILL'); }, BUILD_TIMEOUT_MS + RUN_TIMEOUT_MS * Math.max(1, input.targets.length));

    const consume = (chunk: string) => {
      active.log.push(chunk);
      if (active.log.join('').length > MAX_LOG_BYTES) active.log.splice(0, Math.max(1, active.log.length - 200));
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        input.onLine?.(line);
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) {
          if (/error: |FAILURE: Build failed|Could not build|No connected devices/i.test(trimmed)) failedBuild = true;
          continue;
        }
        try {
          const event = JSON.parse(trimmed) as ReporterEvent;
          this.#applyReporterEvent(tests, event);
        } catch { /* device logs are not all JSON */ }
      }
    };
    child.stdout.on('data', (chunk: Buffer) => consume(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => consume(chunk.toString()));
    const exitCode = await new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', () => resolve(null));
      const watcher = setInterval(async () => {
        if (active.canceled) { canceled = true; clearInterval(watcher); child.kill('SIGTERM'); return; }
        const devices = await this.#captures.devices().catch(() => []);
        const stillThere = devices.some((entry) => entry.id === device.id && entry.state === 'ready');
        if (!stillThere && !canceled) {
          clearInterval(watcher);
          failedBuild = true;
          active.log.push('\nThe device disconnected while the test was running.\n');
          child.kill('SIGTERM');
        }
      }, 3_000);
      child.once('exit', () => clearInterval(watcher));
    });
    clearTimeout(timeout);
    const outcomes = [...tests.values()];
    const truncated = active.log.join('').length >= MAX_LOG_BYTES;
    return {
      tests: outcomes,
      failedBuild,
      canceled: canceled || active.canceled,
      exitCode,
      summary: summarize(outcomes, canceled || active.canceled, failedBuild),
      detail: [
        outcomes.length === 0 ? 'No machine-readable Patrol results were produced. The raw log is stored as an artifact.' : '',
        failedBuild ? 'The build or device connection failed before results were reported.' : '',
        truncated ? 'The run log was truncated to its 4 MiB budget.' : '',
      ].filter(Boolean).join(' '),
    };
  }

  #applyReporterEvent(tests: Map<string, PatrolTestOutcome>, event: ReporterEvent) {
    const name = event.test?.name;
    if (!name) return;
    const id = String(event.test?.id ?? name);
    const current = tests.get(id) ?? { id, title: name, outcome: 'not-run' as const, durationMs: 0, errors: [] };
    if (event.type === 'testDone') {
      const mapped = event.result === 'success' ? 'passed' : event.result === 'skipped' || event.result === 'hidden' ? 'skipped' : 'failed';
      tests.set(id, { ...current, title: name, outcome: mapped, durationMs: Math.round(event.time ?? 0), errors: event.error ? [event.error] : current.errors });
    } else if (event.type === 'error' && event.error) {
      tests.set(id, { ...current, title: name, errors: [...current.errors, event.error] });
    } else if (event.type === 'testStart') {
      tests.set(id, { ...current, title: name });
    }
  }

  /** Copies only results the run actually produced into the attempt. */
  async #collect(sourcePath: string, work: string, attemptId: string, xcresultJson?: string) {
    const artifacts: PatrolAttempt['artifacts'][number][] = [];
    const candidates = [
      { absolute: path.join(work, 'results.json'), relativePath: 'patrol-results.json' },
      { absolute: path.join(work, 'report.json'), relativePath: 'patrol-report.json' },
      { absolute: path.join(sourcePath, 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk'), relativePath: 'app-debug.apk' },
    ];
    const active = this.#active.get(attemptId);
    if (active) artifacts.push(await this.#store.writeArtifact(attemptId, 'patrol-run.log', Buffer.from(active.log.join(''), 'utf8')));
    if (xcresultJson && Buffer.byteLength(xcresultJson) <= MAX_LOG_BYTES) artifacts.push(await this.#store.writeArtifact(attemptId, 'xcresult-tests.json', Buffer.from(xcresultJson, 'utf8')));
    for (const candidate of candidates) {
      const bytes = await readFile(candidate.absolute).catch(() => undefined);
      if (!bytes) continue;
      artifacts.push(await this.#store.writeArtifact(attemptId, candidate.relativePath, bytes));
    }
    return artifacts;
  }
}

function runtimeManifest({ device, flutter, patrol, patrolPackage }: Preflight, test: PatrolSavedTest): PatrolRuntimeManifest {
  return {
    flutterVersion: flutter.flutterVersion,
    ...(flutter.dartVersion ? { dartVersion: flutter.dartVersion } : {}),
    ...(patrol.version ? { patrolCliVersion: patrol.version } : {}),
    patrolPackageVersion: patrolPackage,
    deviceId: device.id,
    deviceName: device.name,
    platform: device.platform,
    ...(device.apiLevel ? { apiLevel: device.apiLevel } : {}),
    ...(device.runtime ? { osVersion: device.runtime } : {}),
    entrypoint: test.relativePath,
    testFileHashes: { [test.relativePath]: test.contentHash },
    environmentHash: environmentHash({ flutterVersion: flutter.flutterVersion, patrolCliVersion: patrol.version, patrolPackageVersion: patrolPackage, deviceId: device.id, entrypoint: test.relativePath }),
  };
}

/** Human summary of normalized outcomes, shared by the parser paths. */
export function summarize(tests: readonly PatrolTestOutcome[], canceled: boolean, failedBuild: boolean) {
  if (canceled) return 'The Patrol run was canceled; the device lease was released.';
  const failed = tests.filter((item) => item.outcome === 'failed').length;
  const passed = tests.filter((item) => item.outcome === 'passed').length;
  if (failed) return `${failed} Patrol test(s) failed.`;
  if (passed) return `${passed} Patrol test(s) passed.`;
  if (failedBuild) return 'The Patrol build or device connection failed before any test ran.';
  return 'Patrol produced no test results.';
}

/**
 * Every testcase in Gradle's JUnit XML for the latest device run.
 *
 * Patrol names each testcase `runDartTest[<bundle name> <dart test name>]`;
 * the title keeps the bundle name so callers can tell which file it ran from.
 */
export async function readJUnitCases(sourcePath: string) {
  const root = path.join(sourcePath, 'build', 'app', 'outputs', 'androidTest-results');
  const files: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(path.join(directory, entry.name));
      else if (entry.name.endsWith('.xml')) files.push(path.join(directory, entry.name));
    }
  };
  await walk(root);
  const tests: PatrolTestOutcome[] = [];
  for (const file of files) {
    const xml = await readFile(file, 'utf8').catch(() => '');
    for (const chunk of xml.split('<testcase').slice(1)) {
      const attributes = chunk.slice(0, chunk.indexOf('>') + 1);
      const name = decodeXml(/name="([^"]*)"/.exec(attributes)?.[1] ?? '');
      const time = Number(/time="([\d.]+)"/.exec(attributes)?.[1] ?? 0);
      const body = chunk.slice(chunk.indexOf('>') + 1, chunk.indexOf('</testcase>') >= 0 ? chunk.indexOf('</testcase>') : undefined);
      const failed = /<failure|<error/.test(body);
      const skipped = /<skipped/.test(body);
      const title = name.startsWith('runDartTest[') ? name.slice('runDartTest['.length, -1) : name;
      tests.push({
        id: `${path.basename(file)}:${name}`,
        title: title || name,
        outcome: skipped ? 'skipped' : failed ? 'failed' : 'passed',
        durationMs: Math.round(time * 1_000),
        errors: failed ? [decodeXml(stripTags(body)).slice(0, 4_000)] : [],
      });
    }
  }
  return tests;
}

/**
 * The device's own results: JUnit cases on Android, `.xcresult` cases on iOS.
 * Both are cleared before a run, so whichever exists belongs to it. With an
 * entrypoint, a report for another file is not that test's evidence.
 */
export async function readDeviceReport(sourcePath: string, entrypoint?: string) {
  const xcresult = await readXcresultCases(sourcePath);
  const tests = [...await readJUnitCases(sourcePath), ...xcresult.tests];
  const dartFile = entrypoint ? path.basename(entrypoint, '.dart') : undefined;
  const relevant = dartFile ? tests.filter((item) => !item.title || item.title.includes(dartFile) || tests.length === 1) : tests;
  return { tests: relevant, ...(xcresult.json ? { xcresultJson: xcresult.json } : {}) };
}

/** Removes the reports a previous run left, Android's and iOS's alike. */
async function clearDeviceReports(sourcePath: string) {
  await rm(path.join(sourcePath, 'build', 'app', 'outputs', 'androidTest-results'), { recursive: true, force: true });
  await rm(path.join(sourcePath, 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk'), { force: true });
  await removeXcresults(sourcePath);
}

function stripTags(value: string) {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeXml(value: string) {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
}

/** A refusal that must happen before a build starts, with the needed action. */
export class BlockedRunError extends Error {
  readonly code = 'patrol-blocked';
}

export async function assertSafeTestPath(sourcePath: string, relativePath: string) {
  if (!/^patrol_test\/[A-Za-z0-9_./-]+\.dart$/.test(relativePath) || relativePath.split('/').includes('..')) throw new Error('Patrol source path is invalid.');
  await realpath(sourcePath);
  if ((await lstat(sourcePath)).isSymbolicLink()) throw new Error('The selected source folder changed; select it again.');
  let cursor = sourcePath;
  for (const segment of relativePath.split('/')) {
    cursor = path.join(cursor, segment);
    const metadata = await lstat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (metadata?.isSymbolicLink()) throw new Error('Patrol source path contains a symbolic link.');
    if (metadata && cursor !== path.join(sourcePath, relativePath) && !metadata.isDirectory()) throw new Error('Patrol source parent is not a directory.');
  }
}

/**
 * Confirms the project can actually execute Patrol tests: the instrumentation
 * configuration, the generated test class, and a discovered test folder.
 */
export async function readPatrolWiring(sourcePath: string) {
  const gradle = await readFile(path.join(sourcePath, 'android', 'app', 'build.gradle.kts'), 'utf8').catch(() => undefined)
    ?? await readFile(path.join(sourcePath, 'android', 'app', 'build.gradle'), 'utf8').catch(() => undefined);
  if (!gradle) return { ready: false, detail: 'The project has no android/app/build.gradle(.kts). Create the Android platform before running Patrol tests.' };
  if (!gradle.includes('PatrolJUnitRunner')) return { ready: false, detail: 'The Android build is not wired to PatrolJUnitRunner, so `patrol test` would report zero tests. Apply the Patrol Android integration in Settings or from the recording review.' };
  const manifest = await readFile(path.join(sourcePath, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8').catch(() => undefined);
  const applicationId = /applicationId\s*=?\s*["']([^"']+)["']/.exec(gradle)?.[1]
    ?? (manifest ? /package="([^"]+)"/.exec(manifest)?.[1] : undefined);
  if (!applicationId) return { ready: false, detail: 'The Android application id could not be resolved, so the Patrol test class cannot be located.' };
  const testClass = path.join(sourcePath, androidTestRelativePath(applicationId));
  try {
    await readFile(testClass, 'utf8');
  } catch {
    return { ready: false, detail: `The Patrol test entry point ${androidTestRelativePath(applicationId)} is missing, so no Dart test would be enumerated.` };
  }
  return { ready: true, detail: 'The Android Patrol instrumentation is configured.', applicationId };
}

async function readPatrolPackageVersion(sourcePath: string) {
  const pubspec = await readFile(path.join(sourcePath, 'pubspec.yaml'), 'utf8').catch(() => undefined);
  if (!pubspec) return undefined;
  const match = /^\s{2}patrol:\s*([^\s#]+)/m.exec(pubspec);
  return match?.[1]?.replace(/["']/g, '');
}
