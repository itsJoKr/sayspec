import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CodingAgentPreference,
  CodingAgentProviderId,
  CodingAgentReadinessReport,
  CodingAgentSelectionResult,
} from '@sayspec/contracts';

export const CODING_AGENT_INSTALL_URLS: Readonly<Record<CodingAgentProviderId, string>> = Object.freeze({
  'claude-code': 'https://code.claude.com/docs/en/getting-started',
  codex: 'https://developers.openai.com/codex/cli',
});

const emptyPreference = (): CodingAgentPreference => ({ schemaVersion: 1 });

export class CodingAgentPreferenceStore {
  readonly #filePath: string;
  #state: CodingAgentPreference = emptyPreference();
  #write = Promise.resolve();

  constructor(filePath: string) { this.#filePath = filePath; }

  async initialize() {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.#filePath, 'utf8')) as Partial<CodingAgentPreference>;
      if (value.schemaVersion !== 1 || value.provider !== undefined && !['claude-code', 'codex'].includes(value.provider)) throw new Error('Unsupported coding-agent preference.');
      this.#state = { schemaVersion: 1, ...(value.provider ? { provider: value.provider, updatedAt: String(value.updatedAt ?? '') } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await rename(this.#filePath, `${this.#filePath}.invalid-${Date.now()}`).catch(() => undefined);
      }
      this.#state = emptyPreference();
      await this.#persist();
    }
  }

  snapshot(): CodingAgentPreference { return structuredClone(this.#state); }

  async select(provider: CodingAgentProviderId) {
    if (!['claude-code', 'codex'].includes(provider)) throw new Error('Choose Claude Code or Codex.');
    this.#state = { schemaVersion: 1, provider, updatedAt: new Date().toISOString() };
    await this.#persist();
    return this.snapshot();
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

export interface CodingAgentReadinessSource { readiness(): Promise<CodingAgentReadinessReport>; }

export class CodingAgentPreferenceManager {
  readonly #store: CodingAgentPreferenceStore;
  readonly #agents: CodingAgentReadinessSource;
  readonly #openExternal: (url: string) => Promise<unknown>;

  constructor(options: { store: CodingAgentPreferenceStore; agents: CodingAgentReadinessSource; openExternal(url: string): Promise<unknown> }) {
    this.#store = options.store; this.#agents = options.agents; this.#openExternal = options.openExternal;
  }

  snapshot() { return this.#store.snapshot(); }

  async select(provider: CodingAgentProviderId): Promise<CodingAgentSelectionResult> {
    if (!['claude-code', 'codex'].includes(provider)) throw new Error('Choose Claude Code or Codex.');
    const report = await this.#agents.readiness();
    const readiness = report.providers.find((item) => item.id === provider);
    if (!readiness) throw new Error('Coding-agent readiness was incomplete.');
    if (readiness.state === 'missing') {
      const installUrl = CODING_AGENT_INSTALL_URLS[provider];
      await this.#openExternal(installUrl);
      return { preference: this.#store.snapshot(), readiness, saved: false, installPageOpened: true, installUrl };
    }
    return { preference: await this.#store.select(provider), readiness, saved: true, installPageOpened: false };
  }
}
