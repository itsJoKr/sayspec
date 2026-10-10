import { spawn } from 'node:child_process';
import path from 'node:path';
import type { MachineSetupInstallStep, MachineSetupItem, MachineSetupPlan, MachineSetupWorkflow } from '@sayspec/contracts';
import { findAndroidSdkRoot, findJavaHomes, findSdkManager, SHARED_ITEM_IDS, SUPPORTED } from './checks.ts';

/** Quotes one argument for POSIX shell use. User text never becomes shell code. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Rejects any value that could escape a single reviewed command. */
export function assertSafeToken(value: string, label: string) {
  if (!/^[A-Za-z0-9._;:+-]+$/.test(value)) throw new Error(`${label} contains unsupported characters.`);
}

export interface InstallerRuntime {
  androidRoot?: string;
  sdkManager?: string;
  javaHome?: string;
  fvm?: string;
}

/**
 * One reviewed installer step. `command` is what the user is shown before the
 * plan starts and is exactly what executes; nothing is assembled at run time
 * from renderer input.
 */
interface StepDefinition {
  itemId: string;
  label: string;
  command: string;
  interactive: boolean;
  destination?: string;
  expectation?: string;
  /** True when the step can only be completed by the user outside SaySpec. */
  manual?: boolean;
  /** Runs before the command, for example to accept Android licenses first. */
  requiresItemIds?: string[];
}

export async function resolveInstallerRuntime(): Promise<InstallerRuntime> {
  const androidRoot = await findAndroidSdkRoot();
  const sdkManager = androidRoot ? await findSdkManager(androidRoot) : undefined;
  const javaHome = (await findJavaHomes()).find((entry) => {
    const major = Number.parseInt(entry.version.split('.')[0] ?? '0', 10);
    return major >= SUPPORTED.jdk.min && major <= SUPPORTED.jdk.max;
  })?.home;
  const fvmProbe = await (await import('./environment.ts')).resolveTool({ name: 'fvm', versionArgs: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/ });
  return { androidRoot, sdkManager, javaHome, fvm: fvmProbe.found ? fvmProbe.path : undefined };
}

/** Environment additions a step needs in the login shell that runs it. */
function runtimePrefix(runtime: InstallerRuntime): string {
  const exports: string[] = [];
  if (runtime.androidRoot) exports.push(`export ANDROID_SDK_ROOT=${shellQuote(runtime.androidRoot)}`, `export ANDROID_HOME=${shellQuote(runtime.androidRoot)}`);
  if (runtime.javaHome) exports.push(`export JAVA_HOME=${shellQuote(runtime.javaHome)}`);
  return exports.length ? `${exports.join('; ')}; ` : '';
}

function sdkManagerCommand(runtime: InstallerRuntime, packages: string[]) {
  if (!runtime.sdkManager) return 'echo "Android command-line tools are not installed yet."; exit 1';
  const quoted = packages.map((value) => shellQuote(value)).join(' ');
  return `${runtimePrefix(runtime)}${shellQuote(runtime.sdkManager)} --sdk_root=${shellQuote(runtime.androidRoot ?? '')} ${quoted}`;
}

/**
 * Builds the ordered install plan for a workflow.
 *
 * Shared dependencies resolve to a single step even when the workflow's group
 * list mentions them more than once, which is what keeps `Installing` from
 * running Homebrew twice.
 */
export async function buildInstallPlan(input: { workflow: MachineSetupWorkflow; items: readonly MachineSetupItem[]; runtime?: InstallerRuntime }): Promise<MachineSetupPlan> {
  const runtime = input.runtime ?? await resolveInstallerRuntime();
  const byId = new Map(input.items.map((entry) => [entry.id, entry]));
  const requested = collectWorkflowItemIds(input.workflow, input.items);
  const manualSteps: string[] = [];
  const substantialDownloads: string[] = [];

  const definitions: StepDefinition[] = [];
  const add = (definition: StepDefinition) => {
    if (definitions.some((entry) => entry.itemId === definition.itemId)) return;
    definitions.push(definition);
  };

  for (const itemId of requested) {
    const entry = byId.get(itemId);
    if (!entry || entry.state === 'installed' || entry.state === 'verified' || entry.state === 'unsupported') continue;
    const definition = definitionFor(itemId, entry, runtime);
    if (!definition) {
      manualSteps.push(entry.recovery ?? `${entry.label} must be completed outside SaySpec.`);
      continue;
    }
    if (definition.manual) manualSteps.push(definition.command.startsWith('MANUAL:') ? definition.command.slice('MANUAL:'.length).trim() : definition.label);
    add(definition);
    if (definition.expectation) substantialDownloads.push(`${definition.label}: ${definition.expectation}`);
  }

  return {
    workflow: input.workflow,
    itemIds: requested,
    sharedItemIds: requested.filter((id) => SHARED_ITEM_IDS.has(id)),
    manualSteps,
    substantialDownloads,
    steps: definitions.map<MachineSetupInstallStep>((definition) => ({
      itemId: definition.itemId,
      label: definition.label,
      command: definition.command,
      destination: definition.destination,
      interactive: definition.interactive,
      expectation: definition.expectation,
      alreadySatisfied: false,
    })),
  };
}

/** Every item id a workflow depends on, in install order. */
export function collectWorkflowItemIds(workflow: MachineSetupWorkflow, items: readonly MachineSetupItem[]): string[] {
  const present = new Set(items.map((entry) => entry.id));
  const order: Record<MachineSetupWorkflow, string[]> = {
    general: ['homebrew', 'node', 'coding_agent_cli', 'local_transcription'],
    web: ['homebrew', 'node', 'playwright_browser'],
    'flutter-android': [
      'homebrew', 'jdk', 'android_sdk_root', 'android_cmdline_tools', 'flutter_sdk', 'dart', 'patrol_cli',
      'android_platform', 'android_build_tools', 'android_licenses', 'android_system_image', 'android_emulator',
      'android_device', 'patrol_integration', 'recorder_sdk',
    ],
    'flutter-ios': ['homebrew', 'xcode_clt', 'xcode', 'ios_simulator', 'cocoapods'],
  };
  return order[workflow].filter((id) => present.has(id));
}

function definitionFor(itemId: string, entry: MachineSetupItem, runtime: InstallerRuntime): StepDefinition | undefined {
  switch (itemId) {
    case 'homebrew':
      return { itemId, label: 'Install Homebrew', command: 'MANUAL: Install Homebrew from https://brew.sh, then re-check.', interactive: true, manual: true };
    case 'node':
      return { itemId, label: 'Install Node.js', command: 'brew install node', interactive: false, destination: '/opt/homebrew or /usr/local', expectation: 'Small download.' };
    case 'coding_agent_cli':
      return { itemId, label: 'Install a coding agent CLI', command: 'MANUAL: In Settings → Default AI, choose Claude Code or Codex, install it, and sign in once.', interactive: true, manual: true };
    case 'local_transcription':
      return { itemId, label: 'Finish local transcription setup', command: 'MANUAL: Choose and install a local model in Settings → Narration.', interactive: true, manual: true };
    case 'playwright_browser':
      return { itemId, label: 'Install Playwright Chromium', command: 'npx --yes playwright install chromium', interactive: false, destination: 'Playwright browser cache', expectation: 'About 150 MB download.' };
    case 'jdk':
      return { itemId, label: `Install a supported JDK (${SUPPORTED.jdk.label})`, command: 'brew install --cask temurin@21', interactive: true, destination: '/Library/Java/JavaVirtualMachines', expectation: 'About 200 MB download.' };
    case 'android_sdk_root':
      return { itemId, label: 'Install Android command-line tools', command: 'brew install --cask android-commandlinetools', interactive: true, destination: '/opt/homebrew/share/android-commandlinetools', expectation: 'About 150 MB download.' };
    case 'android_cmdline_tools':
      return { itemId, label: 'Install Android command-line tools', command: 'brew install --cask android-commandlinetools', interactive: true, destination: '/opt/homebrew/share/android-commandlinetools', expectation: 'About 150 MB download.' };
    case 'flutter_sdk': {
      const version = entry.requirement?.match(/\d+\.\d+\.\d+/)?.[0];
      if (runtime.fvm) return { itemId, label: `Install Flutter ${version ?? ''}`.trim(), command: `fvm install ${version ? shellQuote(version) : ''}`.trim(), interactive: true, destination: '~/.fvm/versions', expectation: 'About 1 GB download.' };
      return { itemId, label: 'Install Flutter SDK', command: 'MANUAL: Install Flutter (fvm, Homebrew or the official archive), then re-check.', interactive: true, manual: true };
    }
    case 'dart':
      return { itemId, label: 'Repair the Dart SDK', command: 'MANUAL: Dart ships with Flutter; repair the Flutter SDK instead.', interactive: true, manual: true };
    case 'patrol_cli':
      return { itemId, label: `Install Patrol CLI ${SUPPORTED.patrolCli}`, command: `dart pub global activate patrol_cli ${SUPPORTED.patrolCli}`, interactive: false, destination: '~/.pub-cache/bin', expectation: 'Small Dart package download.' };
    case 'android_platform':
      return { itemId, label: `Install Android platform ${SUPPORTED.android.compileSdk}`, command: sdkManagerCommand(runtime, [`platforms;android-${SUPPORTED.android.compileSdk}`]), interactive: false, destination: runtime.androidRoot ? path.join(runtime.androidRoot, 'platforms') : undefined, expectation: 'About 70 MB download.', requiresItemIds: ['android_cmdline_tools'] };
    case 'android_build_tools':
      return { itemId, label: `Install Android build tools ${SUPPORTED.android.buildTools}`, command: sdkManagerCommand(runtime, [`build-tools;${SUPPORTED.android.buildTools}`]), interactive: false, destination: runtime.androidRoot ? path.join(runtime.androidRoot, 'build-tools') : undefined, expectation: 'About 60 MB download.', requiresItemIds: ['android_cmdline_tools'] };
    case 'android_licenses':
      return { itemId, label: 'Accept the Android SDK licenses', command: 'MANUAL: Run `sdkmanager --licenses` in a terminal and accept each license; this needs your own confirmation.', interactive: true, manual: true };
    case 'android_system_image': {
      const image = `system-images;android-${SUPPORTED.android.compileSdk};google_apis;arm64-v8a`;
      return { itemId, label: 'Install an Android emulator system image', command: `yes | ${sdkManagerCommand(runtime, [image])}`, interactive: false, destination: runtime.androidRoot ? path.join(runtime.androidRoot, 'system-images') : undefined, expectation: 'About 1.5 GB download.', requiresItemIds: ['android_licenses'] };
    }
    case 'android_emulator': {
      const image = `system-images;android-${SUPPORTED.android.compileSdk};google_apis;arm64-v8a`;
      const avdCommand = runtime.sdkManager
        ? `${runtimePrefix(runtime)}AVDMANAGER="$(dirname ${shellQuote(runtime.sdkManager)})/avdmanager"; if [ ! -x "$AVDMANAGER" ]; then echo "avdmanager is missing."; exit 1; fi; echo no | "$AVDMANAGER" create avd -n sayspec_sample -k ${shellQuote(image)}`
        : 'echo "Android command-line tools are not installed yet."; exit 1';
      return { itemId, label: 'Create an Android virtual device', command: avdCommand, interactive: false, destination: '~/.android/avd', requiresItemIds: ['android_system_image'] };
    }
    case 'android_device':
      return { itemId, label: 'Start an emulator or connect a device', command: 'MANUAL: Start an emulator (or connect a phone with USB debugging) and wait for it to finish booting.', interactive: true, manual: true };
    case 'patrol_integration':
      return { itemId, label: 'Add a Patrol integration test', command: 'MANUAL: Add a `patrolTest(...)` file under integration_test/. Generation can create one from a recording.', interactive: true, manual: true };
    case 'recorder_sdk':
      return { itemId, label: 'Integrate the SaySpec recorder SDK', command: 'MANUAL: Apply the previewed recorder integration to pubspec.yaml and lib/main.dart.', interactive: true, manual: true };
    case 'xcode_clt':
      return { itemId, label: 'Install Xcode Command Line Tools', command: 'xcode-select --install', interactive: true, destination: '/Library/Developer/CommandLineTools', expectation: 'Apple installer dialog; wait for it to finish.' };
    case 'xcode':
      return { itemId, label: 'Install Xcode', command: 'MANUAL: Install Xcode from the App Store, then run `sudo xcode-select -s /Applications/Xcode.app`.', interactive: true, manual: true };
    case 'ios_simulator':
      return { itemId, label: 'Download the iOS simulator runtime', command: '/usr/bin/xcodebuild -downloadPlatform iOS', interactive: true, destination: 'Xcode simulator runtimes', expectation: 'Several GB download.' };
    case 'cocoapods':
      return { itemId, label: 'Install CocoaPods', command: 'brew install cocoapods', interactive: false, destination: 'Homebrew prefix', expectation: 'Small download.' };
    default:
      return undefined;
  }
}

/** Streams one command, yielding output lines and honoring cancellation. */
export function runStreamingCommand(input: {
  command: string;
  cwd?: string;
  signal: AbortSignal;
  onData: (chunk: string) => void;
}): Promise<{ code: number; canceled: boolean }> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/zsh';
    const child = spawn(shell, ['-lc', input.command], { cwd: input.cwd, env: process.env, detached: true });
    let canceled = false;
    const kill = () => {
      canceled = true;
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 4_000).unref();
    };
    if (input.signal.aborted) kill();
    input.signal.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (chunk: Buffer) => input.onData(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => input.onData(chunk.toString()));
    child.on('error', (error) => { input.onData(`\n${error.message}\n`); });
    child.on('close', (code) => {
      input.signal.removeEventListener('abort', kill);
      resolve({ code: code ?? (canceled ? 1 : 0), canceled: canceled || input.signal.aborted });
    });
  });
}

/**
 * Opens a reviewed command in the user's terminal.
 *
 * Used for installers that need sudo, an OS dialog or an App Store sign-in —
 * interactions SaySpec must not automate and cannot fake.
 */
export function openInTerminal(command: string, title = 'SaySpec setup'): string {
  const escaped = command.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const safeTitle = title.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ');
  if (process.platform === 'darwin') {
    return `/usr/bin/osascript -e 'tell application "Terminal" to do script "${escaped}"' -e 'tell application "Terminal" to activate' -e "tell application \\"Terminal\\" to set custom title of front window to \\"${safeTitle}\\""`;
  }
  return command;
}
