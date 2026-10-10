import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FlutterIntegrationPreview } from '@sayspec/contracts';
import { runFile } from '../setup/environment.ts';
import { IOS_PATROL_FILES, previewPatrolIosConfig } from './ios-patrol.ts';
import { RECORDER_SDK_VERSION } from './recorder-sdk.ts';
import { resolveProjectFlutterToolchain } from './toolchain.ts';

const SDK_PACKAGE = 'sayspec_flutter_recorder';

/**
 * Builds the recorder integration as a reviewable patch.
 *
 * The selected application source is never rewritten silently: the user sees
 * each file, its proposed content and why it changes, then applies the files
 * they choose. Every applied file is checked against the base hash first so a
 * concurrent edit cannot be overwritten.
 */
export async function previewFlutterIntegration(input: { sourcePath: string; appId: string }): Promise<FlutterIntegrationPreview> {
  const files: FlutterIntegrationPreview['files'][number][] = [];
  const notes: string[] = [];
  const pubspecPath = path.join(input.sourcePath, 'pubspec.yaml');
  const pubspec = await readText(pubspecPath);
  if (!pubspec) throw new Error('pubspec.yaml was not found in the selected Flutter project.');
  const declared = recorderDeclaration(pubspec);
  if (!declared) {
    if (!/^dependencies:[ \t]*$/m.test(pubspec)) throw new Error('pubspec.yaml has no top-level dependencies block to extend.');
    files.push({
      relativePath: 'pubspec.yaml',
      baseSha256: sha(pubspec),
      description: `Adds ${SDK_PACKAGE} ${RECORDER_SDK_VERSION} from pub.dev so the app can emit widget evidence.`,
      proposedText: pubspec.replace(/^dependencies:[ \t]*$/m, (match) => `${match}\n${RECORDER_DEPENDENCY}`),
    });
  } else if (declared.trimEnd() !== RECORDER_DEPENDENCY) {
    // Earlier builds pointed at a copy inside SaySpec's app data, which only
    // resolves on the machine that applied it.
    files.push({
      relativePath: 'pubspec.yaml',
      baseSha256: sha(pubspec),
      description: `Pins ${SDK_PACKAGE} to ${RECORDER_SDK_VERSION} from pub.dev, replacing the current declaration, so it resolves on every machine and matches this SaySpec build.`,
      proposedText: pubspec.replace(declared, `${RECORDER_DEPENDENCY}\n`),
    });
  }

  const mainPath = path.join(input.sourcePath, 'lib', 'main.dart');
  const main = await readText(mainPath);
  if (!main) throw new Error('lib/main.dart was not found in the selected Flutter project.');
  const appId = input.appId || await readApplicationId(input.sourcePath);
  if (!main.includes(SDK_PACKAGE)) {
    const delegated = delegatedMain(main);
    files.push({
      relativePath: 'lib/main.dart',
      baseSha256: sha(main),
      description: delegated
        ? `Initializes the recorder right after ${delegated.call} returns, because that function owns the binding and runApp. Nothing records until you press Record in the SaySpec overlay of an app SaySpec launched.`
        : 'Initializes the recorder before runApp and registers a RepaintBoundary the SDK can screenshot. Nothing records until you press Record in the SaySpec overlay of an app SaySpec launched.',
      proposedText: delegated ? integrateDelegatedMain(main, delegated, appId) : integrateMain(main, appId),
    });
    if (delegated) notes.push(`lib/main.dart delegates to ${delegated.call}, so the recorder cannot wrap the app in a screenshot boundary. Taps, text and markers are recorded; screenshots are not.`);
  } else notes.push('lib/main.dart already initializes the SaySpec recorder.');

  // patrol_cli discovers `patrol_test/`; older projects keep `integration_test/`.
  const hasTestFolder = (await pathExists(path.join(input.sourcePath, 'patrol_test'))) || (await pathExists(path.join(input.sourcePath, 'integration_test')));
  if (!hasTestFolder) notes.push('No patrol_test/ folder exists yet; a run needs at least one `patrolTest(...)` file. Generation can create one from this recording.');

  // `patrol test` executes through the app's Android test instrumentation, and
  // `flutter create` never generates that wiring. Without it Patrol builds,
  // runs, and reports zero tests, which looks like a silent pass. SaySpec
  // previews the exact configuration changes instead.
  const patrolConfig = await previewPatrolAndroidConfig(input.sourcePath);
  files.push(...patrolConfig.files);
  notes.push(...patrolConfig.notes);
  // iOS runs through an XCUITest target that `flutter create` never adds either.
  const iosConfig = await previewPatrolIosConfig(input.sourcePath);
  files.push(...iosConfig.files);
  notes.push(...iosConfig.notes);

  notes.push('The recorder sends events only to the loopback host port SaySpec opens for this capture (forwarded to an Android device; an iOS simulator shares the host loopback); it never uploads narration or screenshots on its own.');
  return { sourcePath: input.sourcePath, files, requiresApplication: files.length > 0, notes };
}

/**
 * Builds the Patrol Android instrumentation wiring as reviewable file changes.
 *
 * Exported so the run path can check the same conditions it previews: a build
 * that produces no tests must be reported as blocked, never as a pass.
 */
export async function previewPatrolAndroidConfig(sourcePath: string): Promise<{ files: FlutterIntegrationPreview['files'][number][]; notes: string[] }> {
  const files: FlutterIntegrationPreview['files'][number][] = [];
  const notes: string[] = [];
  const applicationId = await readApplicationId(sourcePath);
  const gradlePath = await firstExisting([
    path.join(sourcePath, 'android', 'app', 'build.gradle.kts'),
    path.join(sourcePath, 'android', 'app', 'build.gradle'),
  ]);
  if (!gradlePath) {
    notes.push('No android/app/build.gradle(.kts) was found, so Patrol cannot be wired for Android. Create the Android platform first (`flutter create --platforms=android .`).');
    return { files, notes };
  }
  const gradle = (await readText(gradlePath)) ?? '';
  const relativeGradle = path.relative(sourcePath, gradlePath).split(path.sep).join('/');
  if (!gradle.includes('PatrolJUnitRunner')) {
    files.push({
      relativePath: relativeGradle,
      baseSha256: sha(gradle),
      description: 'Routes Android instrumentation through Patrol\'s JUnit runner and enables the test orchestrator. Without this, `patrol test` runs zero tests and reports success.',
      proposedText: patchGradleForPatrol(gradle, gradlePath.endsWith('.kts')),
    });
  }
  const testPath = path.join(sourcePath, androidTestRelativePath(applicationId));
  if (!(await pathExists(testPath))) {
    files.push({
      relativePath: androidTestRelativePath(applicationId),
      description: 'Adds the instrumented test entry point Patrol uses to enumerate and run the Dart tests.',
      proposedText: mainActivityTest(applicationId),
    });
  }
  if (!files.length) notes.push('The Android Patrol instrumentation configuration is already present.');
  return { files, notes };
}

async function firstExisting(candidates: string[]) {
  for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
  return undefined;
}

async function readApplicationId(sourcePath: string) {
  const gradle = await firstExisting([
    path.join(sourcePath, 'android', 'app', 'build.gradle.kts'),
    path.join(sourcePath, 'android', 'app', 'build.gradle'),
  ]);
  const text = gradle ? await readText(gradle) : undefined;
  const fromGradle = text ? /applicationId\s*=?\s*["']([^"']+)["']/.exec(text)?.[1] : undefined;
  if (fromGradle) return fromGradle;
  const manifest = await readText(path.join(sourcePath, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'));
  return manifest ? /package="([^"]+)"/.exec(manifest)?.[1] ?? 'dev.sayspec.app' : 'dev.sayspec.app';
}

/** Path of the instrumented test class, derived from the application id. */
export function androidTestRelativePath(applicationId: string) {
  return path.join('android', 'app', 'src', 'androidTest', 'java', ...applicationId.split('.'), 'MainActivityTest.java').split(path.sep).join('/');
}

function patchGradleForPatrol(gradle: string, kotlinDsl: boolean) {
  let next = gradle;
  const runnerLine = kotlinDsl
    ? '        testInstrumentationRunner = "pl.leancode.patrol.PatrolJUnitRunner"\n        testInstrumentationRunnerArguments["clearPackageData"] = "true"'
    : '        testInstrumentationRunner "pl.leancode.patrol.PatrolJUnitRunner"\n        testInstrumentationRunnerArguments clearPackageData: "true"';
  if (/testInstrumentationRunner/.test(next)) {
    next = next.replace(/^(\s*)testInstrumentationRunner.*$/m, `${runnerLine}`);
  } else {
    const defaultConfig = kotlinDsl ? /defaultConfig\s*\{/ : /defaultConfig\s*\{/;
    if (defaultConfig.test(next)) next = next.replace(defaultConfig, (match) => `${match}\n${runnerLine}`);
    else throw new Error('android/app/build.gradle has no defaultConfig block to extend.');
  }
  if (!/ANDROIDX_TEST_ORCHESTRATOR/.test(next)) {
    const block = kotlinDsl
      ? '    testOptions {\n        execution = "ANDROIDX_TEST_ORCHESTRATOR"\n    }\n'
      : '    testOptions {\n        execution "ANDROIDX_TEST_ORCHESTRATOR"\n    }\n';
    // `testOptions` belongs to the `android` extension, so it is inserted just
    // before the brace that closes `android {`, located from the top-level
    // `flutter {` block that always follows it in a Flutter project.
    const flutterAt = next.search(/\nflutter\s*\{/);
    if (flutterAt > 0) {
      const closeAt = next.lastIndexOf('\n}', flutterAt);
      if (closeAt > 0) next = `${next.slice(0, closeAt)}\n${block}${next.slice(closeAt + 1)}`;
      else next = next.replace(/\nflutter\s*\{/, `\n${block}\nflutter {`);
    } else next = `${next}\n${block}`;
  }
  if (!/androidTestUtil/.test(next)) {
    const dependency = kotlinDsl ? '    androidTestUtil("androidx.test:orchestrator:1.5.1")' : '    androidTestUtil "androidx.test:orchestrator:1.5.1"';
    const dependencies = /dependencies\s*\{/;
    if (dependencies.test(next)) next = next.replace(dependencies, (match) => `${match}\n${dependency}`);
    else next = `${next}\n\ndependencies {\n${dependency}\n}\n`;
  }
  return next;
}

function mainActivityTest(applicationId: string) {
  return `package ${applicationId};

import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.junit.runners.Parameterized.Parameters;
import pl.leancode.patrol.PatrolJUnitRunner;

// Generated by SaySpec for Patrol. Required so \`patrol test\` can enumerate and
// run the Dart tests; see https://patrol.leancode.co for the upstream contract.
@RunWith(Parameterized.class)
public class MainActivityTest {
    @Parameters(name = "{0}")
    public static Object[] testCases() {
        PatrolJUnitRunner instrumentation = (PatrolJUnitRunner) InstrumentationRegistry.getInstrumentation();
        instrumentation.setUp(MainActivity.class);
        instrumentation.waitForPatrolAppService();
        return instrumentation.listDartTests();
    }

    public MainActivityTest(String dartTestName) {
        this.dartTestName = dartTestName;
    }

    private final String dartTestName;

    @Test
    public void runDartTest() {
        PatrolJUnitRunner instrumentation = (PatrolJUnitRunner) InstrumentationRegistry.getInstrumentation();
        instrumentation.runDartTest(dartTestName);
    }
}
`;
}

/** Applies only the reviewed files, after re-checking each base hash. */
export async function applyFlutterIntegration(input: { sourcePath: string; preview: FlutterIntegrationPreview; relativePaths: string[] }) {
  const wanted = new Set(input.relativePaths);
  // The Xcode target, scheme entry, runner source and pods target reference
  // each other; applying some of them leaves an iOS build that cannot work.
  const iosFiles = input.preview.files.filter((file) => IOS_PATROL_FILES.includes(file.relativePath)).map((file) => file.relativePath);
  if (iosFiles.some((file) => wanted.has(file)) && !iosFiles.every((file) => wanted.has(file))) {
    throw new Error(`The iOS Patrol files only work together. Select all of them (${iosFiles.join(', ')}) or none.`);
  }
  const applied: string[] = [];
  for (const file of input.preview.files) {
    if (!wanted.has(file.relativePath)) continue;
    const absolute = path.join(input.sourcePath, file.relativePath);
    if (!isInside(input.sourcePath, absolute)) throw new Error(`Refusing to write outside the selected project: ${file.relativePath}`);
    const existing = await readText(absolute);
    if (file.baseSha256 && (!existing || sha(existing) !== file.baseSha256)) throw new Error(`${file.relativePath} changed after the preview was created. Preview the integration again.`);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.proposedText);
    applied.push(file.relativePath);
  }
  const refreshed = await previewFlutterIntegration({ sourcePath: input.sourcePath, appId: '' });
  return { applied, preview: refreshed };
}

/**
 * Runs the project's pinned `flutter pub get` so a just-added recorder
 * dependency resolves; recording refuses to start until it does.
 */
export async function resolveProjectDependencies(sourcePath: string) {
  const flutter = await resolveProjectFlutterToolchain(sourcePath);
  const result = await runFile(flutter.flutterPath, ['pub', 'get'], { cwd: sourcePath, env: flutter.environment, timeoutMs: 300_000 });
  if (result.code !== 0) throw new Error(`flutter pub get failed in the selected project: ${(result.stderr || result.stdout).trim().split('\n').slice(-6).join('\n')}`);
}

const RECORDER_DEPENDENCY = `  ${SDK_PACKAGE}: ${RECORDER_SDK_VERSION}`;

/** The recorder's entry in pubspec.yaml, with any indented `path:`/`version:` lines under it. */
function recorderDeclaration(pubspec: string) {
  return new RegExp(`^  ${SDK_PACKAGE}\\s*:[^\\n]*\\n(?:(?: {4,}|\\t)[^\\n]*\\n)*`, 'm').exec(pubspec.endsWith('\n') ? pubspec : `${pubspec}\n`)?.[0];
}

/**
 * A harness entrypoint such as `Future<void> main() => app.main();` hands the
 * binding and runApp to another package's main. Initializing first would claim
 * the binding before a custom one (Marionette, integration_test) can, so the
 * recorder attaches once the delegate returns instead.
 */
function delegatedMain(main: string) {
  if (/runApp\(/.test(main)) return undefined;
  const match = /^(Future<void>|void)\s+main\(\)\s*(?:async\s*)?=>\s*([^;]+);[^\n]*$/m.exec(main);
  return match ? { statement: match[0], awaitable: match[1] === 'Future<void>', call: match[2]!.trim().replace(/^await\s+/, '') } : undefined;
}

function integrateDelegatedMain(main: string, delegated: { statement: string; awaitable: boolean; call: string }, appId: string) {
  const importLine = "import 'package:sayspec_flutter_recorder/sayspec_flutter_recorder.dart';\n";
  const next = /^import /m.test(main) ? main.replace(/^(import [^\n]*\n)/m, `$1${importLine}`) : `${importLine}\n${main}`;
  return next.replace(delegated.statement, [
    'Future<void> main() async {',
    `  ${delegated.awaitable ? 'await ' : ''}${delegated.call};`,
    `  await SaySpecRecorder.instance.initializeFromEnvironment(appId: ${JSON.stringify(appId)});`,
    '}',
  ].join('\n'));
}

/** Minimal, explicit integration: initialize from host-owned launch values. */
function integrateMain(main: string, appId: string) {
  const hasRunApp = /runApp\(/.test(main);
  if (!hasRunApp) throw new Error('lib/main.dart does not call runApp, so the recorder cannot be installed automatically. Apply this integration by hand.');
  let next = main;
  if (!next.includes("import 'package:sayspec_flutter_recorder/sayspec_flutter_recorder.dart';")) {
    next = next.replace(/^(import [^\n]*\n)/, `$1import 'package:sayspec_flutter_recorder/sayspec_flutter_recorder.dart';\n`);
  }
  if (!next.includes('initializeFromEnvironment(')) {
    next = next.replace(/^void main\(\)\s*\{/m, 'Future<void> main() async {');
    const binding = next.includes('WidgetsFlutterBinding.ensureInitialized()') ? '' : '\n  WidgetsFlutterBinding.ensureInitialized();';
    const initialization = `${binding}\n  await SaySpecRecorder.instance.initializeFromEnvironment(\n    appId: ${JSON.stringify(appId)},\n    screenshotBoundaryKey: saySpecRecordingSurfaceKey,\n  );`;
    const initialized = next.replace(/^Future<void> main\(\) async \{/m, `Future<void> main() async {${initialization}`);
    if (initialized === next) throw new Error('lib/main.dart has an unsupported main signature. Initialize the SaySpec recorder manually before runApp.');
    next = initialized;
  }
  if (!next.includes('saySpecRecordingSurfaceKey =')) {
    next = `${next}\n\n/// Recording surface the SaySpec recorder screenshots.\nfinal GlobalKey saySpecRecordingSurfaceKey = GlobalKey();\n`;
  }
  return next;
}

async function readText(candidate: string) {
  try { return await readFile(candidate, 'utf8'); } catch { return undefined; }
}

async function pathExists(candidate: string) {
  try { await stat(candidate); return true; } catch { return false; }
}

function sha(value: string) { return createHash('sha256').update(value).digest('hex'); }

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
