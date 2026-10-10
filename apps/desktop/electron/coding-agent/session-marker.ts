import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Coding-agent sessions can write (and, for shell-capable providers, symlink)
// anything inside their session directory. The unsandboxed main process must
// therefore never follow a link there: a planted `proposal-result.json ->
// <checkout>/lib/main.dart` would otherwise let the agent overwrite a file
// outside its sandbox through main.

/** Reads a regular marker file without following a symlink; undefined when absent. */
export async function readSessionMarker(directory: string, name: string, maxBytes: number): Promise<Buffer | undefined> {
  const target = path.join(directory, name);
  let handle;
  try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') throw new Error(`${name} must be a regular file, not a link.`);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${name} must be a regular file.`);
    if (stat.size > maxBytes) throw new Error(`${name} exceeds ${Math.round(maxBytes / 1024)} KiB.`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

/** Writes a result marker by creating a fresh file and renaming it over the name, replacing (never following) any link. */
export async function writeSessionMarker(directory: string, name: string, text: string) {
  const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text); } finally { await handle.close(); }
  try {
    const existing = await lstat(path.join(directory, name)).catch(() => undefined);
    if (existing?.isDirectory()) throw new Error(`${name} is a directory.`);
    await rename(temporary, path.join(directory, name));
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
