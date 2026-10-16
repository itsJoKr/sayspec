import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TestLibraryScope } from '@sayspec/contracts';

export interface PendingCloudUpload { organizationId: string; projectId: string; testId: string; versionId: string }
interface StoredQueue { schemaVersion: 1; uploads: PendingCloudUpload[] }

const sameTest = (entry: PendingCloudUpload, scope: TestLibraryScope, testId: string) => entry.organizationId === scope.organizationId && entry.projectId === scope.projectId && entry.testId === testId;

/**
 * Flutter tests saved on this Mac for a SaySpec Cloud project that the cloud
 * does not hold yet. Only the renderer talks to SaySpec Cloud, so a saved test
 * waits here until the renderer uploads it; an upload that fails (offline,
 * signed out) stays queued for the next sync instead of being lost.
 */
export class CloudUploadQueue {
  readonly #filePath: string;
  #state: StoredQueue = { schemaVersion: 1, uploads: [] };
  #write = Promise.resolve();

  constructor(filePath: string) { this.#filePath = filePath; }

  async initialize() {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.#filePath, 'utf8')) as Partial<StoredQueue>;
      if (value.schemaVersion !== 1 || !Array.isArray(value.uploads)) throw new Error('Unsupported upload queue.');
      this.#state = { schemaVersion: 1, uploads: value.uploads.filter(isPendingUpload) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await rename(this.#filePath, `${this.#filePath}.invalid-${Date.now()}`).catch(() => undefined);
      this.#state = { schemaVersion: 1, uploads: [] };
    }
  }

  pending(scope: TestLibraryScope): PendingCloudUpload[] {
    return this.#state.uploads.filter((entry) => entry.organizationId === scope.organizationId && entry.projectId === scope.projectId).map((entry) => ({ ...entry }));
  }

  has(scope: TestLibraryScope, testId: string) { return this.#state.uploads.some((entry) => sameTest(entry, scope, testId)); }

  /** Queues a test's newest version; a version still waiting for the same test is replaced. */
  async add(entry: PendingCloudUpload) {
    const uploads = [...this.#state.uploads.filter((item) => !sameTest(item, entry, entry.testId)), { ...entry }];
    this.#state = { schemaVersion: 1, uploads };
    await this.#persist();
  }

  /** Clears a test once SaySpec Cloud holds `versionId`. A newer version saved meanwhile stays queued. */
  async remove(scope: TestLibraryScope, testId: string, versionId: string) {
    const uploads = this.#state.uploads.filter((entry) => !(sameTest(entry, scope, testId) && entry.versionId === versionId));
    if (uploads.length === this.#state.uploads.length) return;
    this.#state = { schemaVersion: 1, uploads };
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

function isPendingUpload(value: unknown): value is PendingCloudUpload {
  const item = value as PendingCloudUpload | null;
  return Boolean(item) && ['organizationId', 'projectId', 'testId', 'versionId'].every((key) => typeof item![key as keyof PendingCloudUpload] === 'string');
}
