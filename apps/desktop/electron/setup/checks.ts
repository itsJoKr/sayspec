import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  MachineSetupAction, MachineSetupGroup, MachineSetupItem, MachineSetupReport, MachineSetupState, MachineSetupWorkflow,
} from '@sayspec/contracts';
import { compareVersions, fileExists, firstVersion, listDirectories, parseIndentedField, readTextIfPresent, resolveTool, runFile } from './environment.ts';
import { readIosPatrolWiring } from '../flutter/ios-patrol.ts';
import { readProjectFlutterPin, resolveProjectFlutterToolchain } from '../flutter/toolchain.ts';

/** Versions this build of SaySpec was actually checked against. */
export const SUPPORTED = {
  jdk: { min: 17, max: 21, label: 'JDK 17 or 21 (Gradle 8.x / Android Gradle Plugin)' },
  node: { min: '22.12.0', label: 'Node.js 22.12 or newer' },
  dart: { min: '3.8.0', label: 'Dart 3.8 or newer' },
  patrolCli: '4.8.0',
  android: { compileSdk: '36', buildTools: '36.0.0', platformTools: '35.0.0' },
  ios: { minimumXcode: '16.0' },
} as const;

/** Dependencies that appear in more than one workflow group. */
export const SHARED_ITEM_IDS = new Set(['homebrew', 'node', 'coding_agent_cli', 'local_transcription', 'jdk', 'flutter_sdk', 'dart', 'patrol_cli', 'recorder_sdk']);

export interface SetupContext {
  /** Selected project source, used for project-specific checks. */
  sourcePath?: string;
  project?: MachineSetupReport['project'];
}

interface ItemDraft extends Omit<MachineSetupItem, 'checkedAt'> {}

const now = () => new Date().toISOString();

function item(draft: ItemDraft): MachineSetupItem {
  return { ...draft, checkedAt: now() };
}

function stateFor(found: boolean, compatible: boolean | undefined, manual = false): MachineSetupState {
  if (!found) return manual ? 'waiting-for-user' : 'missing';
  if (compatible === false) return 'incompatible';
  return 'installed';
}

function actionFor(state: MachineSetupState, manual: boolean): MachineSetupAction {
  if (state === 'missing' || state === 'incompatible') return manual ? 'manual' : 'install';
  if (state === 'waiting-for-user') return 'manual';
  return 'none';
}

/** Detects macOS's developer directory without assuming Xcode is selected. */
export async function resolveDeveloperDirectory() {
  const result = await runFile('/usr/bin/xcode-select', ['-p'], { timeoutMs: 10_000 });
  if (result.code !== 0) return undefined;
  const selected = result.stdout.trim();
  return selected || undefined;
}

export async function findAndroidSdkRoot(): Promise<string | undefined> {
  const candidates = [
    process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME,
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
    '/usr/local/share/android-sdk',
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (await fileExists(path.join(candidate, 'platform-tools'))) return candidate;
    if (await fileExists(path.join(candidate, 'cmdline-tools'))) return candidate;
  }
  return undefined;
}

/** JDK candidates in the order a build should prefer them. */
export async function findJavaHomes() {
  const homes: string[] = [];
  if (process.env.JAVA_HOME) homes.push(process.env.JAVA_HOME);
  const home = os.homedir();
  // `/usr/libexec/java_home` is the same lookup a login shell and Gradle use,
  // so it finds JDKs the other sources miss on macOS.
  for (const version of ['21', '17']) {
    const result = await runFile('/usr/libexec/java_home', ['-v', version], { timeoutMs: 10_000 });
    if (result.code === 0 && result.stdout.trim()) homes.push(result.stdout.trim());
  }
  for (const candidate of [
    '/opt/homebrew/opt/openjdk@21', '/opt/homebrew/opt/openjdk@17', '/usr/local/opt/openjdk@21', '/usr/local/opt/openjdk@17',
    '/Library/Java/JavaVirtualMachines', path.join(home, 'Library', 'Java', 'JavaVirtualMachines'),
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  ]) {
    if (candidate.endsWith('JavaVirtualMachines')) {
      for (const entry of await listDirectories(candidate)) {
        homes.push(path.join(candidate, entry, 'Contents', 'Home'));
      }
      continue;
    }
    homes.push(candidate);
  }
  const usable: { home: string; version: string }[] = [];
  for (const candidate of homes) {
    const java = path.join(candidate, 'bin', 'java');
    if (!(await fileExists(java))) continue;
    const result = await runFile(java, ['-version'], { timeoutMs: 10_000 });
    const version = firstVersion(`${result.stdout}${result.stderr}`);
    if (version) usable.push({ home: candidate, version });
  }
  return usable;
}

function jdkCompatible(version: string) {
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
  return major >= SUPPORTED.jdk.min && major <= SUPPORTED.jdk.max;
}

/** True when `cmdline-tools` exposes the SDK manager within the SDK root. */
export async function findSdkManager(androidRoot: string): Promise<string | undefined> {
  const candidates = [
    path.join(androidRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'),
    path.join(androidRoot, 'cmdline-tools', 'bin', 'sdkmanager'),
    path.join(androidRoot, 'tools', 'bin', 'sdkmanager'),
  ];
  for (const candidate of candidates) if (await fileExists(candidate)) return candidate;
  for (const version of await listDirectories(path.join(androidRoot, 'cmdline-tools'))) {
    const candidate = path.join(androidRoot, 'cmdline-tools', version, 'bin', 'sdkmanager');
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

async function androidComponents(androidRoot: string) {
  return {
    platforms: await listDirectories(path.join(androidRoot, 'platforms')),
    buildTools: await listDirectories(path.join(androidRoot, 'build-tools')),
    systemImages: await systemImages(androidRoot),
    licenses: await listFiles(path.join(androidRoot, 'licenses')),
  };
}

/** Names of regular files in a directory, or an empty list. */
async function listFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch { return []; }
}

async function systemImages(androidRoot: string): Promise<string[]> {
  const found: string[] = [];
  const root = path.join(androidRoot, 'system-images');
  for (const api of await listDirectories(root)) {
    for (const variant of await listDirectories(path.join(root, api))) {
      for (const abi of await listDirectories(path.join(root, api, variant))) found.push(`${api};${variant};${abi}`);
    }
  }
  return found;
}

export async function listAvds(): Promise<string[]> {
  const emulator = await resolveTool({ name: 'emulator', versionArgs: ['-version'], versionPattern: /(\d+\.\d+\.\d+)/ });
  if (!emulator.found || !emulator.path) return [];
  const result = await runFile(emulator.path, ['-list-avds'], { timeoutMs: 15_000 });
  return result.code === 0 ? result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('INFO')) : [];
}

/** Connected devices from `adb devices -l`, excluding unauthorized rows. */
export async function listAndroidDevices() {
  const adb = await resolveTool({ name: 'adb', versionArgs: ['version'], versionPattern: /(\d+\.\d+\.\d+)/ });
  if (!adb.found || !adb.path) return [];
  const result = await runFile(adb.path, ['devices', '-l'], { timeoutMs: 15_000 });
  if (result.code !== 0) return [];
  return result.stdout.split('\n').slice(1).map((line) => line.trim()).filter((line) => line.includes('device') && !line.startsWith('*'))
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      const model = /model:(\S+)/.exec(line)?.[1];
      const product = /product:(\S+)/.exec(line)?.[1];
      return { serial, state, model, product };
    });
}

export interface ProjectFlutterRequirements {
  pinnedFlutterSdk?: string;
  pinnedPatrol?: string;
  applicationId?: string;
  problem?: string;
}

/** True when pubspec.yaml declares the dependency, however it is sourced. */
export async function pubspecDeclares(sourcePath: string, packageName: string) {
  const pubspec = await readTextIfPresent(path.join(sourcePath, 'pubspec.yaml'));
  if (!pubspec) return false;
  return new RegExp(`^\\s{2}${packageName}\\s*:`, 'm').test(pubspec);
}

/** Reads the project's own pins instead of inheriting a fixed SaySpec default. */
export async function readFlutterProjectRequirements(sourcePath: string): Promise<ProjectFlutterRequirements> {
  const pubspec = await readTextIfPresent(path.join(sourcePath, 'pubspec.yaml'));
  if (!pubspec) return { problem: 'pubspec.yaml was not found in the selected folder.' };
  const patrol = /^\s{2}patrol:\s*(.+)$/m.exec(pubspec)?.[1]?.trim().replace(/["']/g, '');
  // Only FVM pins an exact Flutter. `environment: sdk:` constrains Dart, not
  // Flutter, so it must never be read as the Flutter version.
  const pinned = await readProjectFlutterPin(sourcePath);
  const gradle = await readTextIfPresent(path.join(sourcePath, 'android', 'app', 'build.gradle'));
  const gradleKts = gradle ?? await readTextIfPresent(path.join(sourcePath, 'android', 'app', 'build.gradle.kts'));
  const applicationId = gradleKts ? /applicationId\s*[=:]\s*["']([^"']+)["']/.exec(gradleKts)?.[1] : undefined;
  return { pinnedFlutterSdk: pinned, pinnedPatrol: patrol, applicationId };
}

/** Whether an integration-test folder with a Patrol-importing test exists. */
export async function inspectPatrolIntegration(sourcePath: string) {
  let files = 0;
  let patrolTests = 0;
  const found: string[] = [];
  // `patrol_test/` is what patrol_cli discovers; `integration_test/` stays
  // supported because Flutter projects commonly keep tests there.
  for (const folder of ['patrol_test', 'integration_test']) {
    const directory = path.join(sourcePath, folder);
    let names: string[] = [];
    try { names = (await readdir(directory)).filter((name) => name.endsWith('.dart')); } catch { continue; }
    files += names.length;
    for (const name of names) {
      const text = await readFile(path.join(directory, name), 'utf8');
      if (text.includes('package:patrol/patrol.dart')) { patrolTests += 1; found.push(`${folder}/${name}`); }
    }
  }
  return { present: files > 0, patrolTests, files, found };
}

/**
 * Runs every machine check for the requested workflows.
 *
 * Shared steps (`homebrew`, `node`, `claude`) appear in each group that needs
 * them; installation consults this same list, so a shared dependency is
 * installed once even though it is displayed several times.
 */
export async function checkMachineSetup(context: SetupContext): Promise<MachineSetupReport> {
  const platform = process.platform;
  const flutter = await resolveTool({ name: 'flutter', versionArgs: ['--version'], versionPattern: /Flutter\s+(\d+\.\d+\.\d+)/ });
  const dart = await resolveTool({ name: 'dart', versionArgs: ['--version'], versionPattern: /Dart SDK version:\s+(\d+\.\d+\.\d+)/ });
  const patrol = await resolveTool({ name: 'patrol', versionArgs: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/ });
  const node = await resolveTool({ name: 'node', versionArgs: ['--version'], versionPattern: /v?(\d+\.\d+\.\d+)/ });
  const brew = await resolveTool({ name: 'brew', versionArgs: ['--version'], versionPattern: /Homebrew\s+(\d+\.\d+\.\d+)/ });
  const claude = await resolveTool({ name: 'claude', versionArgs: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/ });
  const codex = await resolveTool({ name: 'codex', versionArgs: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/ });
  const pod = await resolveTool({ name: 'pod', versionArgs: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/ });
  const javaHomes = await findJavaHomes();
  const compatibleJdk = javaHomes.find((entry) => jdkCompatible(entry.version));
  const androidRoot = await findAndroidSdkRoot();
  const components = androidRoot ? await androidComponents(androidRoot) : undefined;
  const sdkManager = androidRoot ? await findSdkManager(androidRoot) : undefined;
  const avds = platform === 'darwin' || platform === 'linux' ? await listAvds() : [];
  const devices = platform === 'darwin' || platform === 'linux' ? await listAndroidDevices() : [];
  const bootedDevice = devices.find((device) => device.state === 'device');
  const developerDirectory = platform === 'darwin' ? await resolveDeveloperDirectory() : undefined;
  const hasXcode = Boolean(developerDirectory?.includes('Xcode.app'));
  const simulatorRuntimes = platform === 'darwin' && hasXcode
    ? (await runFile('/usr/bin/xcrun', ['simctl', 'list', 'runtimes'], { timeoutMs: 20_000 })).stdout
    : '';
  const projectRequirements = context.sourcePath ? await readFlutterProjectRequirements(context.sourcePath) : undefined;
  let projectToolchain: Awaited<ReturnType<typeof resolveProjectFlutterToolchain>> | undefined;
  let projectToolchainError: string | undefined;
  if (context.sourcePath) {
    try { projectToolchain = await resolveProjectFlutterToolchain(context.sourcePath); }
    catch (error) { projectToolchainError = error instanceof Error ? error.message : String(error); }
  }
  const patrolIntegration = context.sourcePath ? await inspectPatrolIntegration(context.sourcePath) : undefined;
  const recorder = context.sourcePath ? await pubspecDeclares(context.sourcePath, 'sayspec_flutter_recorder') : false;
  const iosWiring = context.sourcePath && platform === 'darwin' ? await readIosPatrolWiring(context.sourcePath) : undefined;

  const jdkItem = item({
    id: 'jdk', group: 'flutter-android', label: 'Java Development Kit', purpose: 'Compiles the Android Gradle build.',
    state: javaHomes.length === 0 ? 'missing' : compatibleJdk ? 'installed' : 'incompatible',
    detected: compatibleJdk?.version ?? javaHomes[0]?.version,
    detectedPath: compatibleJdk?.home ?? javaHomes[0]?.home,
    requirement: SUPPORTED.jdk.label,
    detail: compatibleJdk
      ? `Java ${compatibleJdk.version} at ${compatibleJdk.home}.`
      : javaHomes.length === 0
        ? (process.env.JAVA_HOME ? `JAVA_HOME is ${process.env.JAVA_HOME}, but it has no usable java binary.` : 'No JDK was found and JAVA_HOME is unset, so Gradle cannot build the Android app.')
        : `Found Java ${javaHomes[0]?.version}, which is outside the supported ${SUPPORTED.jdk.label}.`,
    recovery: compatibleJdk ? undefined : 'Install a supported JDK; SaySpec can install Temurin 21.',
    action: 'none', manual: false,
  });
  jdkItem.action = actionFor(jdkItem.state, false);

  const androidSdkRootItem = item({
    id: 'android_sdk_root', group: 'flutter-android', label: 'Android SDK', purpose: 'Provides the platform, build tools and emulator images the app links against.',
    state: androidRoot ? 'installed' : 'missing',
    detected: androidRoot ?? undefined, detectedPath: androidRoot,
    requirement: `platform android-${SUPPORTED.android.compileSdk}, build-tools ${SUPPORTED.android.buildTools}`,
    detail: androidRoot ? `Android SDK at ${androidRoot}.` : 'No Android SDK root was found (ANDROID_SDK_ROOT, ANDROID_HOME or the default location).',
    recovery: androidRoot ? undefined : 'Install the Android command-line tools; SaySpec can do this with Homebrew.',
    action: 'none', manual: false, resolution: androidRoot ? 'common-path' : 'not-found',
  });
  androidSdkRootItem.action = actionFor(androidSdkRootItem.state, false);

  const cmdlineToolsItem = item({
    id: 'android_cmdline_tools', group: 'flutter-android', label: 'Android command-line tools', purpose: 'Installs and updates SDK platforms, build tools and system images.',
    state: sdkManager ? 'installed' : 'missing',
    detected: sdkManager ? path.dirname(sdkManager) : undefined, detectedPath: sdkManager,
    requirement: 'sdkmanager from cmdline-tools',
    detail: sdkManager ? `sdkmanager at ${sdkManager}.` : 'sdkmanager is unavailable, so SDK components cannot be installed or updated.',
    recovery: sdkManager ? undefined : 'Install Android command-line tools; SaySpec can do this with Homebrew.',
    action: 'none', manual: false, resolution: sdkManager ? 'common-path' : 'not-found',
  });
  cmdlineToolsItem.action = actionFor(cmdlineToolsItem.state, false);

  const platformInstalled = components?.platforms.find((value) => value === `android-${SUPPORTED.android.compileSdk}`)
    ?? components?.platforms.slice().sort(compareVersions).at(-1);
  const platformItem = item({
    id: 'android_platform', group: 'flutter-android', label: 'Android platform', purpose: 'The API level the app compiles against.',
    state: platformInstalled ? 'installed' : 'missing',
    detected: platformInstalled, requirement: `android-${SUPPORTED.android.compileSdk}`,
    detail: platformInstalled
      ? `Installed ${platformInstalled}.`
      : 'No Android platform is installed.',
    recovery: platformInstalled ? undefined : `Install android-${SUPPORTED.android.compileSdk} with sdkmanager.`,
    action: 'none', manual: false, resolution: platformInstalled ? 'common-path' : 'not-found',
  });
  platformItem.action = actionFor(platformItem.state, false);

  const buildToolsInstalled = components?.buildTools.slice().sort(compareVersions).at(-1);
  const buildToolsItem = item({
    id: 'android_build_tools', group: 'flutter-android', label: 'Android build tools', purpose: 'Packages and signs the debug and release APKs.',
    state: buildToolsInstalled ? 'installed' : 'missing',
    detected: buildToolsInstalled, requirement: `build-tools ${SUPPORTED.android.buildTools} or newer`,
    detail: buildToolsInstalled ? `Installed build-tools ${buildToolsInstalled}.` : 'No Android build tools are installed.',
    recovery: buildToolsInstalled ? undefined : `Install build-tools;${SUPPORTED.android.buildTools} with sdkmanager.`,
    action: 'none', manual: false, resolution: buildToolsInstalled ? 'common-path' : 'not-found',
  });
  buildToolsItem.action = actionFor(buildToolsItem.state, false);

  const licenseItem = item({
    id: 'android_licenses', group: 'flutter-android', label: 'Android SDK licenses', purpose: 'Gradle refuses to download SDK components until the licenses are accepted.',
    state: (components?.licenses.length ?? 0) > 0 ? 'installed' : 'waiting-for-user',
    detected: components?.licenses.length ? `${components.licenses.length} accepted` : undefined,
    requirement: 'android-sdk-license accepted',
    detail: (components?.licenses.length ?? 0) > 0
      ? `${components?.licenses.length} license files are accepted.`
      : 'No accepted license files were found; a build will stop and ask for `sdkmanager --licenses`.',
    recovery: 'SaySpec opens a terminal where you accept the Android SDK licenses yourself.',
    action: 'manual', manual: true, resolution: 'common-path',
  });

  const systemImageItem = item({
    id: 'android_system_image', group: 'flutter-android', label: 'Emulator system image', purpose: 'The Android image an emulator boots from.',
    state: (components?.systemImages.length ?? 0) > 0 ? 'installed' : 'missing',
    detected: components?.systemImages[0], requirement: `system-images;android-${SUPPORTED.android.compileSdk};google_apis;arm64-v8a`,
    detail: (components?.systemImages.length ?? 0) > 0 ? `${components?.systemImages.length} system image(s): ${components?.systemImages.slice(0, 3).join(', ')}.` : 'No emulator system image is installed.',
    recovery: 'SaySpec can download a Google APIs system image for the current API level.',
    action: 'none', manual: false, resolution: (components?.systemImages.length ?? 0) > 0 ? 'common-path' : 'not-found',
    expectation: 'About 1.5 GB download.',
  });
  systemImageItem.action = actionFor(systemImageItem.state, false);

  const emulatorItem = item({
    id: 'android_emulator', group: 'flutter-android', label: 'Android emulator', purpose: 'Runs the instrumented app without a physical device.',
    state: avds.length > 0 ? 'installed' : 'missing',
    detected: avds.length ? avds.join(', ') : undefined,
    requirement: 'At least one AVD',
    detail: avds.length ? `${avds.length} virtual device(s): ${avds.join(', ')}.` : 'The emulator has no virtual device yet.',
    recovery: 'SaySpec can create an AVD from an installed system image.',
    action: 'none', manual: false, resolution: avds.length ? 'login-shell' : 'not-found',
  });
  emulatorItem.action = actionFor(emulatorItem.state, false);

  const deviceItem = item({
    id: 'android_device', group: 'flutter-android', label: 'Android device', purpose: 'A booted emulator or authorized phone the recording and Patrol run attach to.',
    state: bootedDevice ? 'installed' : 'waiting-for-user',
    detected: bootedDevice ? `${bootedDevice.serial}${bootedDevice.model ? ` · ${bootedDevice.model}` : ''}` : undefined,
    requirement: 'adb reports one device in the `device` state',
    detail: bootedDevice
      ? `${bootedDevice.serial} is ready.`
      : devices.length
        ? `adb sees ${devices.map((device) => `${device.serial} (${device.state})`).join(', ')} but none are authorized.`
        : 'No device or emulator is attached.',
    recovery: bootedDevice ? undefined : 'Start an emulator or plug in a device and accept the USB debugging prompt.',
    action: 'manual', manual: true, resolution: bootedDevice ? 'login-shell' : 'not-found',
  });

  const flutterSdkPin = projectRequirements?.pinnedFlutterSdk;
  const effectiveFlutterVersion = projectToolchain?.flutterVersion ?? flutter.version;
  const effectiveFlutterPath = projectToolchain?.flutterPath ?? flutter.path;
  const flutterFound = context.sourcePath ? Boolean(projectToolchain) : flutter.found;
  const flutterCompatible = effectiveFlutterVersion && flutterSdkPin ? compareVersions(effectiveFlutterVersion, flutterSdkPin) === 0 : undefined;
  const flutterItem = item({
    id: 'flutter_sdk', group: 'flutter-android', label: 'Flutter SDK', purpose: 'Builds and installs the instrumented app.',
    state: stateFor(flutterFound, flutterCompatible),
    detected: effectiveFlutterVersion, detectedPath: effectiveFlutterPath, requirement: flutterSdkPin ? `Flutter ${flutterSdkPin} (project pin)` : 'Flutter stable with Dart 3.8 or newer',
    detail: projectToolchain
      ? `Flutter ${projectToolchain.flutterVersion} at ${projectToolchain.flutterPath}, resolved for this project (${projectToolchain.resolution}).`
      : projectToolchainError ?? (flutter.found ? `Flutter ${flutter.version ?? 'version unknown'} at ${flutter.path}.` : 'flutter was not found in the login shell or a known install location.'),
    recovery: flutterFound ? (flutterCompatible === false ? `Install Flutter ${flutterSdkPin} (fvm install ${flutterSdkPin}) or update the project pin.` : undefined) : 'Install the selected project’s pinned Flutter SDK, for example with fvm.',
    action: 'none', manual: false, resolution: projectToolchain ? 'project' : flutter.resolution,
  });
  flutterItem.action = actionFor(flutterItem.state, false);

  const effectiveDartVersion = projectToolchain?.dartVersion ?? dart.version;
  const effectiveDartPath = projectToolchain?.dartPath ?? dart.path;
  const dartFound = context.sourcePath ? Boolean(projectToolchain?.dartPath) : dart.found;
  const dartCompatible = effectiveDartVersion ? compareVersions(effectiveDartVersion, SUPPORTED.dart.min) >= 0 : undefined;
  const dartItem = item({
    id: 'dart', group: 'flutter-android', label: 'Dart', purpose: 'Resolves packages and runs the Patrol CLI.',
    state: dartFound ? (dartCompatible === false ? 'incompatible' : 'installed') : 'missing',
    detected: effectiveDartVersion, detectedPath: effectiveDartPath, requirement: SUPPORTED.dart.label,
    detail: dartFound ? `Dart ${effectiveDartVersion ?? 'version unknown'} at ${effectiveDartPath}.` : 'The selected project’s Flutter SDK and bundled Dart executable are unavailable.',
    recovery: dartFound ? undefined : 'Install or repair the selected project’s pinned Flutter SDK, which provides Dart.',
    action: 'none', manual: false, resolution: projectToolchain ? 'project' : dart.resolution,
  });
  dartItem.action = actionFor(dartItem.state, false);

  const patrolCompatible = patrol.version ? compareVersions(patrol.version, SUPPORTED.patrolCli) >= 0 : undefined;
  const patrolPackage = projectRequirements?.pinnedPatrol;
  const patrolItem = item({
    id: 'patrol_cli', group: 'flutter-android', label: 'Patrol CLI', purpose: 'Builds the instrumented APK and drives Patrol tests on the device.',
    state: patrol.found ? (patrolCompatible === false ? 'incompatible' : 'installed') : 'missing',
    detected: patrol.version, detectedPath: patrol.path,
    requirement: `patrol_cli ${SUPPORTED.patrolCli} or newer${patrolPackage ? `; project pins patrol ${patrolPackage}` : ''}`,
    detail: patrol.found
      ? `patrol ${patrol.version ?? 'version unknown'} at ${patrol.path}.`
      : 'patrol is not on PATH; the project cannot run Patrol tests.',
    recovery: patrol.found ? (patrolCompatible === false ? `Run: dart pub global activate patrol_cli ${SUPPORTED.patrolCli}` : undefined) : 'SaySpec can install the Patrol CLI with dart pub global activate.',
    action: 'none', manual: false, resolution: patrol.resolution,
    expectation: 'Small download (Dart package).',
  });
  patrolItem.action = actionFor(patrolItem.state, false);

  const integrationItem = item({
    id: 'patrol_integration', group: 'flutter-android', label: 'Patrol integration tests', purpose: 'A Patrol test file is what a run executes and what generation writes into.',
    state: !context.sourcePath ? 'waiting-for-user' : patrolIntegration?.patrolTests ? 'installed' : 'missing',
    detected: patrolIntegration ? `${patrolIntegration.patrolTests} Patrol test(s) of ${patrolIntegration.files} Dart file(s)${patrolIntegration.found.length ? `: ${patrolIntegration.found.slice(0, 3).join(', ')}` : ''}` : undefined,
    requirement: 'integration_test/*.dart importing package:patrol/patrol.dart',
    detail: !context.sourcePath
      ? 'Select the Flutter project folder to check its integration tests.'
      : patrolIntegration?.patrolTests
        ? `${patrolIntegration.patrolTests} Patrol test file(s) found.`
        : 'No integration test imports Patrol yet.',
    recovery: context.sourcePath ? 'Add a `patrolTest(...)` file under integration_test/; generation can create it.' : 'Choose the project source folder in Settings.',
    action: 'manual', manual: true, resolution: context.sourcePath ? 'project' : 'not-found',
  });

  const recorderItem = item({
    id: 'recorder_sdk', group: 'flutter-android', label: 'SaySpec recorder integration', purpose: 'The app must depend on the recorder SDK to emit widget evidence.',
    state: !context.sourcePath ? 'waiting-for-user' : recorder ? 'installed' : 'missing',
    detected: recorder ? 'sayspec_flutter_recorder resolved' : undefined,
    requirement: 'sayspec_flutter_recorder dependency in pubspec.yaml',
    detail: !context.sourcePath
      ? 'Select the Flutter project folder to check recorder integration.'
      : recorder
        ? 'The project already resolves the SaySpec recorder SDK.'
        : 'The project does not depend on the SaySpec recorder SDK yet; recording cannot capture widget identity.',
    recovery: context.sourcePath ? 'Apply the recorder integration to pubspec.yaml and lib/main.dart. SaySpec previews the exact edit before applying it.' : 'Choose the project source folder in Settings.',
    action: 'manual', manual: true, resolution: recorder ? 'project' : 'not-found',
  });

  const xcodeItem = item({
    id: 'xcode', group: 'flutter-ios', label: 'Xcode', purpose: 'Required for iOS simulators and iOS builds.',
    state: platform !== 'darwin' ? 'unsupported' : hasXcode ? 'installed' : 'waiting-for-user',
    detected: developerDirectory, detectedPath: developerDirectory,
    requirement: `Xcode ${SUPPORTED.ios.minimumXcode} or newer`,
    detail: platform !== 'darwin'
      ? 'iOS builds are only supported on macOS.'
      : hasXcode ? `Developer directory ${developerDirectory}.` : 'Xcode.app is not installed or not selected.',
    recovery: hasXcode ? undefined : 'Install Xcode from the App Store, then run `sudo xcode-select -s /Applications/Xcode.app`.',
    action: hasXcode ? 'none' : 'manual', manual: true, resolution: developerDirectory ? 'common-path' : 'not-found',
    expectation: 'About 12 GB download, plus the simulator runtime.',
  });

  const cltItem = item({
    id: 'xcode_clt', group: 'flutter-ios', label: 'Command Line Tools', purpose: 'git and compilers that Flutter and CocoaPods shell out to.',
    state: platform !== 'darwin' ? 'unsupported' : developerDirectory ? 'installed' : 'waiting-for-user',
    detected: developerDirectory, requirement: 'xcode-select -p resolves a developer directory',
    detail: developerDirectory ? `Selected developer directory ${developerDirectory}.` : 'No developer directory is selected.',
    recovery: developerDirectory ? undefined : 'Run `xcode-select --install` and finish Apple’s installer.',
    action: developerDirectory ? 'none' : 'manual', manual: true, resolution: developerDirectory ? 'login-shell' : 'not-found',
  });

  const simulatorItem = item({
    id: 'ios_simulator', group: 'flutter-ios', label: 'iOS simulator runtime', purpose: 'Runs the recorded app on an iOS simulator.',
    state: platform !== 'darwin' ? 'unsupported' : !hasXcode ? 'waiting-for-user' : /iOS/.test(simulatorRuntimes) ? 'installed' : 'missing',
    detected: /iOS/.test(simulatorRuntimes) ? 'iOS runtime installed' : undefined, requirement: 'An installed iOS simulator runtime',
    detail: platform !== 'darwin' ? 'iOS simulators are only available on macOS.' : /iOS/.test(simulatorRuntimes) ? 'An iOS runtime is available.' : 'No iOS simulator runtime is installed.',
    recovery: 'In Xcode: Settings → Components → install an iOS runtime, or run `xcodebuild -downloadPlatform iOS`.',
    action: 'manual', manual: true, resolution: 'login-shell',
  });

  const cocoapodsItem = item({
    id: 'cocoapods', group: 'flutter-ios', label: 'CocoaPods', purpose: 'Resolves iOS dependency pods during the Flutter iOS build.',
    state: platform !== 'darwin' ? 'unsupported' : pod.found ? 'installed' : 'missing',
    detected: pod.version, detectedPath: pod.path, requirement: 'pod on PATH',
    detail: platform !== 'darwin' ? 'CocoaPods is only needed on macOS.' : pod.found ? `CocoaPods ${pod.version} at ${pod.path}.` : 'CocoaPods was not found.',
    recovery: pod.found ? undefined : 'SaySpec can install CocoaPods with Homebrew.',
    action: 'none', manual: false, resolution: pod.resolution,
  });
  cocoapodsItem.action = actionFor(cocoapodsItem.state, false);

  const iosPatrolItem = item({
    id: 'patrol_ios_target', group: 'flutter-ios', label: 'Patrol iOS test target', purpose: 'The RunnerUITests Xcode target Patrol runs iOS tests through.',
    state: platform !== 'darwin' ? 'unsupported' : !context.sourcePath ? 'waiting-for-user' : iosWiring?.ready ? 'installed' : 'missing',
    detected: iosWiring?.ready ? 'RunnerUITests configured' : undefined,
    requirement: 'A RunnerUITests target, runner source, scheme entry and pods target',
    detail: platform !== 'darwin' ? 'iOS simulators are only available on macOS.' : !context.sourcePath ? 'Select the Flutter project folder to check its iOS test target.' : iosWiring?.detail ?? 'Not checked.',
    recovery: context.sourcePath ? 'Apply the recorder integration: SaySpec previews the Xcode, scheme and Podfile changes before applying them.' : 'Choose the project source folder in Settings.',
    action: 'manual', manual: true, resolution: iosWiring?.ready ? 'project' : 'not-found',
  });

  const brewItem = item({
    id: 'homebrew', group: 'general', label: 'Homebrew', purpose: 'Installs the other host tools SaySpec manages.',
    state: brew.found ? 'installed' : 'missing', detected: brew.version, detectedPath: brew.path, requirement: 'Homebrew on PATH',
    detail: brew.found ? `Homebrew ${brew.version} at ${brew.path}.` : 'Homebrew was not found; guided installs that use it are unavailable.',
    recovery: brew.found ? undefined : 'Install Homebrew from brew.sh, then re-check.',
    action: 'none', manual: false, resolution: brew.resolution,
  });
  brewItem.action = actionFor(brewItem.state, false);

  const nodeCompatible = node.version ? compareVersions(node.version, SUPPORTED.node.min) >= 0 : undefined;
  const nodeItem = item({
    id: 'node', group: 'general', label: 'Node.js', purpose: 'Runs the local Playwright runner, the build tooling and the recording fixture server.',
    state: node.found ? (nodeCompatible === false ? 'incompatible' : 'installed') : 'missing',
    detected: node.version, detectedPath: node.path, requirement: SUPPORTED.node.label,
    detail: node.found ? `Node.js ${node.version} at ${node.path}.` : 'Node.js was not found.',
    recovery: node.found ? (nodeCompatible === false ? 'Upgrade Node.js to 22.12 or newer.' : undefined) : 'SaySpec can install Node.js with Homebrew.',
    action: 'none', manual: false, resolution: node.resolution,
  });
  nodeItem.action = actionFor(nodeItem.state, false);

  const codingAgentItem = item({
    id: 'coding_agent_cli', group: 'general', label: 'Coding agent CLI', purpose: 'Runs interactive generation and managed-test fix sessions with your selected AI.',
    state: claude.found || codex.found ? 'installed' : 'waiting-for-user',
    detected: [claude.found ? `Claude Code ${claude.version}` : '', codex.found ? `Codex ${codex.version}` : ''].filter(Boolean).join(' · ') || undefined,
    detectedPath: claude.path ?? codex.path,
    requirement: 'Claude Code or Codex CLI on PATH, signed in by you',
    detail: claude.found || codex.found
      ? `${[claude.found ? `Claude Code ${claude.version} at ${claude.path}` : '', codex.found ? `Codex ${codex.version} at ${codex.path}` : ''].filter(Boolean).join('; ')}. Sign-in state stays yours to manage.`
      : 'Neither Claude Code nor Codex was found. Choose and install one under Default AI.',
    recovery: claude.found || codex.found ? undefined : 'Choose Claude Code or Codex under Settings, install it, and sign in once.',
    action: claude.found || codex.found ? 'none' : 'manual', manual: true, resolution: claude.found ? claude.resolution : codex.resolution,
  });

  const whisperRuntime = await fileExists(path.join(os.homedir(), '.local', 'bin', 'whisper-cli'));
  const whisperItem = item({
    id: 'local_transcription', group: 'general', label: 'Local transcription runtime', purpose: 'Transcribes narration on this machine without uploading audio.',
    state: whisperRuntime ? 'installed' : 'waiting-for-user',
    detected: whisperRuntime ? 'whisper.cpp present' : undefined, requirement: 'whisper.cpp runtime, or a model installed from Settings',
    detail: whisperRuntime ? 'A local whisper.cpp runtime is present.' : 'No local whisper.cpp runtime was found in ~/.local/bin.',
    recovery: 'Manage the local model and runtime from the Narration section in Settings.',
    action: 'manual', manual: true, resolution: whisperRuntime ? 'common-path' : 'not-found',
  });

  const browserItem = item({
    id: 'playwright_browser', group: 'web', label: 'Playwright browser', purpose: 'Runs and validates saved Playwright tests and generation.',
    state: (await playwrightBrowsers()).length ? 'installed' : 'missing',
    detected: (await playwrightBrowsers()).join(', ') || undefined, requirement: 'Chromium in the Playwright browser cache',
    detail: (await playwrightBrowsers()).length ? 'A Playwright Chromium build is installed.' : 'No Playwright browser was found in the Playwright cache.',
    recovery: 'SaySpec can run `npx playwright install chromium`.',
    action: 'none', manual: false, expectation: 'About 150 MB download.',
  });
  browserItem.action = actionFor(browserItem.state, false);

  const groups: MachineSetupGroup[] = [
    buildGroup('general', 'General', 'Shared by every workflow — installed once even when several groups need it.', [
      inGroup(brewItem, 'general'), inGroup(nodeItem, 'general'), inGroup(codingAgentItem, 'general'), inGroup(whisperItem, 'general'),
    ]),
    buildGroup('web', 'Web · Playwright', 'Runs saved Playwright tests and Web recording.', [
      inGroup(browserItem, 'web'),
    ]),
    buildGroup('flutter-android', 'Flutter Android', 'Records and runs Patrol tests on an Android emulator or device.', [
      inGroup(jdkItem, 'flutter-android'), inGroup(androidSdkRootItem, 'flutter-android'), inGroup(cmdlineToolsItem, 'flutter-android'),
      inGroup(flutterItem, 'flutter-android'), inGroup(dartItem, 'flutter-android'), inGroup(patrolItem, 'flutter-android'),
      inGroup(platformItem, 'flutter-android'), inGroup(buildToolsItem, 'flutter-android'), inGroup(licenseItem, 'flutter-android'),
      inGroup(systemImageItem, 'flutter-android'), inGroup(emulatorItem, 'flutter-android'), inGroup(deviceItem, 'flutter-android'),
      inGroup(integrationItem, 'flutter-android'), inGroup(recorderItem, 'flutter-android'),
    ]),
    buildGroup('flutter-ios', 'Flutter iOS', 'Records and runs Patrol tests on an iOS simulator.', [
      inGroup(cltItem, 'flutter-ios'), inGroup(xcodeItem, 'flutter-ios'), inGroup(simulatorItem, 'flutter-ios'), inGroup(cocoapodsItem, 'flutter-ios'),
      inGroup(flutterItem, 'flutter-ios'), inGroup(patrolItem, 'flutter-ios'), inGroup(iosPatrolItem, 'flutter-ios'), inGroup(recorderItem, 'flutter-ios'),
    ]),
  ];

  return {
    checkedAt: now(),
    platform,
    groups,
    ...(context.project ? { project: context.project } : {}),
    stages: {
      machineTools: stageOf(groups.flatMap((entry) => entry.items)),
      projectBuild: projectRequirements ? stageOf([platformItem, buildToolsItem, jdkItem, flutterItem, patrolItem]) : 'unknown',
      device: androidRoot ? stageOf([deviceItem, emulatorItem]) : 'not-required',
      recordingIntegration: context.sourcePath ? stageOf([recorderItem, integrationItem]) : 'not-required',
    },
  };
}

async function playwrightBrowsers(): Promise<string[]> {
  const root = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright') : path.join(os.homedir(), '.cache', 'ms-playwright');
  const entries = await listDirectories(root);
  return entries.filter((entry) => entry.startsWith('chromium'));
}

/** A shared item is re-labelled into the group that displays it. */
function inGroup(source: MachineSetupItem, group: MachineSetupWorkflow): MachineSetupItem {
  return { ...source, group };
}

function stageOf(items: readonly MachineSetupItem[]): 'ready' | 'incomplete' | 'unknown' {
  const relevant = items.filter((entry) => entry.state !== 'unsupported');
  if (!relevant.length) return 'unknown';
  if (relevant.some((entry) => entry.state === 'failed' || entry.state === 'incompatible' || entry.state === 'missing')) return 'incomplete';
  if (relevant.some((entry) => entry.state === 'waiting-for-user' || entry.state === 'checking')) return 'unknown';
  return 'ready';
}

function buildGroup(workflow: MachineSetupWorkflow, title: string, summary: string, items: MachineSetupItem[]): MachineSetupGroup {
  const shared = items.filter((entry) => SHARED_ITEM_IDS.has(entry.id)).map((entry) => entry.id);
  const relevant = items.filter((entry) => entry.state !== 'unsupported');
  return {
    workflow, title, summary,
    sharedItemIds: [...new Set(shared)],
    items,
    ready: relevant.length > 0 && relevant.every((entry) => entry.state === 'installed' || entry.state === 'verified'),
    unknown: relevant.some((entry) => entry.state === 'waiting-for-user' || entry.state === 'checking' || entry.state === 'unsupported'),
  };
}
