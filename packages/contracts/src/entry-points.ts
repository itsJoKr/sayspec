/**
 * How the app under test is launched on this machine. The setup agent detects
 * these (flavors, dev/staging/qa targets) and the user can edit them in
 * Settings; recording offers them with the first one pre-selected.
 */
export interface ProjectEntryPoint {
  /** Short label such as "Development" or "Staging". */
  name: string;
  /**
   * Flutter: the complete `flutter run …` or `fvm flutter run …` command.
   * Web: the command that serves the app locally, when there is one.
   */
  command: string;
  /** Web only: the URL a recording opens. */
  url?: string;
  /**
   * Flutter only: the application ID this entry point installs as, such as
   * `com.example.shop.dev` for a flavor with an `applicationIdSuffix`. When
   * absent, SaySpec resolves it from the project's Gradle files.
   */
  appId?: string;
}

export interface ProjectEntryPoints {
  schemaVersion: 1;
  projectId: string;
  targetType: 'web' | 'flutter';
  /** Ordered; the first is the default. */
  entryPoints: readonly ProjectEntryPoint[];
  updatedAt?: string;
  updatedBy?: 'agent' | 'user';
}

/** A `flutter run` command reduced to the arguments SaySpec appends to its own launch. */
export interface FlutterRunCommand {
  runner: 'flutter' | 'fvm';
  args: string[];
  flavor?: string;
  target?: string;
}

export const ENTRY_POINT_LIMITS = Object.freeze({ count: 12, name: 80, command: 600, url: 2_048, appId: 255 });

/** An Android application ID or iOS bundle identifier: dot-separated segments of letters, digits, `_` or `-`. */
const APPLICATION_ID = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/;

/** Flags SaySpec sets itself when it launches the app for recording. */
const RESERVED_FLUTTER_FLAGS = new Set(['-d', '--device-id', '--machine', '--start-paused', '--use-application-binary']);

/** Splits a command into argv. There is no shell, so shell syntax is rejected rather than silently misread. */
export function tokenizeCommand(command: string): string[] {
  if (/[\r\n]/.test(command)) throw new Error('Use a single-line command.');
  const tokens: string[] = [];
  let current = ''; let quote: '"' | "'" | undefined; let started = false;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = undefined; else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/.test(character)) { if (started) tokens.push(current); current = ''; started = false; continue; }
    if (/[;&|<>`$(){}\\]/.test(character)) throw new Error(`Shell syntax such as "${character}" is not supported. Enter one command without pipes, chaining, redirects, or variables.`);
    current += character; started = true;
  }
  if (quote) throw new Error('The command has an unclosed quote.');
  if (started) tokens.push(current);
  return tokens;
}

function safeRelativePath(value: string) {
  return Boolean(value) && !value.startsWith('/') && !value.startsWith('~') && !/^[a-zA-Z]:/.test(value) && !value.split('/').includes('..');
}

/**
 * Accepts `flutter run …` or `fvm flutter run …` and returns the arguments
 * after `run`. Device selection and SaySpec's recorder defines stay with
 * SaySpec; everything else is passed to `flutter run` unchanged.
 */
export function parseFlutterRunCommand(command: string): FlutterRunCommand {
  const tokens = tokenizeCommand(command);
  const runner = tokens[0] === 'fvm' ? 'fvm' : 'flutter';
  const rest = runner === 'fvm' ? tokens.slice(1) : tokens;
  if (rest[0] !== 'flutter' || rest[1] !== 'run') throw new Error('Start the command with "flutter run" or "fvm flutter run".');
  const args = rest.slice(2);
  let flavor: string | undefined; let target: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('-')) {
      if (index === 0 || !args[index - 1]!.startsWith('-') || args[index - 1]!.includes('=')) throw new Error(`"${token}" is not a flutter run option. Pass the entry file with -t.`);
      continue;
    }
    const [flag, inline] = token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined];
    if (RESERVED_FLUTTER_FLAGS.has(flag) || /^-d./.test(flag)) throw new Error(`Remove ${flag}; SaySpec chooses the device and launch mode when you record.`);
    const value = inline ?? (args[index + 1] && !args[index + 1]!.startsWith('-') ? args[index + 1] : undefined);
    if (flag === '--dart-define' && value?.startsWith('SAYSPEC_')) throw new Error('SAYSPEC_ dart-defines are reserved for the recorder.');
    if (flag === '--flavor') { if (!value) throw new Error('--flavor needs a value.'); flavor = value; }
    if (flag === '-t' || flag === '--target') {
      if (!value) throw new Error(`${flag} needs the entry file, such as lib/main_dev.dart.`);
      if (!safeRelativePath(value)) throw new Error('The entry file must be a path inside the project, such as lib/main_dev.dart.');
      target = value;
    }
    if (flag === '--dart-define-from-file' && value && !safeRelativePath(value)) throw new Error('--dart-define-from-file must point inside the project.');
  }
  return { runner, args, ...(flavor ? { flavor } : {}), ...(target ? { target } : {}) };
}

/** Validates and normalizes an ordered entry-point list; the message names the offending row. */
export function validateEntryPoints(targetType: 'web' | 'flutter', value: unknown): ProjectEntryPoint[] {
  if (!Array.isArray(value)) throw new Error('Entry points must be a list.');
  if (value.length > ENTRY_POINT_LIMITS.count) throw new Error(`Keep at most ${ENTRY_POINT_LIMITS.count} entry points.`);
  const names = new Set<string>();
  return value.map((item, index) => {
    const row = `Entry point ${index + 1}`;
    if (typeof item !== 'object' || item === null) throw new Error(`${row} is invalid.`);
    const { name: rawName, command: rawCommand, url: rawUrl, appId: rawAppId } = item as Record<string, unknown>;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const command = typeof rawCommand === 'string' ? rawCommand.trim() : '';
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!name || name.length > ENTRY_POINT_LIMITS.name) throw new Error(`${row} needs a name of at most ${ENTRY_POINT_LIMITS.name} characters.`);
    if (names.has(name.toLowerCase())) throw new Error(`${row}: the name "${name}" is already used.`);
    names.add(name.toLowerCase());
    if (command.length > ENTRY_POINT_LIMITS.command) throw new Error(`${row}: the command is too long.`);
    if (targetType === 'flutter') {
      if (!command) throw new Error(`${row} (${name}) needs a flutter run command.`);
      try { parseFlutterRunCommand(command); } catch (error) { throw new Error(`${row} (${name}): ${(error as Error).message}`); }
      const appId = typeof rawAppId === 'string' ? rawAppId.trim() : '';
      if (appId && (appId.length > ENTRY_POINT_LIMITS.appId || !APPLICATION_ID.test(appId))) throw new Error(`${row} (${name}): the application ID must look like com.example.app.`);
      return { name, command, ...(appId ? { appId } : {}) };
    }
    if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(url) || url.length > ENTRY_POINT_LIMITS.url) throw new Error(`${row} (${name}) needs a complete HTTP(S) URL.`);
    if (command) { try { tokenizeCommand(command); } catch (error) { throw new Error(`${row} (${name}): ${(error as Error).message}`); } }
    return { name, command, url };
  });
}
