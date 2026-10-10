import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateEntryPoints, type ProjectEntryPoints } from '@sayspec/contracts';

interface EntryPointsState { schemaVersion: 1; projects: Record<string, ProjectEntryPoints>; }

const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/**
 * Per-project launch entry points on this machine. They are local because the
 * right command (`fvm flutter` or `flutter`, a dev server script) depends on
 * the machine and source checkout, and every member may record.
 */
export class ProjectEntryPointStore {
  readonly #filePath: string;
  #state: EntryPointsState = { schemaVersion: 1, projects: {} };
  #write = Promise.resolve();

  constructor(filePath: string) { this.#filePath = filePath; }

  async initialize() {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.#filePath, 'utf8')) as Partial<EntryPointsState>;
      if (value.schemaVersion !== 1 || typeof value.projects !== 'object' || value.projects === null) throw new Error('Unsupported entry points.');
      const projects: Record<string, ProjectEntryPoints> = {};
      for (const [projectId, entry] of Object.entries(value.projects)) {
        try {
          if (!PROJECT_ID.test(projectId) || (entry.targetType !== 'web' && entry.targetType !== 'flutter')) continue;
          projects[projectId] = { ...entry, entryPoints: validateEntryPoints(entry.targetType, entry.entryPoints) };
        } catch { /* An entry that no longer validates is dropped rather than launched. */ }
      }
      this.#state = { schemaVersion: 1, projects };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await rename(this.#filePath, `${this.#filePath}.invalid-${Date.now()}`).catch(() => undefined);
      this.#state = { schemaVersion: 1, projects: {} };
    }
  }

  get(projectId: string, targetType: 'web' | 'flutter'): ProjectEntryPoints {
    const stored = this.#state.projects[projectId];
    if (stored && stored.targetType === targetType) return structuredClone(stored);
    return { schemaVersion: 1, projectId, targetType, entryPoints: [] };
  }

  async save(input: { projectId: string; targetType: 'web' | 'flutter'; entryPoints: unknown; updatedBy: 'agent' | 'user' }) {
    if (!PROJECT_ID.test(input.projectId)) throw new Error('Project ID is invalid.');
    if (input.targetType !== 'web' && input.targetType !== 'flutter') throw new Error('Project technology is invalid.');
    const value: ProjectEntryPoints = {
      schemaVersion: 1, projectId: input.projectId, targetType: input.targetType,
      entryPoints: validateEntryPoints(input.targetType, input.entryPoints),
      updatedAt: new Date().toISOString(), updatedBy: input.updatedBy,
    };
    this.#state = { schemaVersion: 1, projects: { ...this.#state.projects, [input.projectId]: value } };
    await this.#persist();
    return structuredClone(value);
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
