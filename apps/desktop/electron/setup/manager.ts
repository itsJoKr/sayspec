import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  MachineSetupJob, MachineSetupLogEvent, MachineSetupPlan, MachineSetupReport, MachineSetupRequest, MachineSetupState, MachineSetupWorkflow,
} from '@sayspec/contracts';
import { checkMachineSetup, type SetupContext } from './checks.ts';
import { buildInstallPlan, openInTerminal, resolveInstallerRuntime, runStreamingCommand, type InstallerRuntime } from './installers.ts';

interface JournalEntry { job: MachineSetupJob }

/**
 * Owns Settings → Machine setup.
 *
 * Checks and installers run here in the main process. The renderer receives
 * narrow reports and one-way progress events; it never supplies a command,
 * path or shell fragment.
 */
export class MachineSetupManager {
  readonly #journalPath: string;
  readonly #onEvent: (event: MachineSetupLogEvent) => void;
  readonly #jobs = new Map<string, MachineSetupJob>();
  readonly #controllers = new Map<string, AbortController>();
  #context: SetupContext = {};
  #report?: MachineSetupReport;

  constructor(options: { journalPath: string; onEvent: (event: MachineSetupLogEvent) => void }) {
    this.#journalPath = options.journalPath;
    this.#onEvent = options.onEvent;
  }

  /** Loads the previous job journal so an interrupted install stays visible. */
  async initialize() {
    try {
      const entries = JSON.parse(await readFile(this.#journalPath, 'utf8')) as JournalEntry[];
      for (const entry of entries.slice(-40)) this.#jobs.set(entry.job.id, entry.job);
    } catch { /* first run */ }
  }

  async shutdown() {
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
  }

  /**
   * Reconciles jobs that were still running when the app stopped by re-reading
   * the machine, then republishing the journal. A job is never reported as
   * completed merely because it was interrupted.
   */
  async reconcileInterruptedJobs(): Promise<MachineSetupJob[]> {
    const interrupted = [...this.#jobs.values()].filter((job) => job.state === 'running' || job.state === 'queued' || job.state === 'waiting-for-user');
    if (!interrupted.length) return [];
    const report = await this.check({});
    for (const job of interrupted) {
      const affected = report.groups.flatMap((group) => group.items).filter((item) => job.itemIds.includes(item.id));
      const satisfiedNow = affected.length > 0 && affected.every((item) => item.state === 'installed' || item.state === 'verified');
      const next: MachineSetupJob = {
        ...job,
        state: satisfiedNow ? 'completed' : 'failed',
        finishedAt: new Date().toISOString(),
        currentItemId: undefined,
        outcome: satisfiedNow
          ? 'Setup was interrupted, but every requested item is now installed. Re-check passed.'
          : 'Setup was interrupted before finishing. Re-check the affected items and retry.',
        steps: job.steps.map((step) => step.state === 'running' || step.state === 'pending'
          ? { ...step, state: 'failed', detail: 'Interrupted when SaySpec stopped.' }
          : step),
      };
      this.#jobs.set(job.id, next);
      this.#onEvent({ jobId: job.id, kind: 'done', job: next });
    }
    await this.#persist();
    return interrupted.map((job) => this.#jobs.get(job.id)!);
  }

  /** Cached report, or a fresh check when none has run yet. */
  async report(): Promise<MachineSetupReport> {
    return this.#report ?? this.check({});
  }

  /**
   * Runs every check against the current context. A request may add the
   * selected project's source folder, which is what enables the project-build
   * checks; an absent project keeps those honest rather than all-ready.
   */
  async check(request: MachineSetupRequest): Promise<MachineSetupReport> {
    if (request.sourceHandle !== undefined) this.#context = { ...this.#context, sourcePath: await this.#resolveSource(request.sourceHandle) };
    const report = await checkMachineSetup(this.#context);
    this.#report = report;
    return report;
  }

  /** Records the selected project identity used by the project-specific checks. */
  async configureContext(next: SetupContext) {
    this.#context = { ...this.#context, ...next };
    this.#report = undefined;
  }

  /** Runs one project check from an immutable context so overlapping project
   * switches cannot combine one project's source with another project's type. */
  async checkContext(next: SetupContext): Promise<MachineSetupReport> {
    const context = { ...next };
    const report = await checkMachineSetup(context);
    this.#context = context;
    this.#report = report;
    return report;
  }

  #sourceResolver: ((handle: string) => Promise<string | undefined>) | undefined;

  /** Lets main resolve a validated directory handle without exposing paths. */
  setSourceResolver(resolver: (handle: string) => Promise<string | undefined>) {
    this.#sourceResolver = resolver;
  }

  async #resolveSource(handle: string) {
    if (!this.#sourceResolver) return undefined;
    return this.#sourceResolver(handle);
  }

  async plan(input: { workflow: MachineSetupWorkflow; itemIds?: string[] }): Promise<MachineSetupPlan> {
    const report = await this.check({});
    const items = report.groups.flatMap((group) => group.items);
    const runtime: InstallerRuntime = await resolveInstallerRuntime();
    const plan = await buildInstallPlan({ workflow: input.workflow, items, runtime });
    if (!input.itemIds?.length) return plan;
    const wanted = new Set(input.itemIds);
    return { ...plan, steps: plan.steps.filter((step) => wanted.has(step.itemId)), itemIds: plan.itemIds.filter((id) => wanted.has(id)) };
  }

  job(jobId: string): MachineSetupJob {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error('That setup job is unknown.');
    return job;
  }

  async cancel(jobId: string): Promise<MachineSetupJob> {
    const controller = this.#controllers.get(jobId);
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error('That setup job is unknown.');
    if (!controller) return job;
    controller.abort();
    return this.#jobs.get(jobId)!;
  }

  /**
   * Runs the plan's steps in order.
   *
   * A step whose item is already satisfied is skipped, so re-running an
   * interrupted install does not repeat finished work. Manual items are
   * surfaced as `waiting-for-user` with the exact action, then the job finishes
   * and invites a re-check instead of waiting forever.
   */
  async install(input: { workflow: MachineSetupWorkflow; itemIds?: string[] }): Promise<MachineSetupJob> {
    const plan = await this.plan(input);
    const jobId = `setup_${randomUUID()}`;
    const controller = new AbortController();
    this.#controllers.set(jobId, controller);
    const job: MachineSetupJob = {
      id: jobId,
      workflow: plan.workflow,
      itemIds: plan.itemIds,
      state: 'running',
      startedAt: new Date().toISOString(),
      steps: plan.steps.map((step) => ({ itemId: step.itemId, state: 'pending', detail: step.label })),
      outcome: '',
    };
    this.#jobs.set(jobId, job);
    this.#onEvent({ jobId, kind: 'state', state: 'installing', job });
    this.#onEvent({ jobId, kind: 'plan', data: plan.steps.map((step) => `${step.label}\n  $ ${step.command}`).join('\n'), job });
    void this.#run(job, plan, controller.signal).catch((error) => {
      this.#finish(job, 'failed', `Setup stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
    });
    return job;
  }

  async #run(job: MachineSetupJob, plan: MachineSetupPlan, signal: AbortSignal) {
    const steps = [...job.steps];
    let manualPending: string[] = [];
    for (const [index, step] of plan.steps.entries()) {
      if (signal.aborted) { this.#finish(job, 'canceled', 'Setup was canceled before it finished.'); return; }
      // Re-check just this item so "already satisfied" is measured, not assumed.
      const report = await checkMachineSetup(this.#context);
      const item = report.groups.flatMap((group) => group.items).find((entry) => entry.id === step.itemId);
      if (item && (item.state === 'installed' || item.state === 'verified')) {
        steps[index] = { ...steps[index], state: 'skipped', detail: `${step.label} — already satisfied.` };
        this.#publish(job, steps, step.itemId);
        this.#onEvent({ jobId: job.id, itemId: step.itemId, kind: 'output', data: `\n✔ ${step.label} is already satisfied; skipping.\n`, job });
        continue;
      }
      if (item?.manual || (step.interactive && /^MANUAL:/.test(step.command))) {
        const instruction = item?.recovery ?? step.label;
        steps[index] = { ...steps[index], state: 'waiting-for-user', detail: instruction };
        manualPending = [...manualPending, instruction];
        this.#publish(job, steps, step.itemId);
        this.#onEvent({ jobId: job.id, itemId: step.itemId, kind: 'state', state: 'waiting-for-user', job });
        this.#onEvent({ jobId: job.id, itemId: step.itemId, kind: 'output', data: `\n→ Needs you: ${instruction}\n`, job });
        continue;
      }
      steps[index] = { ...steps[index], state: 'running', detail: step.label };
      this.#publish(job, steps, step.itemId);
      this.#onEvent({ jobId: job.id, itemId: step.itemId, kind: 'state', state: 'installing', job });
      if (step.interactive && !/^MANUAL:/.test(step.command)) {
        const launched = openInTerminal(step.command, step.label);
        const launch = await runStreamingCommand({ command: launched, signal, onData: () => undefined });
        this.#onEvent({ jobId: job.id, itemId: step.itemId, kind: 'output', data: `\nOpened Terminal for: ${step.label}. Finish the prompts there, then re-check.\n`, job });
        if (launch.canceled) { this.#finish(job, 'canceled', 'Setup was canceled.'); return; }
        steps[index] = { ...steps[index], state: 'waiting-for-user', detail: `${step.label} runs in Terminal.` };
        manualPending = [...manualPending, `${step.label}: finish the prompts in Terminal, then re-check.`];
        this.#publish(job, steps, step.itemId);
        continue;
      }
      const result = await runStreamingCommand({
        command: step.command,
        signal,
        onData: (chunk) => this.#onEvent({ jobId: job.id, itemId: step.itemId, kind: 'output', data: chunk, job }),
      });
      if (result.canceled) { this.#finish(job, 'canceled', 'Setup was canceled; finished steps are kept.'); return; }
      const after = await checkMachineSetup(this.#context);
      const verified = after.groups.flatMap((group) => group.items).find((entry) => entry.id === step.itemId);
      const satisfied = Boolean(verified && (verified.state === 'installed' || verified.state === 'verified'));
      steps[index] = {
        ...steps[index],
        state: satisfied ? 'succeeded' : 'failed',
        detail: satisfied ? `${step.label} verified by a fresh check.` : `${step.label} finished but the fresh check still reports ${verified?.state ?? 'unknown'}.`,
      };
      this.#publish(job, steps, step.itemId);
      if (!satisfied) {
        this.#onEvent({ jobId: job.id, itemId: step.itemId, kind: 'state', state: 'failed', job });
      }
    }
    const report = await checkMachineSetup(this.#context);
    this.#report = report;
    const stillMissing = report.groups.flatMap((group) => group.items)
      .filter((entry) => plan.itemIds.includes(entry.id) && !['installed', 'verified', 'unsupported'].includes(entry.state));
    if (stillMissing.length === 0) this.#finish(job, 'completed', 'Every requested item is installed and verified by a fresh check.');
    else if (manualPending.length) this.#finish(job, 'waiting-for-user', `Waiting on you: ${manualPending.join(' ')}`);
    else this.#finish(job, 'failed', `Still incomplete: ${stillMissing.map((entry) => entry.label).join(', ')}.`);
  }

  #publish(job: MachineSetupJob, steps: MachineSetupJob['steps'], currentItemId: string) {
    const next: MachineSetupJob = { ...job, steps, currentItemId };
    this.#jobs.set(job.id, next);
    this.#onEvent({ jobId: job.id, itemId: currentItemId, kind: 'state', job: next });
    void this.#persist();
  }

  #finish(job: MachineSetupJob, state: MachineSetupJob['state'], outcome: string) {
    const next: MachineSetupJob = { ...this.#jobs.get(job.id) ?? job, state, outcome, finishedAt: new Date().toISOString(), currentItemId: undefined };
    this.#jobs.set(job.id, next);
    this.#controllers.delete(job.id);
    this.#onEvent({ jobId: job.id, kind: 'done', job: next });
    void this.#persist();
  }

  async #persist() {
    try {
      await mkdir(path.dirname(this.#journalPath), { recursive: true });
      await writeFile(this.#journalPath, JSON.stringify([...this.#jobs.values()].slice(-40).map((job) => ({ job })), null, 2));
    } catch { /* journaling is best effort; jobs stay in memory */ }
  }
}

/** Human-readable label for a state, used by logs and evidence records. */
export function describeSetupState(state: MachineSetupState): string {
  switch (state) {
    case 'checking': return 'Checking';
    case 'missing': return 'Missing';
    case 'incompatible': return 'Incompatible';
    case 'installing': return 'Installing';
    case 'waiting-for-user': return 'Waiting for you';
    case 'failed': return 'Failed';
    case 'canceled': return 'Canceled';
    case 'installed': return 'Installed';
    case 'verified': return 'Verified';
    case 'unsupported': return 'Not supported here';
  }
}
