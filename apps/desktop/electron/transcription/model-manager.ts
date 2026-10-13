import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocalTranscriptionLifecycleEvent, LocalTranscriptionSetup, LocalWhisperModel, LocalWhisperRuntime } from '@sayspec/contracts';
import { DEFAULT_WHISPER_MODEL, WHISPER_RUNTIME, type WhisperModelManifest } from './model-manifest.ts';

const MINIMUM_FREE_BYTES = 256 * 1024 * 1024;

type FetchLike = typeof fetch;
type Platform = NodeJS.Platform;

interface PersistedModelState {
  schemaVersion: 1;
  state: LocalWhisperModel['state'];
  downloadedBytes: number;
  error?: string;
}

export interface LocalModelManagerOptions {
  rootDirectory: string;
  manifest?: WhisperModelManifest;
  fetchImpl?: FetchLike;
  platform?: Platform;
  architecture?: string;
  runtimeCandidates?: readonly string[];
  converterCandidates?: readonly string[];
  minimumFreeBytes?: number;
  availableFreeBytes?(): Promise<number>;
  onLifecycle?(event: LocalTranscriptionLifecycleEvent): void;
}

function spawnVersion(executable: string, args = ['--version']): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += String(chunk); });
    child.stderr?.on('data', (chunk) => { output += String(chunk); });
    child.once('error', () => resolve(undefined));
    child.once('close', (code) => resolve(code === 0 ? output : undefined));
  });
}

async function sha256File(filePath: string) {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject); stream.once('end', resolve);
  });
  return hash.digest('hex');
}

export class LocalModelManager {
  readonly #root: string;
  readonly #manifest: WhisperModelManifest;
  readonly #fetch: FetchLike;
  readonly #platform: Platform;
  readonly #architecture: string;
  readonly #runtimeCandidates: readonly string[];
  readonly #converterCandidates: readonly string[];
  readonly #minimumFreeBytes: number;
  readonly #availableFreeBytes: () => Promise<number>;
  readonly #onLifecycle: NonNullable<LocalModelManagerOptions['onLifecycle']>;
  #runtime?: LocalWhisperRuntime;
  #state: PersistedModelState = { schemaVersion: 1, state: 'not-installed', downloadedBytes: 0 };
  #download?: { controller: AbortController; promise: Promise<LocalTranscriptionSetup> };

  constructor(options: LocalModelManagerOptions) {
    this.#root = path.resolve(options.rootDirectory);
    this.#manifest = options.manifest ?? DEFAULT_WHISPER_MODEL;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#platform = options.platform ?? process.platform;
    this.#architecture = options.architecture ?? process.arch;
    this.#runtimeCandidates = options.runtimeCandidates ?? [
      process.env.SAYSPEC_WHISPER_CLI ?? '',
      this.#platform === 'darwin' && this.#architecture === 'arm64' ? '/opt/homebrew/bin/whisper-cli' : '',
      this.#platform === 'darwin' ? '/usr/local/bin/whisper-cli' : '',
      'whisper-cli',
    ].filter(Boolean);
    this.#converterCandidates = options.converterCandidates ?? [
      process.env.SAYSPEC_FFMPEG ?? '',
      this.#platform === 'darwin' && this.#architecture === 'arm64' ? '/opt/homebrew/bin/ffmpeg' : '',
      this.#platform === 'darwin' ? '/usr/local/bin/ffmpeg' : '',
      'ffmpeg',
    ].filter(Boolean);
    this.#minimumFreeBytes = options.minimumFreeBytes ?? MINIMUM_FREE_BYTES;
    this.#availableFreeBytes = options.availableFreeBytes ?? (async () => { const free = await statfs(this.#root); return Number(free.bavail) * Number(free.bsize); });
    this.#onLifecycle = options.onLifecycle ?? (() => undefined);
  }

  get modelPath() { return path.join(this.#root, this.#manifest.fileName); }

  async initialize() {
    await mkdir(this.#root, { recursive: true });
    await rm(this.#partialPath(), { force: true });
    try {
      const parsed = JSON.parse(await readFile(this.#statePath(), 'utf8')) as PersistedModelState;
      if (parsed.schemaVersion === 1) this.#state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#state = { schemaVersion: 1, state: 'failed', downloadedBytes: 0, error: 'Model state could not be read.' };
    }
    this.#runtime = await this.#detectRuntime();
    await this.#verifyInstalled();
    await this.#persist();
  }

  async snapshot(): Promise<LocalTranscriptionSetup> {
    if (!this.#runtime) this.#runtime = await this.#detectRuntime();
    return { runtime: { ...this.#runtime }, model: this.#modelSnapshot() };
  }

  async install(modelId: string) {
    if (modelId !== this.#manifest.id) throw new Error('Unknown local transcription model.');
    if (this.#download) return this.#download.promise;
    const existing = await this.snapshot();
    if (existing.model.state === 'installed') return existing;
    if (existing.runtime.state !== 'ready') throw new Error(existing.runtime.detail);
    const freeBytes = await this.#availableFreeBytes();
    if (freeBytes < this.#manifest.byteLength + this.#minimumFreeBytes) throw new Error(`At least ${this.#manifest.byteLength + this.#minimumFreeBytes} free bytes are required to install the local model safely.`);
    const controller = new AbortController();
    const promise = this.#downloadModel(controller).finally(() => { this.#download = undefined; });
    this.#download = { controller, promise };
    return promise;
  }

  async cancelInstall() {
    this.#download?.controller.abort();
    try { await this.#download?.promise; } catch { /* cancellation state is persisted by the download */ }
    return this.snapshot();
  }

  async remove(modelId: string) {
    if (modelId !== this.#manifest.id) throw new Error('Unknown local transcription model.');
    if (this.#download) await this.cancelInstall();
    await Promise.all([rm(this.modelPath, { force: true }), rm(this.#partialPath(), { force: true })]);
    this.#state = { schemaVersion: 1, state: 'not-installed', downloadedBytes: 0 };
    await this.#persist(); this.#emit('not-installed', 0, 'Local Whisper model removed.');
    return this.snapshot();
  }

  async requireReady() {
    const setup = await this.snapshot();
    if (setup.runtime.state !== 'ready' || setup.model.state !== 'installed') throw new Error(setup.runtime.state !== 'ready' ? setup.runtime.detail : 'Install the local Whisper model before transcribing.');
    return { setup, modelPath: this.modelPath, runtimePath: setup.runtime.executablePath!, converterPath: setup.runtime.converterPath! };
  }

  async #downloadModel(controller: AbortController) {
    this.#state = { schemaVersion: 1, state: 'downloading', downloadedBytes: 0 };
    await this.#persist(); this.#emit('downloading', 0, 'Downloading the local Whisper model…');
    try {
      const response = await this.#fetch(this.#manifest.sourceUrl, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`Model download failed with HTTP ${response.status}.`);
      const expectedLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(expectedLength) && expectedLength > 0 && expectedLength !== this.#manifest.byteLength) throw new Error('Model server returned an unexpected byte length.');
      const output = createWriteStream(this.#partialPath(), { flags: 'w', mode: 0o600 });
      const reader = response.body.getReader(); const hash = createHash('sha256'); let received = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          if (controller.signal.aborted) throw new DOMException('Canceled', 'AbortError');
          received += value.byteLength;
          if (received > this.#manifest.byteLength) throw new Error('Model download exceeded the pinned byte length.');
          hash.update(value);
          if (!output.write(Buffer.from(value))) await new Promise<void>((resolve) => output.once('drain', resolve));
          this.#state.downloadedBytes = received;
          this.#emit('downloading', received / this.#manifest.byteLength, `Downloaded ${received.toLocaleString()} of ${this.#manifest.byteLength.toLocaleString()} bytes.`);
        }
      } finally { await new Promise<void>((resolve) => output.end(resolve)); }
      const digest = hash.digest('hex');
      if (received !== this.#manifest.byteLength || digest !== this.#manifest.sha256) throw new Error('Downloaded model failed its pinned size or SHA-256 integrity check.');
      await rename(this.#partialPath(), this.modelPath); await chmod(this.modelPath, 0o600);
      this.#state = { schemaVersion: 1, state: 'installed', downloadedBytes: received };
      await this.#persist(); this.#emit('installed', 1, 'Local Whisper model verified and installed.');
      return this.snapshot();
    } catch (error) {
      await rm(this.#partialPath(), { force: true });
      const canceled = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      this.#state = canceled
        ? { schemaVersion: 1, state: 'not-installed', downloadedBytes: 0, error: 'Model download canceled. Nothing was installed.' }
        : { schemaVersion: 1, state: 'failed', downloadedBytes: 0, error: error instanceof Error ? error.message : String(error) };
      await this.#persist(); this.#emit(this.#state.state, 0, this.#state.error!);
      if (!canceled) throw error;
      return this.snapshot();
    }
  }

  async #verifyInstalled() {
    try {
      const info = await stat(this.modelPath);
      if (info.size !== this.#manifest.byteLength || await sha256File(this.modelPath) !== this.#manifest.sha256) {
        await rm(this.modelPath, { force: true });
        this.#state = { schemaVersion: 1, state: 'failed', downloadedBytes: 0, error: 'Installed model was corrupt and has been removed. Reinstall it.' };
      } else this.#state = { schemaVersion: 1, state: 'installed', downloadedBytes: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && this.#state.state === 'installed') this.#state = { schemaVersion: 1, state: 'not-installed', downloadedBytes: 0, error: 'The installed model file is missing. Reinstall it.' };
      else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      else if (this.#state.state === 'downloading') this.#state = { schemaVersion: 1, state: 'not-installed', downloadedBytes: 0, error: 'An interrupted model download was discarded safely. Retry to install.' };
    }
  }

  /** FFmpeg alone, for cloud transcription, which needs no Whisper runtime or model. */
  async requireConverter() {
    const converterPath = (await this.snapshot()).runtime.converterPath ?? await this.#detectConverter();
    if (!converterPath) throw new Error('FFmpeg is required to prepare recorded audio for cloud transcription. Install it with `brew install ffmpeg`.');
    return converterPath;
  }

  async #detectConverter() {
    for (const candidate of this.#converterCandidates) {
      const output = await spawnVersion(candidate, ['-version']);
      if (output?.includes('ffmpeg version')) return candidate;
    }
    return undefined;
  }

  async #detectRuntime(): Promise<LocalWhisperRuntime> {
    if (!['darwin', 'linux', 'win32'].includes(this.#platform) || !['arm64', 'x64'].includes(this.#architecture)) return {
      state: 'unsupported', name: 'whisper.cpp', requiredVersion: WHISPER_RUNTIME.version,
      detail: `Local transcription is not qualified for ${this.#platform}/${this.#architecture}.`,
    };
    let runtimePath: string | undefined; let detectedVersion: string | undefined;
    for (const candidate of this.#runtimeCandidates) {
      const output = await spawnVersion(candidate);
      const match = output?.match(/whisper\.cpp version:\s*([\w.-]+)/i);
      if (match) { runtimePath = candidate; detectedVersion = match[1]; break; }
    }
    const converterPath = await this.#detectConverter();
    if (!runtimePath || !converterPath) return {
      state: 'missing', name: 'whisper.cpp', requiredVersion: WHISPER_RUNTIME.version,
      ...(detectedVersion ? { detectedVersion } : {}),
      detail: !runtimePath ? `whisper.cpp ${WHISPER_RUNTIME.version} is required for local transcription.` : 'FFmpeg is required to decode recorded WebM/Opus audio locally.',
    };
    if (detectedVersion !== WHISPER_RUNTIME.version) return {
      state: 'unsupported', name: 'whisper.cpp', requiredVersion: WHISPER_RUNTIME.version,
      detectedVersion, executablePath: runtimePath, converterPath,
      detail: `Found whisper.cpp ${detectedVersion}; this build is verified with ${WHISPER_RUNTIME.version}.`,
    };
    return {
      state: 'ready', name: 'whisper.cpp', requiredVersion: WHISPER_RUNTIME.version,
      detectedVersion, executablePath: runtimePath, converterPath,
      detail: `whisper.cpp ${detectedVersion} and FFmpeg are ready for on-device transcription.`,
    };
  }

  #modelSnapshot(): LocalWhisperModel {
    return { ...this.#manifest, state: this.#state.state, downloadedBytes: this.#state.downloadedBytes, ...(this.#state.error ? { error: this.#state.error } : {}) };
  }
  #emit(state: LocalWhisperModel['state'], progress: number, message: string) { this.#onLifecycle({ kind: 'model', state, progress: Math.max(0, Math.min(1, progress)), message }); }
  #statePath() { return path.join(this.#root, 'state.json'); }
  #partialPath() { return `${this.modelPath}.partial`; }
  async #persist() {
    const temporary = `${this.#statePath()}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#statePath());
  }
}
