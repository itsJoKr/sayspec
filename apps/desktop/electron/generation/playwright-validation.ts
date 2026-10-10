import { execFileSync, spawn } from 'node:child_process';
import { access, chmod, copyFile, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isSafeRelativePath, type PlaywrightDraftFile } from '@sayspec/contracts';
import { createHash } from 'node:crypto';
import { installedChromiumExecutable } from '../web-capture-adapter.ts';

const require = createRequire(path.join(typeof __dirname === 'string' ? __dirname : process.cwd(), 'package.json'));
const OUTPUT_LIMIT = 128 * 1024;
const redact = (value: string) => value
  .replace(/((?:password|secret|api[_-]?key|authorization|token)\s*[:=]\s*)[^\s,;]+/gi, '$1<redacted>')
  .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://<redacted>@');

export type PlaywrightValidationResult = {
  status: 'passed' | 'failed' | 'skipped' | 'blocked' | 'canceled' | 'infrastructure-error';
  passed: number;
  failed: number;
  skipped?: number;
  summary: string;
  detail: string;
  tests?: readonly { id: string; title: string; outcome: 'passed' | 'failed' | 'skipped' | 'not-run'; durationMs: number; errors: readonly string[] }[];
  artifacts?: readonly { relativePath: string; sha256: string; byteLength: number; mimeType: string }[];
  exitCode?: number | null;
  durationMs?: number;
};

export function sandboxProfile(staging: string, dependencyRoot: string) {
  // Rules later in a macOS sandbox profile are more specific. A generated
  // spec cannot read home files or write outside its disposable run directory.
  const quote = (value: string) => JSON.stringify(value);
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home) || !path.isAbsolute(staging) || !path.isAbsolute(dependencyRoot)) throw new Error('The isolated test runner could not resolve its filesystem roots.');
  return `(version 1)
(allow default)
(deny file-read* (subpath ${quote(home)}))
(allow file-read-metadata (subpath ${quote(home)}))
(allow file-read* (subpath ${quote(dependencyRoot)}) (subpath ${quote(staging)}))
(deny file-write*)
(allow file-write* (subpath ${quote(staging)}) (subpath "/private/var/folders"))`;
}

function reportTests(value: unknown) {
  const result: Array<{ id: string; title: string; outcome: 'passed' | 'failed' | 'skipped' | 'not-run'; durationMs: number; errors: string[] }> = [];
  const visit = (suite: unknown, names: string[]) => {
    if (!suite || typeof suite !== 'object') return;
    const node = suite as Record<string, unknown>;
    const title = typeof node.title === 'string' && node.title ? [...names, node.title] : names;
    for (const item of Array.isArray(node.specs) ? node.specs : []) {
      if (!item || typeof item !== 'object') continue;
      const spec = item as Record<string, unknown>;
      for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
        if (!test || typeof test !== 'object') continue;
        const entry = test as Record<string, unknown>;
        const attempts = Array.isArray(entry.results) ? entry.results as Record<string, unknown>[] : [];
        const status = String(entry.status ?? '');
        const outcome = status === 'expected' ? 'passed' : status === 'skipped' ? 'skipped' : status === 'unexpected' || status === 'flaky' ? 'failed' : 'not-run';
        result.push({ id: String(spec.id ?? `${result.length + 1}`), title: [...title, String(spec.title ?? '')].filter(Boolean).join(' › '), outcome,
          durationMs: attempts.reduce((sum, attempt) => sum + (Number.isFinite(attempt.duration) ? Number(attempt.duration) : 0), 0),
          errors: attempts.flatMap((attempt) => Array.isArray(attempt.errors) ? attempt.errors.map((error) => redact(String((error as { message?: unknown }).message ?? error).slice(0, 4_000))) : []),
        });
      }
    }
    for (const child of Array.isArray(node.suites) ? node.suites : []) visit(child, title);
  };
  if (value && typeof value === 'object') for (const suite of Array.isArray((value as { suites?: unknown }).suites) ? (value as { suites: unknown[] }).suites : []) visit(suite, []);
  return result;
}

export async function systemNodeExecutable() {
  const candidates = [process.env.SAYSPEC_NODE_CLI, ...String(process.env.PATH ?? '').split(path.delimiter).map((directory) => path.join(directory, 'node')), '/opt/homebrew/bin/node', '/usr/local/bin/node'].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      const version = String(execFileSync(candidate, ['--version'], { timeout: 3_000 })).trim().match(/^v(\d+)\.(\d+)/);
      if (version && (Number(version[1]) > 22 || Number(version[1]) === 22 && Number(version[2]) >= 12)) return candidate;
    } catch { /* another candidate may be installed */ }
  }
  throw new Error('Local Playwright validation needs an installed Node.js >=22.12.0.');
}

export async function validatePlaywrightCandidate(input: {
  files: readonly PlaywrightDraftFile[];
  entrypoint: string;
  baseUrl: string;
  /** Run with a visible Chromium window instead of Playwright's default headless mode. */
  headed?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  artifactDirectory?: string;
}): Promise<PlaywrightValidationResult> {
  if (process.platform !== 'darwin') return { status: 'blocked', passed: 0, failed: 0, summary: 'Local test execution is not qualified on this operating system.', detail: '' };
  const resolvedCli = require.resolve('@playwright/test/cli');
  const unpackedCli = resolvedCli.replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked');
  const cli = unpackedCli === resolvedCli ? resolvedCli : await access(unpackedCli).then(() => unpackedCli).catch(() => { throw new Error('The packaged Playwright runtime was not unpacked. Reinstall SaySpec.'); });
  const browserExecutable = await installedChromiumExecutable();
  const executable = await systemNodeExecutable();
  const dependencyRoot = path.resolve(path.dirname(cli), '..', '..');
  const staging = await mkdtemp('/private/tmp/sayspec-playwright-');
  const started = Date.now();
  try {
    if (input.signal?.aborted) return { status: 'canceled', passed: 0, failed: 0, summary: 'Playwright run canceled.', detail: '' };
    for (const file of input.files) {
      if (!isSafeRelativePath(file.relativePath) || ['node_modules', 'playwright.config.cjs', 'result.json', 'test-results'].includes(file.relativePath.split('/')[0])) throw new Error('Generated test path is reserved or unsafe.');
      if (Buffer.byteLength(file.text) !== file.byteLength || createHash('sha256').update(file.text).digest('hex') !== file.sha256) throw new Error('Generated test file failed integrity verification.');
      const destination = path.resolve(staging, file.relativePath);
      if (!destination.startsWith(`${staging}${path.sep}`)) throw new Error('Generated test path escaped its run directory.');
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.text, { mode: 0o600 });
    }
    if (!isSafeRelativePath(input.entrypoint) || !input.files.some((file) => file.relativePath === input.entrypoint)) throw new Error('Playwright entrypoint is unsafe or missing.');
    await symlink(dependencyRoot, path.join(staging, 'node_modules'), 'dir');
    const config = `module.exports = { testDir: '.', testMatch: ${JSON.stringify(path.basename(input.entrypoint))}, timeout: 30000, retries: 0, workers: 1, reporter: [['json', { outputFile: 'result.json' }]], outputDir: 'test-results', use: { baseURL: ${JSON.stringify(input.baseUrl)}, browserName: 'chromium', launchOptions: { executablePath: ${JSON.stringify(browserExecutable)} }, trace: 'retain-on-failure', screenshot: 'only-on-failure' } };\n`;
    await writeFile(path.join(staging, 'playwright.config.cjs'), config, { mode: 0o600 });
    const profile = sandboxProfile(staging, dependencyRoot);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: staging, TMPDIR: staging,
      ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'test', CI: '1',
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    };
    const result = await new Promise<{ code: number | null; output: string; canceled: boolean; timedOut: boolean }>((resolve) => {
      const args = ['-p', profile, executable, cli, 'test', input.entrypoint, '--config', path.join(staging, 'playwright.config.cjs'), ...(input.headed ? ['--headed', '--workers=1'] : [])];
      const child = spawn('/usr/bin/sandbox-exec', args, {
        cwd: staging, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = ''; let timedOut = false; let canceled = false; let killTimer: NodeJS.Timeout | undefined;
      const collect = (chunk: Buffer) => { output = `${output}${String(chunk)}`.slice(-OUTPUT_LIMIT); };
      child.stdout?.on('data', collect); child.stderr?.on('data', collect);
      const stop = () => {
        canceled = true;
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
          killTimer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, 1_500);
          killTimer.unref();
        }
      };
      input.signal?.addEventListener('abort', stop, { once: true });
      const timeout = setTimeout(() => { timedOut = true; stop(); }, input.timeoutMs ?? 90_000);
      child.once('error', (error) => { clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); input.signal?.removeEventListener('abort', stop); resolve({ code: null, output: `${output}\n${error.message}`, canceled, timedOut }); });
      child.once('close', (code) => { clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); input.signal?.removeEventListener('abort', stop); resolve({ code, output, canceled, timedOut }); });
    });
    const artifacts: Array<{ relativePath: string; sha256: string; byteLength: number; mimeType: string }> = [];
    if (input.artifactDirectory) {
      await mkdir(input.artifactDirectory, { recursive: true });
      const persist = async (source: string, relativePath: string) => {
        const metadata = await lstat(source).catch(() => null);
        if (!metadata?.isFile() || metadata.size > 32 * 1024 * 1024 || artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0) + metadata.size > 128 * 1024 * 1024) return;
        const destination = path.join(input.artifactDirectory!, relativePath);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await copyFile(source, destination); await chmod(destination, 0o600);
        artifacts.push({ relativePath, sha256: createHash('sha256').update(await readFile(destination)).digest('hex'), byteLength: metadata.size,
          mimeType: relativePath.endsWith('.png') ? 'image/png' : relativePath.endsWith('.zip') ? 'application/zip' : relativePath.endsWith('.json') ? 'application/json' : 'text/plain' });
      };
      await writeFile(path.join(staging, 'runner.log'), redact(result.output), { mode: 0o600 });
      await persist(path.join(staging, 'runner.log'), 'runner.log');
      await persist(path.join(staging, 'result.json'), 'result.json');
      for (const entry of await readdir(path.join(staging, 'test-results'), { recursive: true }).catch(() => [] as string[])) {
        if (isSafeRelativePath(entry)) await persist(path.join(staging, 'test-results', entry), `test-results/${entry}`);
      }
    }
    const common = { artifacts, exitCode: result.code, durationMs: Date.now() - started };
    if (result.canceled) return { ...common, status: input.signal?.aborted ? 'canceled' : 'infrastructure-error', passed: 0, failed: 0, summary: result.timedOut ? 'Playwright run timed out.' : 'Playwright run canceled.', detail: redact(result.output.slice(-8_000)) };
    let report: unknown;
    try { report = JSON.parse(await readFile(path.join(staging, 'result.json'), 'utf8')); }
    catch { return { ...common, status: 'infrastructure-error', passed: 0, failed: 0, summary: 'Playwright did not produce a test report.', detail: redact(result.output.slice(-8_000)) }; }
    const tests = reportTests(report);
    const passed = tests.filter((item) => item.outcome === 'passed').length;
    const failed = tests.filter((item) => item.outcome === 'failed').length;
    const skipped = tests.filter((item) => item.outcome === 'skipped').length;
    if (result.code === 0 && passed > 0 && failed === 0 && skipped === 0) return { ...common, tests, status: 'passed', passed, failed, skipped, summary: `${passed} Playwright test${passed === 1 ? '' : 's'} passed.`, detail: '' };
    const resultsDirectory = path.join(staging, 'test-results');
    const entries = await readdir(resultsDirectory, { recursive: true }).catch(() => [] as string[]);
    const context = entries.find((entry) => entry.endsWith('error-context.md'));
    const pageSnapshot = context ? await readFile(path.join(resultsDirectory, context), 'utf8').catch(() => '') : '';
    const status = failed > 0 ? 'failed' : skipped > 0 && result.code === 0 ? 'skipped' : 'infrastructure-error';
    return { ...common, tests, status, passed, failed, skipped,
      summary: failed > 0 ? `${failed} Playwright test${failed === 1 ? '' : 's'} failed.` : status === 'skipped' ? `${skipped} Playwright test${skipped === 1 ? '' : 's'} skipped; run is not fully green.` : 'Playwright did not report a valid passing run.',
      detail: redact(`${result.output.slice(-8_000)}\n\nLive page snapshot:\n${pageSnapshot.slice(0, 8_000)}`) };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
