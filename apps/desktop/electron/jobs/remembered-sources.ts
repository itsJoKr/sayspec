import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface RememberedSourcesState { schemaVersion: 1; projects: Record<string, string>; }

/** Per-project source folder paths, so a chosen folder survives app restarts. Paths never leave the main process. */
export class RememberedSourceStore {
  readonly #filePath: string;
  #state: RememberedSourcesState = { schemaVersion: 1, projects: {} };
  #write = Promise.resolve();

  constructor(filePath: string) { this.#filePath = filePath; }

  async initialize() {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.#filePath, 'utf8')) as Partial<RememberedSourcesState>;
      if (value.schemaVersion !== 1 || typeof value.projects !== 'object' || value.projects === null) throw new Error('Unsupported remembered sources.');
      const projects = Object.fromEntries(Object.entries(value.projects).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && path.isAbsolute(entry[1])));
      this.#state = { schemaVersion: 1, projects };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await rename(this.#filePath, `${this.#filePath}.invalid-${Date.now()}`).catch(() => undefined);
      this.#state = { schemaVersion: 1, projects: {} };
    }
  }

  /** The remembered folder for a project, or undefined when none is stored or it no longer exists. */
  async get(projectId: string): Promise<string | undefined> {
    const remembered = this.#state.projects[projectId];
    if (!remembered) return undefined;
    const exists = await stat(remembered).then((metadata) => metadata.isDirectory(), () => false);
    if (!exists) { await this.forget(projectId); return undefined; }
    return remembered;
  }

  async remember(projectId: string, directory: string) {
    if (this.#state.projects[projectId] === directory) return;
    this.#state = { schemaVersion: 1, projects: { ...this.#state.projects, [projectId]: directory } };
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
