import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, readdir, rename, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONTRACT_BUDGETS, CONTRACT_SCHEMA_VERSION, canTransitionJob, isSafeRelativePath, type JobErrorCode, type JobProgressEvent, type JobState } from '@sayspec/contracts';

const TERMINAL = new Set<JobState>(['succeeded', 'failed', 'canceled', 'interrupted']);
export interface LocalJobJournal {
  schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  jobId: string;
  organizationId: string;
  projectId: string;
  jobType: string;
  idempotencyKey: string;
  inputHash: string;
  lockKey: string;
  stagingDirectory: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  pid?: number;
  logBytes: number;
  logTruncated: boolean;
  progress: JobProgressEvent[];
  terminal?: { outcome: 'succeeded' | 'failed' | 'canceled' | 'interrupted'; code?: JobErrorCode; exitCode?: number | null; signal?: string | null };
}
export interface ProcessJobInput {
  organizationId: string; projectId: string; jobType: string; idempotencyKey: string;
  inputHash: string; lockKey: string; executable: string; args: readonly string[];
  inputBytes: number; environment?: Readonly<Record<string, string>>;
}
export interface LocalJobOptions {
  rootDirectory: string;
  maxInputBytes?: number;
  maxLogBytes?: number;
  minimumFreeBytes?: number;
  freeBytes?: (directory: string) => Promise<number>;
}

function safeSegment(value: string, label: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/.test(value)) throw new Error(`${label} is invalid.`);
}
function sanitize(text: string, roots: readonly string[]) {
  let result = text;
  for (const root of roots) result = result.split(root).join('<local-path>');
  return result
    .replace(/((?:token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer <redacted>');
}

export class LocalJobManager {
  readonly #root: string;
  readonly #journals: string;
  readonly #jobs: string;
  readonly #maxInputBytes: number;
  readonly #maxLogBytes: number;
  readonly #minimumFreeBytes: number;
  readonly #freeBytes: (directory: string) => Promise<number>;
  readonly #active = new Map<string, { child: ChildProcess; journal: LocalJobJournal; output: Buffer[]; outputBytes: number }>();
  readonly #locks = new Map<string, string>();

  constructor(options: LocalJobOptions) {
    this.#root = path.resolve(options.rootDirectory);
    this.#journals = path.join(this.#root, 'journals');
    this.#jobs = path.join(this.#root, 'jobs');
    this.#maxInputBytes = options.maxInputBytes ?? 512 * 1024 * 1024;
    this.#maxLogBytes = options.maxLogBytes ?? 1024 * 1024;
    this.#minimumFreeBytes = options.minimumFreeBytes ?? 256 * 1024 * 1024;
    this.#freeBytes = options.freeBytes ?? (async (directory) => {
      const value = await statfs(directory);
      return Number(value.bavail) * Number(value.bsize);
    });
  }

  get activeJobCount() { return this.#active.size; }

  async initialize() {
    await mkdir(this.#journals, { recursive: true });
    await mkdir(this.#jobs, { recursive: true });
    const names = await readdir(this.#journals);
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const journal = await this.readJournal(path.basename(name, '.json'));
      if (!TERMINAL.has(journal.state)) {
        journal.state = 'interrupted';
        journal.updatedAt = new Date().toISOString();
        journal.terminal = { outcome: 'interrupted', code: 'process-crash' };
        delete journal.pid;
        await this.#persist(journal);
      }
    }
  }

  async startProcess(input: ProcessJobInput): Promise<LocalJobJournal> {
    for (const [label, value] of [['organizationId', input.organizationId], ['projectId', input.projectId], ['jobType', input.jobType]] as const) safeSegment(value, label);
    if (!/^[a-f0-9]{64}$/.test(input.inputHash)) throw new Error('inputHash must be lowercase SHA-256.');
    if (!input.idempotencyKey || input.idempotencyKey.length > 256) throw new Error('idempotencyKey is invalid.');
    if (!input.lockKey || input.lockKey.length > 256) throw new Error('lockKey is invalid.');
    if (!Number.isSafeInteger(input.inputBytes) || input.inputBytes < 0 || input.inputBytes > this.#maxInputBytes) throw new Error('Input exceeds the local job budget.');
    const free = await this.#freeBytes(this.#root);
    if (free < this.#minimumFreeBytes + input.inputBytes) throw new Error('Insufficient free disk space for this job.');

    const existing = await this.#findByIdempotency(input.organizationId, input.projectId, input.idempotencyKey, input.inputHash);
    if (existing) return existing;
    if (this.#locks.has(input.lockKey)) throw new Error(`Resource is busy: ${input.lockKey}`);
    const jobId = `job_${randomUUID()}`;
    const stagingDirectory = path.join(this.#jobs, jobId);
    if (!isSafeRelativePath(path.relative(this.#root, stagingDirectory))) throw new Error('Unsafe staging directory.');
    await mkdir(stagingDirectory, { recursive: false });
    const now = new Date().toISOString();
    const journal: LocalJobJournal = {
      schemaVersion: CONTRACT_SCHEMA_VERSION, jobId, organizationId: input.organizationId,
      projectId: input.projectId, jobType: input.jobType, idempotencyKey: input.idempotencyKey,
      inputHash: input.inputHash, lockKey: input.lockKey, stagingDirectory, state: 'preparing',
      createdAt: now, updatedAt: now, logBytes: 0, logTruncated: false,
      progress: [],
    };
    await this.#persist(journal);
    this.#locks.set(input.lockKey, jobId);
    const child = spawn(input.executable, [...input.args], {
      cwd: stagingDirectory, shell: false, detached: process.platform !== 'win32',
      env: { PATH: process.env.PATH, ...input.environment }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    journal.pid = child.pid;
    this.#transition(journal, 'running');
    await this.#persist(journal);
    const active = { child, journal, output: [] as Buffer[], outputBytes: 0 };
    this.#active.set(jobId, active);
    const capture = (chunk: Buffer) => {
      if (active.outputBytes >= this.#maxLogBytes) { journal.logTruncated = true; return; }
      const remaining = this.#maxLogBytes - active.outputBytes;
      const bounded = chunk.subarray(0, remaining);
      active.output.push(bounded); active.outputBytes += bounded.byteLength;
      if (bounded.byteLength < chunk.byteLength) journal.logTruncated = true;
    };
    child.stdout?.on('data', capture); child.stderr?.on('data', capture);
    child.once('error', (error) => void this.#finish(jobId, 'failed', 'process-crash', null, null, String(error)));
    child.once('close', (code, signal) => {
      if (!this.#active.has(jobId)) return;
      const canceled = journal.state === 'cancel-requested';
      void this.#finish(jobId, canceled ? 'canceled' : code === 0 ? 'succeeded' : 'failed', canceled ? 'canceled' : code === 0 ? undefined : 'process-crash', code, signal);
    });
    return structuredClone(journal);
  }

  async cancel(jobId: string) {
    const active = this.#active.get(jobId);
    if (!active) return this.readJournal(jobId);
    this.#transition(active.journal, 'cancel-requested');
    await this.#persist(active.journal);
    const pid = active.child.pid;
    if (pid) {
      try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM'); } catch { active.child.kill('SIGTERM'); }
      setTimeout(() => {
        if (!this.#active.has(jobId)) return;
        try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch { active.child.kill('SIGKILL'); }
      }, 1_500).unref();
    }
    return structuredClone(active.journal);
  }

  async reportProgress(jobId: string, event: JobProgressEvent) {
    const active = this.#active.get(jobId);
    if (!active) throw new Error('Job is not active.');
    const previous = active.journal.progress.at(-1)?.sequence ?? -1;
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= previous) throw new Error('Progress sequence must increase.');
    if (new TextEncoder().encode(event.message).byteLength > CONTRACT_BUDGETS.progressMessageBytes) throw new Error('Progress message exceeds the contract budget.');
    if (active.journal.progress.length >= CONTRACT_BUDGETS.progressEvents) active.journal.progress.shift();
    active.journal.progress.push(structuredClone(event));
    active.journal.updatedAt = new Date().toISOString();
    await this.#persist(active.journal);
  }

  async wait(jobId: string): Promise<LocalJobJournal> {
    if (!this.#active.has(jobId)) return this.readJournal(jobId);
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => { if (!this.#active.has(jobId)) { clearInterval(interval); resolve(); } }, 10);
    });
    return this.readJournal(jobId);
  }

  async shutdown() {
    const ids = [...this.#active.keys()];
    await Promise.all(ids.map((id) => this.cancel(id)));
    await Promise.all(ids.map((id) => this.wait(id)));
  }

  async readJournal(jobId: string): Promise<LocalJobJournal> {
    safeSegment(jobId, 'jobId');
    return JSON.parse(await readFile(path.join(this.#journals, `${jobId}.json`), 'utf8')) as LocalJobJournal;
  }

  async #finish(jobId: string, outcome: 'succeeded' | 'failed' | 'canceled', code?: JobErrorCode, exitCode?: number | null, signal?: NodeJS.Signals | null, diagnostic = '') {
    const active = this.#active.get(jobId);
    if (!active) return;
    const { journal } = active;
    const log = sanitize(Buffer.concat(active.output).toString('utf8') + (diagnostic ? `\n${diagnostic}` : ''), [this.#root, journal.stagingDirectory]);
    await writeFile(path.join(journal.stagingDirectory, 'job.log'), log + (journal.logTruncated ? '\n[log truncated]\n' : ''), { encoding: 'utf8', mode: 0o600 });
    journal.logBytes = Buffer.byteLength(log);
    journal.state = outcome;
    journal.updatedAt = new Date().toISOString();
    journal.terminal = { outcome, code, exitCode, signal: signal ?? null };
    delete journal.pid;
    await this.#persist(journal);
    this.#active.delete(jobId);
    this.#locks.delete(journal.lockKey);
  }

  #transition(journal: LocalJobJournal, next: JobState) {
    if (!canTransitionJob(journal.state, next)) throw new Error(`Invalid job transition ${journal.state} → ${next}.`);
    journal.state = next; journal.updatedAt = new Date().toISOString();
  }
  async #persist(journal: LocalJobJournal) {
    const destination = path.join(this.#journals, `${journal.jobId}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(journal, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, destination);
  }
  async #findByIdempotency(organizationId: string, projectId: string, key: string, inputHash: string) {
    for (const name of await readdir(this.#journals)) {
      if (!name.endsWith('.json')) continue;
      const journal = await this.readJournal(path.basename(name, '.json'));
      if (journal.organizationId === organizationId && journal.projectId === projectId && journal.idempotencyKey === key) {
        if (journal.inputHash !== inputHash) throw new Error('Idempotency key was reused with different input.');
        return journal;
      }
    }
    return undefined;
  }
}
