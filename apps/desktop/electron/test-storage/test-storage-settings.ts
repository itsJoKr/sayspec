import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TestStorageMode } from '@sayspec/contracts';

export interface ProjectTestStorage { mode: TestStorageMode; directory?: string; targetType?: 'web' | 'flutter' }
interface StoredSettings { schemaVersion: 1; projects: Record<string, ProjectTestStorage> }

/**
 * Where each project keeps its tests, as this machine knows it. Guest projects
 * are recorded here only; a signed-in project's choice is shared through
 * SaySpec Cloud and mirrored here by the renderer. A storage folder's path is
 * personal (each teammate has their own checkout), so it is remembered per
 * machine and never leaves the main process.
 */
export class TestStorageSettingsStore {
  readonly #filePath: string;
  #state: StoredSettings = { schemaVersion: 1, projects: {} };
  #write = Promise.resolve();

  constructor(filePath: string) { this.#filePath = filePath; }

  async initialize() {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.#filePath, 'utf8')) as Partial<StoredSettings>;
      if (value.schemaVersion !== 1 || typeof value.projects !== 'object' || value.projects === null) throw new Error('Unsupported test storage settings.');
      this.#state = { schemaVersion: 1, projects: Object.fromEntries(Object.entries(value.projects).filter(([, item]) => isProjectStorage(item))) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await rename(this.#filePath, `${this.#filePath}.invalid-${Date.now()}`).catch(() => undefined);
      this.#state = { schemaVersion: 1, projects: {} };
    }
  }

  /** The project's storage, or undefined when this machine has not been told yet. */
  get(projectId: string): ProjectTestStorage | undefined {
    const entry = this.#state.projects[projectId];
    return entry ? structuredClone(entry) : undefined;
  }

  /** Records the project's storage. A folder is remembered, so switching back to Folder later reuses it. */
  async configure(projectId: string, value: { mode: TestStorageMode; targetType: 'web' | 'flutter'; directory?: string }) {
    if (value.directory !== undefined && !path.isAbsolute(value.directory)) throw new Error('The storage folder must be an absolute path.');
    const current = this.#state.projects[projectId];
    const next: ProjectTestStorage = { mode: value.mode, targetType: value.targetType, ...((value.directory ?? current?.directory) ? { directory: value.directory ?? current?.directory } : {}) };
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    this.#state = { schemaVersion: 1, projects: { ...this.#state.projects, [projectId]: next } };
    await this.#persist();
  }

  async forget(projectId: string) {
    if (!(projectId in this.#state.projects)) return;
    const { [projectId]: _removed, ...projects } = this.#state.projects;
    this.#state = { schemaVersion: 1, projects };
    await this.#persist();
  }

  async #persist() {
    const serialized = `${JSON.stringify(this.#state, null, 2)}\n`;
    this.#write = this.#write.then(async () => {
      const temporary = `${this.#filePath}.tmp`;
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#filePath);
    });
    await this.#write;
  }
}

/** Entries from before the three storages (mode 'sayspec') are dropped; the project then uses its default again. */
function isProjectStorage(value: unknown): value is ProjectTestStorage {
  if (!value || typeof value !== 'object') return false;
  const item = value as ProjectTestStorage;
  return (item.mode === 'local' || item.mode === 'cloud' || item.mode === 'folder') && (item.directory === undefined || (typeof item.directory === 'string' && path.isAbsolute(item.directory)));
}
