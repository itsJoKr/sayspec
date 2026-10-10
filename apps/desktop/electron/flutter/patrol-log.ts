import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Name Patrol gives a test file inside its generated test bundle: the path
 * under patrol_test/ without `.dart`, with directories joined by dots. Every
 * test title (`🧪 <group> <test>` in the log, `runDartTest[<group> <test>]` in
 * JUnit) starts with it, which is how one combined run is split per file.
 */
export function patrolBundleName(relativePath: string) {
  return relativePath.replace(/^patrol_test\//, '').replace(/\.dart$/, '').replaceAll('/', '.');
}

/** Maps a Patrol test title (`<bundle name> <test>`) to the saved file it ran from. */
export function ownerOf(relativePaths: readonly string[]) {
  // The longest bundle name wins, so `a_test` never claims `a_test_two`'s tests.
  const owners = relativePaths.map((relativePath) => ({ relativePath, prefix: `${patrolBundleName(relativePath)} ` })).sort((left, right) => right.prefix.length - left.prefix.length);
  return (title: string) => owners.find((candidate) => title.startsWith(candidate.prefix))?.relativePath;
}

/** Removes terminal colour and cursor sequences so a log reads as plain text. */
export function stripAnsi(value: string) {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n');
}

/**
 * Plain-text log with Patrol's transient progress lines collapsed.
 *
 * In a terminal, `⏳ 2. tap …` is overwritten in place by `✅ 2. tap …`; as
 * text both lines remain, so the pending line is dropped when its outcome
 * follows directly.
 */
export function readableLog(raw: string) {
  const lines = stripAnsi(raw).split('\n');
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const pending = /^(\s*)⏳(.*)$/.exec(line);
    const next = lines[index + 1];
    if (pending && next !== undefined && (next === `${pending[1]}✅${pending[2]}` || next === `${pending[1]}❌${pending[2]}`)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Splits a combined Patrol log into one segment per saved test file.
 *
 * A test's segment starts at its `🧪` line and runs to the next test's start or
 * the end of device execution, so it holds the steps, Flutter logs and the
 * failure Patrol printed for that test. Files with several tests get all of
 * their segments. A file that never started has no entry.
 */
export function splitPatrolLog(readable: string, relativePaths: readonly string[]) {
  const lines = readable.split('\n');
  const owner = ownerOf(relativePaths);
  const segments = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines) {
    const start = /^\s*🧪\s+(.*)$/.exec(line);
    if (start) {
      const file = owner(start[1]!);
      current = file ? (segments.get(file) ?? segments.set(file, []).get(file)!) : undefined;
      if (current && current.length) current.push('');
    } else if (/^\s*(?::\s*)?Finished \d+ tests? on /.test(line) || /^Test summary:/.test(line.trim())) {
      current = undefined;
    }
    current?.push(line);
  }
  return new Map([...segments].map(([relativePath, segment]) => [relativePath, segment.join('\n').trimEnd()]));
}

/** Files of the device run that explain what happened on the device, for analysis. */
export async function deviceReportFiles(sourcePath: string) {
  const root = path.join(sourcePath, 'build', 'app', 'outputs', 'androidTest-results');
  const found: { absolute: string; relativePath: string }[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name.endsWith('.xml') || entry.name === 'test-results.log' || /^logcat.*\.txt$/.test(entry.name)) {
        found.push({ absolute, relativePath: `device/${path.relative(root, absolute).replace(/[^A-Za-z0-9_./-]+/g, '_')}` });
      }
    }
  };
  await walk(root);
  return found;
}

/**
 * The instrumentation's own failure, when the device ran no test at all.
 *
 * Android Test Orchestrator reports setup crashes (for example a permission
 * the device refused to grant) only in testlog/test-results.log, while Gradle
 * and Patrol both print a successful build with zero tests.
 */
export async function instrumentationFailure(sourcePath: string) {
  for (const file of await deviceReportFiles(sourcePath)) {
    if (!file.absolute.endsWith('test-results.log')) continue;
    const text = await readFile(file.absolute, 'utf8').catch(() => '');
    const start = text.search(/INSTRUMENTATION_RESULT: (stream|shortMsg)=|INSTRUMENTATION_FAILED|Process crashed/);
    if (start < 0) continue;
    return text.slice(start).split('\n').slice(0, 6).join('\n').replace(/^INSTRUMENTATION_RESULT: stream=/, '').trim();
  }
  return undefined;
}
