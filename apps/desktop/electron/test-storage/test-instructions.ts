import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestInstructionsView, TestLibraryScope } from '@sayspec/contracts';

/** The project's instructions for the AI that writes and fixes its tests, kept next to the tests. */
export const INSTRUCTIONS_FILE = 'SAYSPEC.md';
/** Enough for a thorough guide; SaySpec Cloud enforces the same limit. */
export const MAX_INSTRUCTIONS_BYTES = 64 * 1024;
/** The text last known to match SaySpec Cloud, so a local edit can be told apart from a teammate's. */
const CLOUD_SYNCED = path.join('.sayspec', 'SAYSPEC.cloud-synced.md');

export function instructionsTemplate(targetType: 'web' | 'flutter') {
  return `# Test instructions

<!--
SaySpec gives this file to the AI every time it writes or fixes a ${targetType === 'web' ? 'Playwright' : 'Patrol'} test for this project.
Write down what a new QA engineer would need to know to write good tests here: which selectors or keys
to rely on, how to sign in, test data and cleanup, slow or flaky screens, what every test should check,
naming, and what not to test. Test account usernames and passwords can go here: these are accounts
for testing, and tests sign in with them as written. Never put real personal credentials or API keys here.
-->
`;
}

/** Where a project's instructions live; `createIfMissing` for folders SaySpec owns. */
export type InstructionsLocation = { directory: string; createIfMissing: boolean };

/**
 * Reads and writes SAYSPEC.md for every storage. Local and Folder storage keep
 * the file itself next to the tests. SaySpec Cloud keeps the shared text in
 * Firebase, and this Mac keeps a copy that Finder, the instructions session and
 * generation read; the renderer carries text between the two.
 */
export class TestInstructions {
  readonly #locate: (scope: TestLibraryScope) => InstructionsLocation | undefined;

  constructor(locate: (scope: TestLibraryScope) => InstructionsLocation | undefined) { this.#locate = locate; }

  /** The file's path, or undefined when the project's storage folder is not known on this Mac. */
  path(scope: TestLibraryScope) { const location = this.#locate(scope); return location && path.join(location.directory, INSTRUCTIONS_FILE); }

  async view(scope: TestLibraryScope): Promise<TestInstructionsView> {
    const filePath = this.path(scope);
    if (!filePath) return { fileName: INSTRUCTIONS_FILE, state: 'missing-folder', written: false };
    const text = await readText(filePath);
    const updatedAt = text === null ? undefined : await stat(filePath).then((value) => value.mtime.toISOString(), () => undefined);
    return { fileName: INSTRUCTIONS_FILE, state: 'ready', displayPath: displayPath(filePath), written: isWritten(text), ...(updatedAt ? { updatedAt } : {}) };
  }

  /** The instructions to hand to a coding agent, or null when there are none beyond the starter text. */
  async read(scope: TestLibraryScope) {
    const filePath = this.path(scope);
    const text = filePath ? await readText(filePath) : null;
    return text !== null && isWritten(text) && Buffer.byteLength(text) <= MAX_INSTRUCTIONS_BYTES ? text : null;
  }

  /** Creates the file with starter text when it does not exist yet, and returns its path. */
  async ensure(scope: TestLibraryScope, targetType: 'web' | 'flutter') {
    const location = this.#locate(scope);
    if (!location) throw new Error('This project keeps its tests in a folder. Choose where that folder is on this Mac under Settings → Test storage.');
    if (location.createIfMissing) await mkdir(location.directory, { recursive: true });
    else if (!await isDirectory(location.directory)) throw new Error('The test storage folder is unavailable. Reconnect the drive or choose the folder again.');
    const filePath = path.join(location.directory, INSTRUCTIONS_FILE);
    await writeFile(filePath, instructionsTemplate(targetType), { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    return filePath;
  }

  /**
   * Brings this Mac's copy of a SaySpec Cloud project's instructions and the
   * shared text together. A teammate's change replaces an unedited local copy;
   * a local edit (from Finder or the instructions session) is returned for upload.
   */
  async syncCloud(scope: TestLibraryScope, cloudText: string | null): Promise<{ upload?: string }> {
    const location = this.#locate(scope);
    if (!location) return {};
    const filePath = path.join(location.directory, INSTRUCTIONS_FILE);
    const syncedPath = path.join(location.directory, CLOUD_SYNCED);
    const [local, synced] = await Promise.all([readText(filePath), readText(syncedPath)]);
    const action = reconcileCloudInstructions({ local, synced, cloud: cloudText });
    if (action === 'upload') {
      if (Buffer.byteLength(local!) > MAX_INSTRUCTIONS_BYTES) throw new Error(`${INSTRUCTIONS_FILE} is larger than ${MAX_INSTRUCTIONS_BYTES / 1024} KB. Shorten it to share it through SaySpec Cloud.`);
      return { upload: local! };
    }
    if (action === 'download') {
      await mkdir(location.directory, { recursive: true });
      await atomicWrite(filePath, cloudText!);
    }
    if ((action === 'download' || action === 'mark-synced') && cloudText !== synced) {
      await mkdir(path.dirname(syncedPath), { recursive: true });
      await atomicWrite(syncedPath, cloudText!);
    }
    return {};
  }
}

/**
 * What to do with a SaySpec Cloud project's instructions, from this Mac's copy
 * (`local`), the text both last agreed on (`synced`) and the shared text (`cloud`).
 * When both changed, the local edit wins: it is what the person here just did.
 */
export function reconcileCloudInstructions(input: { local: string | null; synced: string | null; cloud: string | null }): 'none' | 'upload' | 'download' | 'mark-synced' {
  const { local, synced, cloud } = input;
  if (cloud === null) return local !== null && isWritten(local) ? 'upload' : 'none';
  if (local === cloud) return synced === cloud ? 'none' : 'mark-synced';
  if (local === null || local === synced || !isWritten(local)) return 'download';
  return 'upload';
}

/** Copies the instructions to a project's new storage when it has none there yet. */
export async function carryInstructions(from: InstructionsLocation | undefined, to: InstructionsLocation | undefined) {
  if (!from || !to || path.resolve(from.directory) === path.resolve(to.directory)) return;
  const text = await readText(path.join(from.directory, INSTRUCTIONS_FILE));
  if (text === null) return;
  if (to.createIfMissing) await mkdir(to.directory, { recursive: true });
  else if (!await isDirectory(to.directory)) return;
  await writeFile(path.join(to.directory, INSTRUCTIONS_FILE), text, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
}

/** Starter text alone (or nothing) is not instructions. */
function isWritten(text: string | null) {
  const trimmed = text?.trim();
  return Boolean(trimmed) && trimmed !== instructionsTemplate('web').trim() && trimmed !== instructionsTemplate('flutter').trim();
}

async function readText(filePath: string) {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size > MAX_INSTRUCTIONS_BYTES * 4) return null;
    return await readFile(filePath, 'utf8');
  } catch { return null; }
}

async function atomicWrite(filePath: string, text: string) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, text, 'utf8');
  await rename(temporary, filePath);
}

const isDirectory = (directory: string) => stat(directory).then((value) => value.isDirectory(), () => false);

function displayPath(filePath: string) {
  const home = os.homedir();
  return filePath.startsWith(`${home}${path.sep}`) ? `~${filePath.slice(home.length)}` : filePath;
}
