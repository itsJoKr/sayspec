import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseFlutterRunCommand } from '@sayspec/contracts';
import type {
  FlutterCapture, FlutterCaptureLaunchLogEvent, FlutterCaptureLifecycleEvent, FlutterCaptureStartInput, FlutterCaptureSummary, FlutterDeviceSummary, FlutterRecorderSdkCompatibility,
} from '@sayspec/contracts';
import { resolveTool, runFile } from '../setup/environment.ts';
import { FlutterCaptureServer } from './capture-server.ts';
import { FlutterCaptureStore } from './capture-store.ts';
import { readableFlutterRunLines } from './flutter-run-log.ts';
import { flutterDeviceId, simulatorHasApp, xcodeBundleIds } from './ios-patrol.ts';
import { RECORDER_SCHEMA_VERSION, RECORDER_SDK_VERSION } from './recorder-sdk.ts';
import { resolveProjectFlutterToolchain } from './toolchain.ts';

const REQUIRED_SCHEMA = RECORDER_SCHEMA_VERSION;
const SDK_PACKAGE = 'sayspec_flutter_recorder';
const MAX_LOG_LINES = 400;

type CaptureDraft = Awaited<ReturnType<FlutterCaptureStore['create']>>;

/**
 * One launch of the instrumented app. It outlives individual captures: each
 * Record/Stop cycle on the device produces one capture (`draft`), and the app
 * is restarted between them instead of rebuilt.
 */
interface ActiveSession {
  sessionId: string;
  projectId: string;
  input: Omit<FlutterCaptureStartInput, 'sourceHandle'>;
  sourcePath: string;
  device: FlutterDeviceSummary;
  server: FlutterCaptureServer;
  /** The current test: `preparing` until Record is pressed on the device. */
  draft: CaptureDraft;
  /** Resolves when the device posts its completion summary for the current test. */
  completion: { promise: Promise<void>; resolve: () => void };
  deviceCompleted: boolean;
  finishing?: Promise<FlutterCapture>;
  autoFinish?: ReturnType<typeof setTimeout>;
  process?: ChildProcessWithoutNullStreams;
  /** The loopback capture port; forwarded to an Android device, shared by an iOS simulator. */
  reversePort?: number;
  /** The installed Android package or iOS bundle id the restart path relaunches. */
  packageName?: string;
  log: string[];
  phase: 'launching' | 'ready' | 'recording' | 'restarting' | 'ended';
  testNumber: number;
}

/**
 * Drives Flutter recording end to end.
 *
 * Responsibilities in order: resolve the selected device, verify the app
 * actually depends on the recorder SDK, forward the loopback capture port to
 * the device, launch the instrumented app, stream device logs, and store the
 * evidence the app posts. Nothing here infers readiness from tool presence.
 */
export class FlutterCaptureSessionManager {
  readonly #store: FlutterCaptureStore;
  readonly #onLifecycle: (event: FlutterCaptureLifecycleEvent) => void;
  readonly #onLaunchLog: (event: FlutterCaptureLaunchLogEvent) => void;
  readonly #active = new Map<string, ActiveSession>();
  readonly #tools = new Map<string, ReturnType<typeof resolveTool>>();
  readonly #starting = new Map<string, Promise<FlutterDeviceSummary>>();

  constructor(options: {
    store: FlutterCaptureStore;
    onLifecycle: (event: FlutterCaptureLifecycleEvent) => void;
    /** Readable `flutter run` output while the app builds and launches. */
    onLaunchLog?: (event: FlutterCaptureLaunchLogEvent) => void;
  }) {
    this.#store = options.store;
    this.#onLifecycle = options.onLifecycle;
    this.#onLaunchLog = options.onLaunchLog ?? (() => undefined);
  }

  async shutdown() {
    for (const session of [...this.#active.values()]) {
      await this.cancel(session.draft.id).catch(() => undefined);
    }
  }

  /** Devices `flutter devices` and `adb` both accept, with honest states. */
  async devices(): Promise<FlutterDeviceSummary[]> {
    const [adb, emulator, flutter] = await Promise.all([this.#tool('adb'), this.#tool('emulator'), this.#tool('flutter')]);
    // Every probe is independent, so they run together; listing is on the
    // path to the first screen and serial probes add up to several seconds.
    const [android, avds, ios] = await Promise.all([
      adb.found && adb.path ? this.#adbDevices(adb.path) : [],
      adb.found && emulator.found && emulator.path ? this.#installedAvds(emulator.path) : [],
      flutter.found ? this.#iosSimulators() : [],
    ]);
    // An AVD that is not running yet is still a selectable target; the start
    // path boots it, so it is listed rather than hidden.
    const idleAvds = avds.filter((avd) => !android.some((device) => device.name === avd.name));
    return [...android, ...idleAvds, ...ios];
  }

  /** Resolves a tool once per process; a miss is retried so a fresh install is picked up. */
  #tool(name: 'adb' | 'emulator' | 'flutter') {
    let resolved = this.#tools.get(name);
    if (!resolved) {
      resolved = resolveTool({ name, skipVersion: true }).then((tool) => {
        if (!tool.found) this.#tools.delete(name);
        return tool;
      });
      this.#tools.set(name, resolved);
    }
    return resolved;
  }

  async #adbDevices(adbPath: string): Promise<FlutterDeviceSummary[]> {
    const result = await runFile(adbPath, ['devices', '-l'], { timeoutMs: 15_000 });
    const lines = result.stdout.split('\n').slice(1).map((line) => line.trim()).filter((line) => line && !line.startsWith('*'));
    const devices = await Promise.all(lines.map(async (line): Promise<FlutterDeviceSummary | undefined> => {
      const [serial, state] = line.split(/\s+/);
      if (!serial) return undefined;
      const model = /model:(\S+)/.exec(line)?.[1]?.replaceAll('_', ' ');
      // A running emulator reports its AVD name, which is what a user
      // recognises and what a boot request must match.
      const [apiLevel, avdName] = await Promise.all([
        this.#androidApiLevel(adbPath, serial),
        serial.startsWith('emulator-') ? this.#avdName(adbPath, serial) : undefined,
      ]);
      return {
        id: serial,
        name: avdName ?? (model ? model : serial),
        kind: serial.startsWith('emulator-') ? 'emulator' : 'device',
        platform: 'android',
        state: state === 'device' ? 'ready' : state === 'unauthorized' ? 'unauthorized' : state === 'offline' ? 'offline' : 'booting',
        ...(apiLevel ? { apiLevel } : {}),
        detail: state === 'device' ? `adb reports ${serial} ready.` : `adb reports ${serial} as ${state}.`,
      };
    }));
    return devices.filter((device): device is FlutterDeviceSummary => Boolean(device));
  }

  async #installedAvds(emulatorPath: string): Promise<FlutterDeviceSummary[]> {
    const avds = await runFile(emulatorPath, ['-list-avds'], { timeoutMs: 15_000 });
    return avds.stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((avd) => (
      { id: `avd:${avd}`, name: avd, kind: 'emulator', platform: 'android', state: 'stopped', detail: `${avd} is installed but not running.` }
    ));
  }

  async #iosSimulators(): Promise<FlutterDeviceSummary[]> {
    const iosSimulators = await runFile('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { timeoutMs: 20_000 });
    if (iosSimulators.code !== 0) return [];
    const devices: FlutterDeviceSummary[] = [];
    try {
      const parsed = JSON.parse(iosSimulators.stdout) as { devices?: Record<string, { udid: string; name: string; state: string }[]> };
      for (const [runtime, entries] of Object.entries(parsed.devices ?? {})) {
        if (!/iOS/.test(runtime)) continue;
        // com.apple.CoreSimulator.SimRuntime.iOS-26-5 → iOS 26.5
        const version = runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '').replace(/^(\w+)-/, '$1 ').replaceAll('-', '.');
        for (const entry of entries) {
          devices.push({
            id: `ios:${entry.udid}`,
            name: entry.name,
            kind: 'emulator',
            platform: 'ios',
            state: entry.state === 'Booted' ? 'ready' : entry.state === 'Shutdown' ? 'stopped' : 'booting',
            runtime: version,
            detail: `${entry.name} on ${version} (state ${entry.state}).`,
          });
        }
      }
    } catch { /* simctl output is best effort */ }
    return devices;
  }

  async #avdName(adbPath: string, serial: string) {
    const result = await runFile(adbPath, ['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: 10_000 });
    const name = result.stdout.split('\n').map((line) => line.trim()).find((line) => line.length > 0 && line !== 'OK');
    return name || undefined;
  }

  async #androidApiLevel(adbPath: string, serial: string) {
    const result = await runFile(adbPath, ['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk'], { timeoutMs: 10_000 });
    const level = result.stdout.trim().match(/^\d+$/)?.[0];
    return level || undefined;
  }

  /**
   * Boots a device and waits until it is ready, without starting a recording.
   *
   * Used by the Patrol run path and by callers that need a live device before
   * deciding what to do with it.
   */
  async ensureDevice(device: FlutterDeviceSummary): Promise<FlutterDeviceSummary> {
    return device.state === 'ready' ? device : this.startDevice(device.id);
  }

  /**
   * Starts a listed `stopped` AVD or iOS simulator and resolves with it once
   * it has finished booting. Only ids from `devices()` are accepted, and a
   * second request for a device that is already starting joins the first.
   */
  startDevice(deviceId: string): Promise<FlutterDeviceSummary> {
    const pending = this.#starting.get(deviceId);
    if (pending) return pending;
    const started = this.#startDevice(deviceId).finally(() => this.#starting.delete(deviceId));
    this.#starting.set(deviceId, started);
    return started;
  }

  async #startDevice(deviceId: string): Promise<FlutterDeviceSummary> {
    const device = (await this.devices()).find((entry) => entry.id === deviceId);
    if (!device) throw new Error('That emulator or simulator is no longer listed. Re-check devices and choose it again.');
    if (device.state === 'ready') return device;
    if (device.state !== 'stopped') throw new Error(`${device.name} is not ready: ${device.detail}`);
    return device.platform === 'ios' ? this.#bootSimulator(device) : this.#bootEmulator(device);
  }

  async #bootEmulator(device: FlutterDeviceSummary): Promise<FlutterDeviceSummary> {
    const [emulator, adb] = await Promise.all([this.#tool('emulator'), this.#tool('adb')]);
    if (!emulator.found || !emulator.path) throw new Error('The Android emulator binary is missing. Run Settings → Machine setup.');
    if (!adb.found || !adb.path) throw new Error('adb is missing, so SaySpec cannot tell when the emulator is ready. Run Settings → Machine setup.');
    const child = spawn(emulator.path, ['-avd', device.name, '-no-snapshot-save', '-no-boot-anim'], { detached: true, stdio: 'ignore' });
    let exit: string | undefined;
    child.once('exit', (code, signal) => { exit = signal ?? `code ${code}`; });
    child.once('error', (error) => { exit = error.message; });
    child.unref();
    // Wait for this AVD specifically: a connected phone or another running
    // emulator must not be mistaken for it.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await delay(2_000);
      if (exit) throw new Error(`The ${device.name} emulator closed before it finished booting (${exit}). Start it from Android Studio's Device Manager to see why.`);
      const running = (await this.#adbDevices(adb.path)).find((entry) => entry.kind === 'emulator' && entry.name === device.name && entry.state === 'ready');
      if (!running) continue;
      const booted = await runFile(adb.path, ['-s', running.id, 'shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 10_000 });
      if (booted.stdout.trim() === '1') return running;
    }
    throw new Error(`${device.name} did not finish booting within four minutes.`);
  }

  async #bootSimulator(device: FlutterDeviceSummary): Promise<FlutterDeviceSummary> {
    const udid = device.id.slice('ios:'.length);
    const boot = await runFile('/usr/bin/xcrun', ['simctl', 'boot', udid], { timeoutMs: 60_000 });
    if (boot.code !== 0 && !/current state: Booted/i.test(boot.stderr)) {
      throw new Error(`${device.name} could not start: ${boot.stderr.trim().split('\n').at(-1) || `simctl exited with code ${boot.code}`}`);
    }
    // simctl boots headless; open the Simulator window so the user can see and use it.
    await runFile('/usr/bin/open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid], { timeoutMs: 15_000 });
    const status = await runFile('/usr/bin/xcrun', ['simctl', 'bootstatus', udid], { timeoutMs: 240_000 });
    if (status.code !== 0) throw new Error(`${device.name} did not finish booting within four minutes.`);
    return { ...device, state: 'ready', detail: `${device.name} on ${device.runtime ?? 'iOS'} (state Booted).` };
  }

  /** Verifies the selected app can actually emit evidence. */
  async recorderSdkCompatibility(sourcePath?: string): Promise<FlutterRecorderSdkCompatibility> {
    if (!sourcePath) return { state: 'missing', requiredSchema: REQUIRED_SCHEMA, detail: 'Select the Flutter project folder so SaySpec can check its recorder dependency.' };
    const pubspec = await readFile(path.join(sourcePath, 'pubspec.yaml'), 'utf8').catch(() => undefined);
    if (!pubspec) return { state: 'missing', requiredSchema: REQUIRED_SCHEMA, detail: 'pubspec.yaml was not found in the selected folder.' };
    const declared = new RegExp(`^\\s{2}${SDK_PACKAGE}\\s*:\\s*(\\S+)`, 'm').exec(pubspec)?.[1];
    if (!declared) return { state: 'missing', requiredSchema: REQUIRED_SCHEMA, detail: `${SDK_PACKAGE} is not declared in pubspec.yaml, so the app cannot emit widget evidence.` };
    const packageConfig = await readFile(path.join(sourcePath, '.dart_tool', 'package_config.json'), 'utf8').catch(() => undefined);
    let packageRoot: string | undefined;
    if (packageConfig) {
      try {
        const parsed = JSON.parse(packageConfig) as { packages?: Array<{ name?: string; rootUri?: string }> };
        const rootUri = parsed.packages?.find((item) => item.name === SDK_PACKAGE)?.rootUri;
        if (rootUri) packageRoot = rootUri.startsWith('file:') ? fileURLToPath(rootUri) : path.resolve(path.join(sourcePath, '.dart_tool'), rootUri);
      } catch { /* malformed package config becomes an actionable missing state below */ }
    }
    if (!packageRoot) return { state: 'missing', requiredSchema: REQUIRED_SCHEMA, detail: `${SDK_PACKAGE} is declared but not resolved. Run the selected project's pinned Flutter “pub get”, then re-check.` };
    const sdkPubspec = await readFile(path.join(packageRoot, 'pubspec.yaml'), 'utf8').catch(() => undefined);
    const schemaSource = await readFile(path.join(packageRoot, 'lib', 'src', 'schema.dart'), 'utf8').catch(() => undefined);
    const version = sdkPubspec?.match(/^version:\s*(\d+\.\d+\.\d+)/m)?.[1];
    const schema = Number(schemaSource?.match(/static const int version\s*=\s*(\d+)/)?.[1] ?? 0);
    if (version !== RECORDER_SDK_VERSION || schema !== REQUIRED_SCHEMA) {
      return { state: 'incompatible', requiredSchema: REQUIRED_SCHEMA, ...(schema ? { detectedSchema: schema } : {}), detail: `The resolved ${SDK_PACKAGE} is ${version ?? 'an unknown version'} with schema ${schema || 'unknown'}; SaySpec requires ${RECORDER_SDK_VERSION} / schema ${REQUIRED_SCHEMA}. Reapply the recorder integration.` };
    }
    return { state: 'ready', requiredSchema: REQUIRED_SCHEMA, detectedSchema: schema, detail: `The project resolves ${SDK_PACKAGE} ${version} at ${packageRoot}; the recorder emits schema ${schema}.` };
  }

  /**
   * Builds, installs and launches the instrumented app once for a recording
   * session. The app opens idle with the SaySpec overlay; each Record/Stop on
   * the device (or Stop on the desktop) saves one capture, and the app is then
   * restarted — not rebuilt — so the next test starts from a fresh process.
   */
  async start(input: Omit<FlutterCaptureStartInput, 'sourceHandle'>, sourcePath: string): Promise<FlutterCaptureSummary> {
    const existing = [...this.#active.values()].find((session) => session.projectId === input.projectId);
    if (existing) throw new Error('A Flutter recording session is already running for this project.');
    const devices = await this.devices();
    let device = devices.find((entry) => entry.id === input.deviceId);
    if (!device) throw new Error('That device is no longer available. Re-check the machine setup and choose a device again.');
    if (device.state !== 'ready') {
      this.#emitForProject(input.projectId, 'device-booting', `Starting ${device.name}…`, 0.05);
      device = await this.startDevice(device.id);
    }
    const compatibility = await this.recorderSdkCompatibility(sourcePath);
    if (compatibility.state !== 'ready') throw new Error(compatibility.detail);
    if (input.entryPoint) {
      const { target } = parseFlutterRunCommand(input.entryPoint.command);
      if (target && !(await readFile(path.join(sourcePath, target)).then(() => true, () => false))) throw new Error(`The ${input.entryPoint.name} entry point runs ${target}, which is not in the selected project. Update it in Settings → Entry points.`);
    }
    const flutter = await resolveProjectFlutterToolchain(sourcePath);

    const sessionId = `flutter_session_${randomUUID()}`;
    const session: ActiveSession = {
      sessionId, projectId: input.projectId, input, sourcePath, device,
      server: undefined as unknown as FlutterCaptureServer,
      draft: undefined as unknown as CaptureDraft,
      completion: deferred(), deviceCompleted: false,
      log: [], phase: 'launching', testNumber: 0,
    };
    session.draft = await this.#newDraft(session);
    session.server = new FlutterCaptureServer({
      onEvents: ({ envelope, events }) => this.#onDeviceEvents(session, envelope, events),
      onSessionComplete: () => this.#onDeviceStopped(session),
      onRequest: (kind) => {
        // A restarted app calibrates its clock during startup; that is the
        // first sign it is up and showing the overlay again.
        if (kind === 'clock' && session.phase === 'restarting') {
          session.phase = 'ready';
          this.#emit(session.draft.id, 'waiting-for-user', 'The app restarted. Tap Record in the SaySpec overlay on the device to record the next test.', 1);
        }
      },
    });
    const { port } = await session.server.start({ captureId: sessionId });
    session.reversePort = port;
    // An iOS simulator shares the host's loopback, so 127.0.0.1 in the app
    // already reaches the capture server; an Android device needs the port
    // reversed onto it.
    let adbPath: string | undefined;
    if (device.platform === 'android') {
      const adb = await resolveTool({ name: 'adb', versionArgs: ['version'] });
      if (!adb.found || !adb.path) {
        await session.server.stop();
        throw new Error('adb is missing. Run Settings → Machine setup.');
      }
      adbPath = adb.path;
      const reverse = await runFile(adb.path, ['-s', device.id, 'reverse', `tcp:${port}`, `tcp:${port}`], { timeoutMs: 15_000 });
      if (reverse.code !== 0) {
        await session.server.stop();
        throw new Error('The capture port could not be forwarded to the device. Reconnect the device and try again.');
      }
    }
    this.#active.set(sessionId, session);
    this.#emit(session.draft.id, 'app-launching', `Building and installing the app on ${device.name}…`, 0.1);
    try {
      await this.#launch(session, flutter);
      session.packageName = adbPath ? await this.#resolvePackage(adbPath, session) : await this.#resolveBundleId(session);
      // The first test's draft predates this lookup; it records the app that actually runs.
      if (session.packageName) session.draft.appId = session.packageName;
    } catch (error) {
      await this.#teardown(session);
      throw error;
    }
    session.phase = 'ready';
    this.#emit(session.draft.id, 'waiting-for-user', 'The app is running. Tap Record in the SaySpec overlay on the device, then narrate while you test.', 1);
    return this.#summary(session);
  }

  /** The capture a project's live session is on, so a remounted view can reattach. */
  active(projectId: string): FlutterCaptureSummary | null {
    const session = [...this.#active.values()].find((entry) => entry.projectId === projectId);
    return session ? this.#summary(session) : null;
  }

  async #newDraft(session: ActiveSession) {
    session.testNumber += 1;
    session.completion = deferred();
    session.deviceCompleted = false;
    return this.#store.create({
      organizationId: session.input.organizationId ?? 'local',
      projectId: session.projectId,
      sessionId: session.sessionId,
      sessionTitle: session.input.title?.trim() || `${session.input.projectName} ${session.device.platform === 'ios' ? 'iOS' : 'Android'} session`,
      title: `Recording ${session.testNumber}`,
      deviceId: session.device.id,
      deviceName: session.device.name,
      platform: session.device.platform,
      appId: session.packageName ?? requestedAppId(session.input) ?? 'unknown',
      ...(session.input.entryPoint ? { entryPoint: { name: session.input.entryPoint.name, command: session.input.entryPoint.command } } : {}),
      recorderSdkVersion: 'unknown',
      recorderSchemaVersion: REQUIRED_SCHEMA,
    });
  }

  async #onDeviceEvents(session: ActiveSession, envelope: Record<string, unknown> | undefined, events: Record<string, unknown>[]) {
    const started = events.some((event) => event.kind === 'lifecycle' && (event.payload as { phase?: unknown } | undefined)?.phase === 'started');
    if (started && session.draft.status !== 'preparing') {
      // Record was pressed again without the host finishing the previous test
      // (for example the app was not restarted); keep that evidence and move on.
      if (session.draft.events.length) await this.#store.setStatus(session.draft, 'interrupted', 'A new test started on the device before this one was stopped from SaySpec.');
      session.draft = await this.#newDraft(session);
    }
    await this.#store.appendBatch(session.draft, { ...(envelope ? { envelope } : {}), events });
    if (started && session.draft.status === 'preparing') {
      session.draft.startedAt = new Date().toISOString();
      await this.#store.setStatus(session.draft, 'recording');
      session.phase = 'recording';
      this.#emit(session.draft.id, 'recording', 'Recording on the device. Narrate what should happen as you test.', 1);
    }
  }

  #onDeviceStopped(session: ActiveSession) {
    session.deviceCompleted = true;
    session.completion.resolve();
    if (session.finishing || (session.draft.status !== 'recording' && session.draft.status !== 'paused')) return;
    // Stopped from the device overlay: the renderer owns the narration, so it
    // finishes that and calls stop(). If no view is listening, save anyway.
    const captureId = session.draft.id;
    this.#emit(captureId, 'stop-requested', 'Stopped on the device; saving the test…');
    clearTimeout(session.autoFinish);
    session.autoFinish = setTimeout(() => {
      if (session.draft.id === captureId) void this.stop(captureId).catch(() => undefined);
    }, 20_000);
  }

  #emit(captureId: string, state: FlutterCaptureLifecycleEvent['state'], message: string, progress?: number) {
    this.#onLifecycle({ captureId, state, message, ...(progress === undefined ? {} : { progress }) });
  }

  #emitForProject(_projectId: string, state: FlutterCaptureLifecycleEvent['state'], message: string, progress?: number) {
    this.#onLifecycle({ captureId: 'pending', state, message, ...(progress === undefined ? {} : { progress }) });
  }

  async #launch(session: ActiveSession, flutter: Awaited<ReturnType<typeof resolveProjectFlutterToolchain>>) {
    const port = session.reversePort!;
    const args = [
      'run', '--machine', '-d', flutterDeviceId(session.device),
      `--dart-define=SAYSPEC_RECORDING_URL=http://127.0.0.1:${port}`,
      `--dart-define=SAYSPEC_RECORDING_SESSION=${session.sessionId}`,
      `--dart-define=SAYSPEC_RECORDING_TOKEN=${session.server.token}`,
      `--dart-define=SAYSPEC_RECORDING_PROJECT=${session.projectId}`,
    ];
    // The entry point's flags (flavor, target, defines) follow SaySpec's own;
    // the project's pinned SDK is used whether the command says fvm or not.
    if (session.input.entryPoint) args.push(...parseFlutterRunCommand(session.input.entryPoint.command).args);
    else if (session.input.flavor) args.push('--flavor', session.input.flavor);
    const child = spawn(flutter.flutterPath, args, { cwd: session.sourcePath, env: flutter.environment });
    session.process = child;
    let buffer = '';
    let stderrBuffer = '';
    let appStarted = false;
    // Until the app starts, its build output streams to the view so a failed
    // launch shows why; afterwards the output is only kept in the session log.
    const showLaunch = (lines: string[]) => {
      if (!appStarted && lines.length) this.#onLaunchLog({ projectId: session.projectId, lines });
    };
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The instrumented app did not start within five minutes. Open the launch console for the build output.')), 5 * 60_000);
      const finish = (error?: Error) => { clearTimeout(timeout); if (error) reject(error); else resolve(); };
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          this.#pushLog(session, `${line}\n`);
          showLaunch(readableFlutterRunLines(line));
          if (!appStarted && /"event":"app\.started"/.test(line)) {
            appStarted = true;
            finish();
          }
          if (!appStarted && /"event":"daemon\.log"/.test(line) && /Application finished\.|Error launching application/.test(line)) {
            finish(new Error('The app exited during launch. Open the launch console for the failure.'));
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        this.#pushLog(session, chunk.toString());
        stderrBuffer += chunk.toString();
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() ?? '';
        showLaunch(lines.flatMap(readableFlutterRunLines));
      });
      child.once('error', (error) => finish(new Error(`The Flutter launch failed: ${error.message}`)));
      child.once('exit', (code) => {
        showLaunch([buffer, stderrBuffer].flatMap(readableFlutterRunLines));
        if (!appStarted) finish(new Error(`The Flutter launch exited with code ${code}. Open the launch console for the output.`));
      });
    });
  }

  /**
   * The Android package the restart path force-stops and relaunches.
   *
   * The entry point's application ID is preferred as-is; when it is absent or
   * not installed, the project's Gradle `applicationId` (plus the flavor's
   * suffix) is used.
   */
  async #resolvePackage(adbPath: string, session: ActiveSession) {
    const requested = requestedAppId(session.input);
    const ids = await gradleApplicationIds(session.sourcePath);
    // A flavor usually installs as `<applicationId><applicationIdSuffix>`.
    const flavor = session.input.entryPoint ? parseFlutterRunCommand(session.input.entryPoint.command).flavor : session.input.flavor;
    const suffixes = await gradleApplicationIdSuffixes(session.sourcePath, flavor);
    const candidates = [...(requested ? [requested] : []), ...ids.flatMap((id) => suffixes.map((suffix) => `${id}${suffix}`)), ...ids];
    for (const candidate of [...new Set(candidates)]) {
      if (!/^[A-Za-z][\w.]*$/.test(candidate)) continue;
      const result = await runFile(adbPath, ['-s', session.device.id, 'shell', 'pm', 'path', candidate], { timeoutMs: 10_000 });
      if (result.code === 0 && result.stdout.includes('package:')) return candidate;
    }
    return undefined;
  }

  /**
   * The iOS bundle id the restart path terminates and relaunches.
   *
   * The entry point's application ID is preferred; otherwise the Runner
   * target's bundle ids are tried, the launched flavor's Debug configuration
   * first, and the first one installed on the simulator wins.
   */
  async #resolveBundleId(session: ActiveSession) {
    const requested = requestedAppId(session.input);
    const flavor = session.input.entryPoint ? parseFlutterRunCommand(session.input.entryPoint.command).flavor : session.input.flavor;
    const udid = flutterDeviceId(session.device);
    for (const candidate of [...new Set([...(requested ? [requested] : []), ...await xcodeBundleIds(session.sourcePath, flavor)])]) {
      if (/^[A-Za-z0-9][\w.-]*$/.test(candidate) && await simulatorHasApp(udid, candidate)) return candidate;
    }
    return undefined;
  }

  /** Restarts the app process without rebuilding, like Process Phoenix. */
  async #restartApp(session: ActiveSession) {
    session.phase = 'restarting';
    const captureId = session.draft.id;
    this.#emit(captureId, 'restarting', 'Restarting the app for the next test…', 0.5);
    if (session.device.platform === 'ios') return this.#restartSimulatorApp(session);
    const adb = await resolveTool({ name: 'adb' });
    if (!adb.found || !adb.path) throw new Error('adb is missing, so the app could not be restarted.');
    const packageName = session.packageName;
    if (!packageName) throw new Error(`SaySpec could not find ${requestedAppId(session.input) ? `“${requestedAppId(session.input)}”` : 'the app'} installed on ${session.device.name}, so the app was not restarted. Set the entry point's Application ID in Settings → Entry points, then start a new recording session.`);
    // The flutter tool only mattered for the build; once the app is killed it
    // would exit on its own, so it is stopped first to keep that quiet.
    await this.#stopProcess(session);
    await runFile(adb.path, ['-s', session.device.id, 'shell', 'am', 'force-stop', packageName], { timeoutMs: 15_000 });
    const resolved = await runFile(adb.path, ['-s', session.device.id, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', packageName], { timeoutMs: 15_000 });
    const component = resolved.stdout.split('\n').map((line) => line.trim()).reverse().find((line) => line.startsWith(`${packageName}/`));
    if (!component) throw new Error(`${packageName} has no launcher activity on ${session.device.name}, so it could not be restarted.`);
    const launched = await runFile(adb.path, ['-s', session.device.id, 'shell', 'am', 'start', '-n', component], { timeoutMs: 20_000 });
    if (launched.code !== 0 || /Error:/i.test(`${launched.stdout}${launched.stderr}`)) {
      throw new Error(`${packageName} could not be relaunched on ${session.device.name}: ${`${launched.stdout}${launched.stderr}`.trim().slice(0, 300)}`);
    }
  }

  /** Relaunches the installed build; a simulator runs a debug build without the flutter tool attached. */
  async #restartSimulatorApp(session: ActiveSession) {
    const bundleId = session.packageName;
    if (!bundleId) throw new Error(`SaySpec could not find ${requestedAppId(session.input) ? `“${requestedAppId(session.input)}”` : 'the app'} installed on ${session.device.name}, so the app was not restarted. Set the entry point's Application ID (the iOS bundle id) in Settings → Entry points, then start a new recording session.`);
    const udid = flutterDeviceId(session.device);
    await this.#stopProcess(session);
    // Terminating an app that already exited fails harmlessly.
    await runFile('/usr/bin/xcrun', ['simctl', 'terminate', udid, bundleId], { timeoutMs: 15_000 });
    const launched = await runFile('/usr/bin/xcrun', ['simctl', 'launch', udid, bundleId], { timeoutMs: 30_000 });
    if (launched.code !== 0) {
      throw new Error(`${bundleId} could not be relaunched on ${session.device.name}: ${`${launched.stderr}${launched.stdout}`.trim().slice(0, 300)}`);
    }
  }

  #pushLog(session: ActiveSession, chunk: string) {
    session.log.push(chunk);
    if (session.log.length > MAX_LOG_LINES) session.log.splice(0, session.log.length - MAX_LOG_LINES);
  }

  getLog(captureId: string) {
    return this.#find(captureId)?.log.join('') ?? '';
  }

  async pause(captureId: string): Promise<FlutterCaptureSummary> {
    const session = this.#require(captureId);
    session.server.enqueue({ command: 'pause' });
    await this.#store.setStatus(session.draft, 'paused');
    this.#emit(captureId, 'paused', 'Recording paused on the device.');
    return this.#summary(session);
  }

  async resume(captureId: string): Promise<FlutterCaptureSummary> {
    const session = this.#require(captureId);
    session.server.enqueue({ command: 'resume' });
    await this.#store.setStatus(session.draft, 'recording');
    this.#emit(captureId, 'recording', 'Recording resumed on the device.');
    return this.#summary(session);
  }

  async mark(captureId: string, label: string) {
    const session = this.#require(captureId);
    session.server.enqueue({ command: 'mark', label });
    return this.#summary(session);
  }

  /**
   * Saves the current test and prepares the next one in the same session.
   *
   * Works for a Stop pressed on the desktop (the device is told to stop and
   * drain) and on the device overlay (the device already drained). The app is
   * then restarted in the background; the returned capture is the saved test.
   */
  async stop(captureId: string): Promise<FlutterCapture> {
    const session = this.#require(captureId);
    if (session.finishing) return session.finishing;
    clearTimeout(session.autoFinish);
    const draft = session.draft;
    session.finishing = (async () => {
      if (!session.deviceCompleted && (draft.status === 'recording' || draft.status === 'paused')) {
        session.server.enqueue({ command: 'stop' });
        // The app drains its queue and posts a completion summary; the
        // recorder polls every few hundred milliseconds while recording.
        await Promise.race([session.completion.promise, delay(10_000)]);
      }
      const saved = await this.#store.setStatus(draft, draft.events.length ? 'ready' : 'failed', draft.events.length ? undefined : 'The app reported no events; tap Record in the SaySpec overlay before testing.');
      session.draft = await this.#newDraft(session);
      void this.#restartApp(session).catch((error: unknown) => {
        session.phase = 'ready';
        this.#emit(session.draft.id, 'failed', error instanceof Error ? error.message : 'The app could not be restarted.');
      });
      if (!saved.events.length) throw new Error(saved.error ?? 'The recording captured no evidence.');
      return this.#store.get(saved.projectId, captureId);
    })();
    try { return await session.finishing; }
    finally { session.finishing = undefined; }
  }

  /** Ends the recording session: the app is closed and a test in progress is kept as interrupted. */
  async cancel(captureId: string) {
    const session = this.#find(captureId);
    if (!session) return;
    await this.#teardown(session);
    const draft = session.draft;
    if (draft.events.length) {
      await this.#store.setStatus(draft, 'interrupted', 'Recording session ended before this test was stopped.');
      this.#emit(draft.id, 'interrupted', 'Recording session ended; the unfinished test is kept.');
    } else {
      await this.#store.remove(draft.id);
      this.#emit(draft.id, 'interrupted', 'Recording session ended.');
    }
  }

  async beginNarration(captureId: string, mimeType: string) {
    const session = this.#require(captureId);
    return this.#store.beginNarration(session.draft, mimeType, FlutterCaptureServer.monotonicMs());
  }

  async appendNarration(captureId: string, mimeType: string, bytes: Uint8Array) {
    const session = this.#require(captureId);
    await this.#store.appendNarration(session.draft, mimeType, bytes);
  }

  async finishNarration(captureId: string) {
    const session = this.#require(captureId);
    return this.#store.finishNarration(session.draft, FlutterCaptureServer.monotonicMs());
  }

  async #stopProcess(session: ActiveSession) {
    const child = session.process;
    session.process = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  async #teardown(session: ActiveSession) {
    clearTimeout(session.autoFinish);
    session.phase = 'ended';
    this.#active.delete(session.sessionId);
    await this.#stopProcess(session);
    if (session.device.platform === 'ios') {
      if (session.packageName) await runFile('/usr/bin/xcrun', ['simctl', 'terminate', flutterDeviceId(session.device), session.packageName], { timeoutMs: 10_000 });
      await session.server.stop();
      return;
    }
    const adb = await resolveTool({ name: 'adb' });
    if (adb.found && adb.path && session.device.platform === 'android' && !session.device.id.startsWith('avd:')) {
      if (session.packageName) await runFile(adb.path, ['-s', session.device.id, 'shell', 'am', 'force-stop', session.packageName], { timeoutMs: 10_000 });
      if (session.reversePort) await runFile(adb.path, ['-s', session.device.id, 'reverse', '--remove', `tcp:${session.reversePort}`], { timeoutMs: 10_000 });
    }
    await session.server.stop();
  }

  #find(captureId: string) {
    return [...this.#active.values()].find((session) => session.draft.id === captureId);
  }

  #require(captureId: string) {
    const session = this.#find(captureId);
    if (!session) throw new Error('That Flutter recording is no longer running.');
    return session;
  }

  #summary(session: ActiveSession): FlutterCaptureSummary {
    const { clock: _clock, events: _events, artifacts: _artifacts, narration: _narration, ...summary } = session.draft;
    return { ...summary };
  }
}

/** The application ID asked for explicitly, or the chosen entry point's. */
function requestedAppId(input: Pick<FlutterCaptureStartInput, 'appId' | 'entryPoint'>) {
  return input.appId?.trim() || input.entryPoint?.appId || undefined;
}

async function gradleApplicationIds(sourcePath: string) {
  const ids: string[] = [];
  for (const name of ['build.gradle.kts', 'build.gradle']) {
    const text = await readFile(path.join(sourcePath, 'android', 'app', name), 'utf8').catch(() => '');
    for (const match of text.matchAll(/applicationId\s*=?\s*["']([^"']+)["']/g)) if (match[1]) ids.push(match[1]);
  }
  return ids;
}

/** The launched flavor's `applicationIdSuffix` when its block declares one; otherwise every declared suffix. */
export async function gradleApplicationIdSuffixes(sourcePath: string, flavor?: string) {
  const suffix = /applicationIdSuffix\s*=?\s*["']([^"']+)["']/;
  const all: string[] = [];
  for (const name of ['build.gradle.kts', 'build.gradle']) {
    const text = await readFile(path.join(sourcePath, 'android', 'app', name), 'utf8').catch(() => '');
    if (flavor && /^[\w-]+$/.test(flavor)) {
      const block = new RegExp(`(?:create\\(\\s*["']${flavor}["']\\s*\\)|\\b${flavor})\\s*\\{([^{}]*)\\}`).exec(text)?.[1];
      if (block) return suffix.exec(block)?.[1] ? [suffix.exec(block)![1]!] : [];
    }
    for (const match of text.matchAll(new RegExp(suffix.source, 'g'))) if (match[1]) all.push(match[1]);
  }
  return all;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Stable capture id generator used by tests and IPC responses. */
export function newCaptureId() { return `flutter_capture_${randomUUID()}`; }
