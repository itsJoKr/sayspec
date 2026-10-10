import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolves tools the way the actual build will, which is not the way a
 * GUI-launched Electron app inherits `process.env`.
 *
 * A macOS app started from Finder or a packaged bundle gets a minimal PATH, so
 * `flutter`, `patrol`, `adb` and `brew` appear missing even when they are
 * installed. Every check therefore runs its probe through a login shell and
 * falls back to well-known install locations, recording which one answered.
 */
export interface ResolvedTool {
  name: string;
  found: boolean;
  command?: string;
  path?: string;
  version?: string;
  resolution: 'login-shell' | 'common-path' | 'environment' | 'not-found';
  probeDetail?: string;
}

const LOGIN_SHELL_TIMEOUT_MS = 20_000;

/** Runs a probe in a login shell so user profile PATH entries apply. */
export async function loginShell(command: string, options: { timeoutMs?: number; cwd?: string } = {}) {
  const shell = process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/zsh';
  return runFile(shell, ['-lc', command], { timeoutMs: options.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS, cwd: options.cwd });
}

export async function runFile(command: string, args: string[], options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(command, args, {
      timeout: options.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS,
      cwd: options.cwd,
      maxBuffer: 4 * 1024 * 1024,
      env: options.env ?? process.env,
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** Directories searched in addition to whatever the login shell already has. */
export function commonToolDirectories(): string[] {
  const home = os.homedir();
  const directories = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    path.join(home, '.local/bin'), path.join(home, '.pub-cache/bin'),
    path.join(home, 'fvm', 'default', 'bin'),
    path.join(home, 'Library', 'Android', 'sdk', 'platform-tools'),
    path.join(home, 'Library', 'Android', 'sdk', 'emulator'),
    path.join(home, 'Library', 'Android', 'sdk', 'cmdline-tools', 'latest', 'bin'),
    path.join(home, 'Android', 'Sdk', 'platform-tools'),
  ];
  if (process.env.ANDROID_HOME) directories.push(path.join(process.env.ANDROID_HOME, 'platform-tools'), path.join(process.env.ANDROID_HOME, 'cmdline-tools', 'latest', 'bin'));
  if (process.env.ANDROID_SDK_ROOT) directories.push(path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools'), path.join(process.env.ANDROID_SDK_ROOT, 'cmdline-tools', 'latest', 'bin'));
  return directories;
}

async function executableAt(candidate: string) {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch { return false; }
}

/**
 * Finds one executable and its reported version.
 *
 * `--version` output is captured verbatim and trimmed to its first useful line;
 * a tool that exists but cannot report a version is still `found` with an
 * undefined `version`, which callers surface as unknown rather than ready.
 */
export async function resolveTool(input: {
  name: string;
  versionArgs?: string[];
  versionPattern?: RegExp;
  loginShellCommand?: string;
  extraPaths?: string[];
  timeoutMs?: number;
  /** Skip the version probe when only the path matters; some tools start slowly. */
  skipVersion?: boolean;
}): Promise<ResolvedTool> {
  const versionArgs = input.versionArgs ?? ['--version'];
  const readVersion: typeof readToolVersion = async (...args) => input.skipVersion ? undefined : readToolVersion(...args);
  const loginCommand = input.loginShellCommand ?? `command -v ${input.name}`;

  const fromEnvironment = await findOnPath(input.name, (process.env.PATH ?? '').split(path.delimiter));
  if (fromEnvironment) {
    const version = await readVersion(fromEnvironment, versionArgs, input.versionPattern, input.timeoutMs);
    return { name: input.name, found: true, command: input.name, path: fromEnvironment, version, resolution: 'environment' };
  }

  const shellResult = await loginShellCommandProbe(loginCommand, input.timeoutMs);
  if (shellResult) {
    const version = await readVersion(shellResult, versionArgs, input.versionPattern, input.timeoutMs);
    return { name: input.name, found: true, command: input.name, path: shellResult, version, resolution: 'login-shell' };
  }

  const searchDirectories = [...(input.extraPaths ?? []), ...commonToolDirectories()];
  for (const directory of searchDirectories) {
    const candidate = path.join(directory, input.name);
    if (!(await executableAt(candidate))) continue;
    const version = await readVersion(candidate, versionArgs, input.versionPattern, input.timeoutMs);
    return { name: input.name, found: true, command: candidate, path: candidate, version, resolution: 'common-path' };
  }

  return { name: input.name, found: false, resolution: 'not-found', probeDetail: shellResult === undefined ? 'Not on PATH and not in a known install location.' : undefined };
}

async function loginShellCommandProbe(command: string, timeoutMs?: number) {
  const result = await loginShell(command, { timeoutMs });
  const line = result.code === 0 ? result.stdout.split('\n').map((item) => item.trim()).find((item) => item.length > 0) : undefined;
  return line && !line.startsWith('command not found') ? line : undefined;
}

async function findOnPath(name: string, directories: string[]) {
  for (const directory of directories.filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (await executableAt(candidate)) return candidate;
  }
  return undefined;
}

async function readToolVersion(executable: string, args: string[], pattern: RegExp | undefined, timeoutMs: number | undefined) {
  const result = await runFile(executable, args, { timeoutMs: timeoutMs ?? 15_000 });
  const text = `${result.stdout}\n${result.stderr}`;
  if (pattern) return pattern.exec(text)?.[1] ?? pattern.exec(text)?.[0];
  const line = text.split('\n').map((item) => item.trim()).find((item) => item.length > 0);
  return line ? line.slice(0, 200) : undefined;
}

/** Reads a `key: value` line out of indented command output. */
export function parseIndentedField(text: string, label: string): string | undefined {
  const match = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'm').exec(text);
  return match?.[1]?.trim();
}

export async function fileExists(candidate: string) {
  try { await access(candidate); return true; } catch { return false; }
}

export async function readTextIfPresent(candidate: string) {
  try { return await readFile(candidate, 'utf8'); } catch { return undefined; }
}

export async function listDirectories(root: string) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch { return [] as string[]; }
}

/** Compares dotted versions, ignoring any non-numeric suffix. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(/[.+-]/).map((part) => Number.parseInt(part, 10)).map((part) => (Number.isFinite(part) ? part : 0));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/** Extracts the first `^\d+(\.\d+)*` token from free text. */
export function firstVersion(text: string | undefined): string | undefined {
  return text?.match(/\d+(?:\.\d+){1,3}/)?.[0];
}
