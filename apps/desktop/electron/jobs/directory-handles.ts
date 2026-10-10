import { randomUUID } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isSafeRelativePath } from '@sayspec/contracts';

export class LocalBoundaryError extends Error {
  readonly code: 'invalid-path' | 'stale-handle' | 'symlink-escape' | 'oversized-input';
  constructor(code: 'invalid-path' | 'stale-handle' | 'symlink-escape' | 'oversized-input', message: string) {
    super(message);
    this.name = 'LocalBoundaryError';
    this.code = code;
  }
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class DirectoryHandleRegistry {
  readonly #directories = new Map<string, string>();

  async register(selectedPath: string): Promise<string> {
    const canonical = await realpath(selectedPath);
    if (!(await stat(canonical)).isDirectory()) throw new LocalBoundaryError('invalid-path', 'Selected resource is not a directory.');
    const handle = `directory_${randomUUID()}`;
    this.#directories.set(handle, canonical);
    return handle;
  }

  /** The canonical root a handle points at, without reading any file in it. */
  root(handle: string): string {
    const root = this.#directories.get(handle);
    if (!root) throw new LocalBoundaryError('stale-handle', 'The selected directory is no longer available. Select it again.');
    return root;
  }

  revoke(handle: string) { this.#directories.delete(handle); }
  clear() { this.#directories.clear(); }

  async resolve(handle: string, relativePath: string, options: { mustExist?: boolean; maxBytes?: number } = {}): Promise<string> {
    const root = this.#directories.get(handle);
    if (!root) throw new LocalBoundaryError('stale-handle', 'The selected directory is no longer available. Select it again.');
    if (!isSafeRelativePath(relativePath)) throw new LocalBoundaryError('invalid-path', 'The requested path is not a safe relative path.');
    const candidate = path.resolve(root, relativePath);
    if (!isWithin(root, candidate)) throw new LocalBoundaryError('invalid-path', 'The requested path leaves the selected directory.');

    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      if (options.mustExist !== false) throw error;
      const parent = await realpath(path.dirname(candidate));
      if (!isWithin(root, parent)) throw new LocalBoundaryError('symlink-escape', 'The requested path resolves through a link outside the selected directory.');
      canonical = path.join(parent, path.basename(candidate));
    }
    if (!isWithin(root, canonical)) throw new LocalBoundaryError('symlink-escape', 'The requested path resolves outside the selected directory.');
    const metadata = await lstat(candidate).catch(() => null);
    if (metadata?.isSymbolicLink() && !isWithin(root, canonical)) throw new LocalBoundaryError('symlink-escape', 'Symbolic link leaves the selected directory.');
    if (metadata?.isFile() && options.maxBytes !== undefined && metadata.size > options.maxBytes) {
      throw new LocalBoundaryError('oversized-input', `File exceeds the ${options.maxBytes}-byte input budget.`);
    }
    return canonical;
  }
}
