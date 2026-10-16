import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveTool, runFile } from '../setup/environment.ts';

export interface ProjectFlutterToolchain {
  flutterPath: string;
  dartPath: string;
  flutterVersion: string;
  dartVersion?: string;
  pinnedVersion?: string;
  resolution: 'project-fvm' | 'fvm-version' | 'login-shell';
  environment: NodeJS.ProcessEnv;
}

async function executable(candidate: string) {
  try { await access(candidate, constants.X_OK); return true; } catch { return false; }
}

/**
 * FVM reads its config from the nearest ancestor that has one, so a nested
 * harness (an add-to-app module's `e2e/` app) inherits the module's pin.
 */
async function fvmProjectRoot(sourcePath: string) {
  for (let directory = path.resolve(sourcePath); ; directory = path.dirname(directory)) {
    for (const marker of ['.fvmrc', path.join('.fvm', 'fvm_config.json')]) {
      if (await access(path.join(directory, marker)).then(() => true, () => false)) return directory;
    }
    if (path.dirname(directory) === directory) return undefined;
  }
}

async function projectPin(sourcePath: string) {
  const root = await fvmProjectRoot(sourcePath);
  if (!root) return undefined;
  const fvmrc = await readFile(path.join(root, '.fvmrc'), 'utf8').catch(() => undefined);
  const modern = fvmrc ? /"flutter"\s*:\s*"([^"]+)"/.exec(fvmrc)?.[1] : undefined;
  if (modern) return modern;
  const legacy = await readFile(path.join(root, '.fvm', 'fvm_config.json'), 'utf8').catch(() => undefined);
  return legacy ? /"flutter"\s*:\s*"([^"]+)"/.exec(legacy)?.[1] : undefined;
}

function versionFromFlutter(output: string) {
  return /Flutter\s+(\d+\.\d+\.\d+(?:-[^\s]+)?)/.exec(output)?.[1];
}

function versionFromDart(output: string) {
  return /Dart SDK version:\s+(\d+\.\d+\.\d+(?:-[^\s]+)?)/.exec(output)?.[1];
}

/**
 * Resolves the selected project's Flutter SDK, never merely the first Flutter
 * on PATH. FVM's project symlink wins, followed by the exact pinned version in
 * common FVM stores. PATH is allowed only when it satisfies the project pin.
 */
export async function resolveProjectFlutterToolchain(sourcePath: string): Promise<ProjectFlutterToolchain> {
  const pinnedVersion = await projectPin(sourcePath);
  const candidates: Array<{ flutterPath: string; resolution: ProjectFlutterToolchain['resolution'] }> = [];
  const projectFvm = path.join((await fvmProjectRoot(sourcePath)) ?? sourcePath, '.fvm', 'flutter_sdk', 'bin', 'flutter');
  if (await executable(projectFvm)) candidates.push({ flutterPath: projectFvm, resolution: 'project-fvm' });
  if (pinnedVersion) {
    const roots = [
      process.env.FVM_HOME ? path.join(process.env.FVM_HOME, 'versions') : undefined,
      path.join(homedir(), 'fvm', 'versions'),
      path.join(homedir(), '.fvm', 'versions'),
    ].filter((value): value is string => Boolean(value));
    for (const root of roots) {
      const candidate = path.join(root, pinnedVersion, 'bin', 'flutter');
      if (await executable(candidate) && !candidates.some((item) => item.flutterPath === candidate)) {
        candidates.push({ flutterPath: candidate, resolution: 'fvm-version' });
      }
    }
  }
  const shell = await resolveTool({ name: 'flutter', versionArgs: ['--version'], versionPattern: /Flutter\s+(\d+\.\d+\.\d+)/ });
  if (shell.found && shell.path && !candidates.some((item) => item.flutterPath === shell.path)) {
    candidates.push({ flutterPath: shell.path, resolution: 'login-shell' });
  }

  const observed: string[] = [];
  for (const candidate of candidates) {
    const result = await runFile(candidate.flutterPath, ['--version'], { timeoutMs: 30_000 });
    const flutterVersion = versionFromFlutter(`${result.stdout}\n${result.stderr}`);
    if (result.code !== 0 || !flutterVersion) continue;
    observed.push(`${flutterVersion} at ${candidate.flutterPath}`);
    if (pinnedVersion && flutterVersion !== pinnedVersion) continue;
    const dartPath = path.join(path.dirname(candidate.flutterPath), 'dart');
    if (!(await executable(dartPath))) throw new Error(`Flutter ${flutterVersion} was found at ${candidate.flutterPath}, but its Dart executable is missing.`);
    const dart = await runFile(dartPath, ['--version'], { timeoutMs: 30_000 });
    const dartVersion = versionFromDart(`${dart.stdout}\n${dart.stderr}`);
    const bin = path.dirname(candidate.flutterPath);
    const environment = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, PATROL_FLUTTER_COMMAND: candidate.flutterPath };
    return { flutterPath: candidate.flutterPath, dartPath, flutterVersion, ...(dartVersion ? { dartVersion } : {}), ...(pinnedVersion ? { pinnedVersion } : {}), resolution: candidate.resolution, environment };
  }

  if (pinnedVersion) {
    throw new Error(`The selected project pins Flutter ${pinnedVersion}, but that SDK could not be resolved. ${observed.length ? `Found ${observed.join(', ')} instead.` : 'No usable Flutter SDK was found.'} Install the pinned version with FVM, then re-check Machine setup.`);
  }
  throw new Error('No usable Flutter SDK was found for the selected project. Run Settings → Machine setup.');
}

export async function readProjectFlutterPin(sourcePath: string) { return projectPin(sourcePath); }

/** The app's own version from pubspec.yaml (for example 2.4.0+57), or undefined when it declares none. */
export async function readPubspecVersion(sourcePath: string) {
  const pubspec = await readFile(path.join(sourcePath, 'pubspec.yaml'), 'utf8').catch(() => '');
  const version = /^version:[ \t]*["']?([^\s"'#]+)/m.exec(pubspec)?.[1];
  return version && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(version) ? version : undefined;
}
