import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isSafeRelativePath, type ApplicationPatchLink, type PlaywrightDraftProvenance, type PlaywrightDraftRuntime, type FailureAnalysis, type ManagedTestFixProposal, type PlaywrightDraftFile, type PlaywrightGenerationDraft, type PortableWebTestBundle, type SavedWebRun, type SavedWebTestAttempt, type SavedWebTestVersion } from '@sayspec/contracts';
import { validatePlaywrightCandidate, type PlaywrightValidationResult } from '../generation/playwright-validation.ts';
import { createManagedTestFixProposal, proposalContentHash } from './managed-test-fix.ts';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_BUNDLE_BYTES = 1024 * 1024;
const RESERVED = new Set(['node_modules', 'test-results', 'result.json', 'playwright.config.cjs', 'runner.log']);
const CREDENTIAL = /(?:password|secret|api[_-]?key|authorization)\s*[:=]\s*['\"][^'\"]+['\"]|https?:\/\/[^\s/@]+:[^\s/@]+@|Bearer\s+[A-Za-z0-9._~-]{12,}/i;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const contentHash = (value: Pick<SavedWebTestVersion, 'steps' | 'files' | 'runtime'>) => sha(canonical({ steps: value.steps, files: value.files, runtime: value.runtime }));

function checkedId(value: unknown, label: string) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function exactKeys(value: unknown, keys: readonly string[], label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} contains unsupported fields.`);
}

function checkedUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('A complete Web base URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /(?:token|secret|password|api[-_]?key)/i.test(url.search)) throw new Error('The Web base URL cannot contain credentials.');
  return url.href;
}

function checkedFiles(files: unknown): PlaywrightDraftFile[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > 16) throw new Error('Bundle files are missing or unbounded.');
  let total = 0; const paths = new Set<string>();
  return files.map((input) => {
    if (!input || typeof input !== 'object') throw new Error('Bundle file is invalid.');
    const file = input as PlaywrightDraftFile;
    exactKeys(file, ['id', 'relativePath', 'text', 'sha256', 'byteLength', 'mimeType'], 'Bundle file');
    if (typeof file.relativePath !== 'string' || !isSafeRelativePath(file.relativePath) || RESERVED.has(file.relativePath.split('/')[0]) || paths.has(file.relativePath)) throw new Error('Bundle file path is unsafe, reserved, or duplicated.');
    paths.add(file.relativePath);
    if (typeof file.text !== 'string' || !['text/typescript', 'application/json', 'text/markdown'].includes(file.mimeType) || typeof file.id !== 'string' || !ID.test(file.id)) throw new Error('Bundle file metadata is invalid.');
    const bytes = Buffer.byteLength(file.text); total += bytes;
    if (!bytes || bytes > 128 * 1024 || total > 512 * 1024 || file.byteLength !== bytes || file.sha256 !== sha(file.text)) throw new Error('Bundle file size or hash is invalid.');
    return structuredClone(file);
  });
}

export function validatePortableWebTestBundle(input: unknown): PortableWebTestBundle {
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_BUNDLE_BYTES) throw new Error('Portable bundle exceeds the 1 MiB budget.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Portable bundle is invalid.');
  const bundle = input as PortableWebTestBundle;
  exactKeys(bundle, ['schemaVersion', 'kind', 'exportedAt', 'original', 'title', 'steps', 'files', 'runtime', 'secretPlaceholders', 'provenance'], 'Portable bundle');
  exactKeys(bundle.original, ['testId', 'versionId', 'contentHash', 'state'], 'Portable bundle origin');
  exactKeys(bundle.runtime, ['framework', 'frameworkVersion', 'entrypoint', 'dependencies', 'requirements'], 'Portable runtime');
  exactKeys(bundle.provenance, ['provider', 'cliVersion', 'inputRevisionHash', 'generatedAt'], 'Portable provenance');
  if (bundle.schemaVersion !== 1 || bundle.kind !== 'sayspec-playwright-bundle' || typeof bundle.title !== 'string' || !bundle.title.trim() || bundle.title.length > 160 || !bundle.original || !SHA.test(bundle.original.contentHash)) throw new Error('Unsupported or invalid portable bundle schema.');
  if (!['generated', 'execution-validated', 'published'].includes(bundle.original.state) || Number.isNaN(Date.parse(bundle.exportedAt))) throw new Error('Portable bundle state or timestamp is invalid.');
  checkedId(bundle.original.testId, 'Original test ID'); checkedId(bundle.original.versionId, 'Original version ID');
  const files = checkedFiles(bundle.files);
  if (!bundle.runtime || bundle.runtime.framework !== 'playwright' || bundle.runtime.frameworkVersion !== '1.63.0' || bundle.runtime.dependencies?.['@playwright/test'] !== '1.63.0' || Object.keys(bundle.runtime.dependencies).length !== 1 || !files.some((file) => file.relativePath === bundle.runtime.entrypoint) || !bundle.runtime.entrypoint.endsWith('.spec.ts')) throw new Error('Portable bundle runtime or pinned dependencies are invalid.');
  if (!Array.isArray(bundle.runtime.requirements) || !bundle.runtime.requirements.includes('Node.js >=22.12.0') || !bundle.runtime.requirements.includes('Playwright Chromium installed') || !Array.isArray(bundle.secretPlaceholders) || JSON.stringify(bundle.secretPlaceholders) !== JSON.stringify(['BASE_URL'])) throw new Error('Portable bundle runtime requirements or secret placeholders are incomplete.');
  if (!Array.isArray(bundle.steps) || !bundle.steps.length || bundle.steps.length > 200 || bundle.steps.some((step) => !step?.assertion?.trim() || !step?.instruction?.trim())) throw new Error('Portable bundle intent is invalid.');
  for (const step of bundle.steps) exactKeys(step, ['id', 'instruction', 'assertion', 'intentItemIds', 'transcriptSegmentIds', 'evidenceEventIds'], 'Portable step');
  if (!bundle.provenance || !['claude-code', 'codex'].includes(bundle.provenance.provider) || !SHA.test(bundle.provenance.inputRevisionHash)) throw new Error('Portable bundle provenance is invalid.');
  const actual = contentHash({ steps: bundle.steps, files, runtime: bundle.runtime });
  if (actual !== bundle.original.contentHash) throw new Error('Portable bundle content hash is invalid.');
  return structuredClone(bundle);
}

type StoreIndex = { schemaVersion: 1; versions: SavedWebTestVersion[]; attempts: SavedWebTestAttempt[]; runs: SavedWebRun[]; analyses: FailureAnalysis[]; proposals: ManagedTestFixProposal[] };

export class SavedWebTestStore {
  readonly #root: string;
  readonly #validator: typeof validatePlaywrightCandidate;
  #index: StoreIndex = { schemaVersion: 1, versions: [], attempts: [], runs: [], analyses: [], proposals: [] };
  #write = Promise.resolve();
  readonly #running = new Map<string, AbortController>();
  readonly #runningRuns = new Map<string, { canceled: boolean; attemptId?: string }>();
  readonly #retrying = new Set<string>();

  constructor(root: string, validator: typeof validatePlaywrightCandidate = validatePlaywrightCandidate) { this.#root = path.resolve(root); this.#validator = validator; }

  async initialize() {
    await mkdir(this.#root, { recursive: true });
    try {
      const index = JSON.parse(await readFile(path.join(this.#root, 'index.json'), 'utf8')) as StoreIndex;
      if (index.schemaVersion !== 1 || !Array.isArray(index.versions) || !Array.isArray(index.attempts)) throw new Error('Saved test store schema is unsupported.');
      this.#index = { ...index, runs: Array.isArray(index.runs) ? index.runs : [], analyses: Array.isArray(index.analyses) ? index.analyses : [], proposals: Array.isArray(index.proposals) ? index.proposals : [] };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await this.#persist(); }
    let recovered = false;
    for (const attempt of this.#index.attempts) if (attempt.state === 'preparing' || attempt.state === 'running') {
      attempt.state = 'infrastructure-error'; attempt.finishedAt = new Date().toISOString(); attempt.summary = 'The local runner stopped before a final result was recorded.'; recovered = true;
    }
    for (const run of this.#index.runs) if (['queued', 'preparing', 'running'].includes(run.state)) {
      run.state = 'interrupted'; run.finishedAt = new Date().toISOString(); recovered = true;
    }
    if (recovered) await this.#persist();
  }

  async saveGenerated(testId: string, draft: PlaywrightGenerationDraft) {
    checkedId(testId, 'Test ID');
    if (draft.state !== 'draft' || draft.validation?.status !== 'passed' || !draft.provenance.executionValidated || draft.validation.passed < 1) throw new Error('Only a genuinely green generated test can be saved.');
    const files = checkedFiles(draft.files);
    const draftHash = contentHash({ steps: draft.steps, files, runtime: draft.runtime });
    const existing = this.#index.versions.find((item) => item.testId === testId && item.organizationId === draft.organizationId && item.projectId === draft.projectId && item.recordingId === draft.recordingId && item.contentHash === draftHash);
    if (existing) return structuredClone(existing);
    const previous = this.#index.versions.filter((item) => item.testId === testId && item.organizationId === draft.organizationId && item.projectId === draft.projectId);
    const version: SavedWebTestVersion = { schemaVersion: 1, id: `version_${randomUUID()}`, testId, organizationId: checkedId(draft.organizationId, 'Organization ID'), projectId: checkedId(draft.projectId, 'Project ID'), recordingId: checkedId(draft.recordingId, 'Recording ID'),
      version: previous.length + 1, title: draft.title, createdAt: new Date().toISOString(), state: 'execution-validated', steps: structuredClone(draft.steps), files, runtime: structuredClone(draft.runtime), provenance: structuredClone(draft.provenance), contentHash: draftHash };
    this.#index.versions.push(version); await this.#persist(); return structuredClone(version);
  }

  version(scope: { organizationId: string; projectId: string; testId: string; versionId: string }) {
    (['organizationId', 'projectId', 'testId', 'versionId'] as const).forEach((key) => checkedId(scope[key], key));
    const version = this.#index.versions.find((item) => item.id === scope.versionId && item.testId === scope.testId && item.organizationId === scope.organizationId && item.projectId === scope.projectId);
    if (!version) throw new Error('Saved test version was not found in this project.');
    return structuredClone(version);
  }

  versions(organizationId: string, projectId: string, testId: string) {
    [organizationId, projectId, testId].forEach((id) => checkedId(id, 'Scope ID'));
    return structuredClone(this.#index.versions.filter((item) => item.organizationId === organizationId && item.projectId === projectId && item.testId === testId));
  }

  versionsForRecording(organizationId: string, projectId: string, recordingId: string) {
    [organizationId, projectId, recordingId].forEach((id) => checkedId(id, 'Scope ID'));
    return structuredClone(this.#index.versions.filter((item) => item.organizationId === organizationId && item.projectId === projectId && item.recordingId === recordingId));
  }

  projectVersions(organizationId: string, projectId: string) {
    [organizationId, projectId].forEach((id) => checkedId(id, 'Scope ID'));
    return structuredClone(this.#index.versions.filter((item) => item.organizationId === organizationId && item.projectId === projectId));
  }

  attempts(organizationId: string, projectId: string, testId: string) {
    [organizationId, projectId, testId].forEach((id) => checkedId(id, 'Scope ID'));
    return structuredClone(this.#index.attempts.filter((item) => item.organizationId === organizationId && item.projectId === projectId && item.testId === testId));
  }

  failedAttempt(input: { organizationId: string; projectId: string; testId: string; attemptId: string }) {
    const attempt = this.attempts(input.organizationId, input.projectId, input.testId).find((item) => item.id === checkedId(input.attemptId, 'Attempt ID'));
    if (!attempt || !['failed', 'blocked', 'infrastructure-error'].includes(attempt.state) || !attempt.finishedAt) throw new Error('A finished failed attempt was not found in this project.');
    const version = this.version({ ...input, versionId: attempt.versionId });
    if (version.contentHash !== attempt.testVersionHash || version.contentHash !== contentHash(version)) throw new Error('The exact source version for this attempt failed integrity verification.');
    return { attempt, version };
  }

  failureAnalyses(input: { organizationId: string; projectId: string; testId: string; attemptId: string }) {
    this.failedAttempt(input);
    return structuredClone(this.#index.analyses.filter((item) => item.organizationId === input.organizationId && item.projectId === input.projectId && item.testId === input.testId && item.attemptId === input.attemptId));
  }

  async saveFailureAnalysis(analysis: FailureAnalysis) {
    const { attempt } = this.failedAttempt(analysis);
    if (analysis.versionId !== attempt.versionId || analysis.testVersionHash !== attempt.testVersionHash || this.#index.analyses.some((item) => item.id === analysis.id)) throw new Error('Analysis provenance is stale or duplicated.');
    this.#index.analyses.push(structuredClone(analysis)); await this.#persist(); return structuredClone(analysis);
  }

  fixProposals(input: { organizationId: string; projectId: string; testId?: string }) {
    checkedId(input.organizationId, 'Organization ID'); checkedId(input.projectId, 'Project ID');
    if (input.testId) checkedId(input.testId, 'Test ID');
    return structuredClone(this.#index.proposals.filter((item) => item.organizationId === input.organizationId && item.projectId === input.projectId && (!input.testId || item.testId === input.testId)));
  }

  async proposeManagedTestFix(input: { organizationId: string; projectId: string; testId: string; analysisId: string; changes: { relativePath: string; text: string }[]; rationale: string }) {
    const analysis = this.#index.analyses.find((item) => item.id === checkedId(input.analysisId, 'Analysis ID') && item.organizationId === input.organizationId && item.projectId === input.projectId && item.testId === input.testId);
    if (!analysis) throw new Error('The failure analysis was not found in this project.');
    const { version } = this.failedAttempt(analysis);
    const proposal = createManagedTestFixProposal({ version, analysis, changes: input.changes, rationale: input.rationale });
    this.#index.proposals.push(proposal); await this.#persist(); return structuredClone(proposal);
  }

  async decideManagedTestFix(input: { organizationId: string; projectId: string; testId: string; proposalId: string; actorUid: string; kind: 'approve' | 'reject' }) {
    const proposal = this.#fixProposal(input);
    checkedId(input.actorUid, 'Actor ID');
    if (!['approve', 'reject'].includes(input.kind)) throw new Error('Fix decision is invalid.');
    if (proposal.proposalHash !== proposalContentHash(proposal)) throw new Error('The proposal changed since it was created.');
    if (proposal.status === 'approved' && input.kind === 'approve' && proposal.decision?.actorUid === input.actorUid) return structuredClone(proposal);
    if (proposal.status !== 'proposed') throw new Error('This proposal already has a decision.');
    proposal.status = input.kind === 'approve' ? 'approved' : 'rejected';
    proposal.decision = { actorUid: input.actorUid, decidedAt: new Date().toISOString(), proposalHash: proposal.proposalHash, baseContentHash: proposal.baseContentHash, kind: input.kind };
    await this.#persist(); return structuredClone(proposal);
  }

  async applyManagedTestFix(input: { organizationId: string; projectId: string; testId: string; proposalId: string; actorUid: string }) {
    const proposal = this.#fixProposal(input);
    checkedId(input.actorUid, 'Actor ID');
    if (proposal.status === 'applied' && proposal.appliedVersionId) {
      if (proposal.decision?.actorUid !== input.actorUid || proposal.decision.kind !== 'approve' || proposal.proposalHash !== proposalContentHash(proposal)) throw new Error('An intact, authorized approval is required to read this apply receipt.');
      return this.version({ ...input, versionId: proposal.appliedVersionId });
    }
    if (proposal.status !== 'approved' || proposal.decision?.kind !== 'approve' || proposal.decision.actorUid !== input.actorUid || proposal.decision.proposalHash !== proposal.proposalHash || proposal.decision.baseContentHash !== proposal.baseContentHash || proposal.proposalHash !== proposalContentHash(proposal)) throw new Error('An intact, authorized approval is required to apply this fix.');
    const base = this.version({ ...input, versionId: proposal.baseVersionId });
    const versions = this.projectVersions(input.organizationId, input.projectId).filter((item) => item.testId === input.testId).sort((a, b) => b.version - a.version);
    if (versions[0]?.id !== base.id || base.contentHash !== proposal.baseContentHash || base.contentHash !== contentHash(base)) throw new Error('The saved test changed since this proposal was reviewed.');
    const changes = new Map(proposal.fileChanges.map((change) => [change.relativePath, change]));
    if (changes.size !== proposal.fileChanges.length) throw new Error('The proposal contains duplicate file changes.');
    const files = checkedFiles(base.files.map((file) => {
      const change = changes.get(file.relativePath); if (!change) return file;
      if (change.baseSha256 !== file.sha256 || change.proposedSha256 !== sha(change.proposedText)) throw new Error('A proposed file failed hash verification.');
      return { ...file, text: change.proposedText, sha256: change.proposedSha256, byteLength: Buffer.byteLength(change.proposedText) };
    }));
    if (changes.size > files.length || [...changes.keys()].some((relativePath) => !files.some((file) => file.relativePath === relativePath))) throw new Error('The proposal escaped managed test scope.');
    const version: SavedWebTestVersion = { ...structuredClone(base), id: `version_${randomUUID()}`, version: versions[0].version + 1, createdAt: new Date().toISOString(), state: 'generated', files,
      contentHash: contentHash({ ...base, files }), provenance: { ...base.provenance, executionValidated: false, published: false } };
    this.#index.versions.push(version); proposal.status = 'applied'; proposal.appliedVersionId = version.id;
    await this.#persist(); return structuredClone(version);
  }

  #fixProposal(input: { organizationId: string; projectId: string; testId: string; proposalId: string }) {
    [input.organizationId, input.projectId, input.testId, input.proposalId].forEach((id) => checkedId(id, 'Fix scope ID'));
    const proposal = this.#index.proposals.find((item) => item.id === input.proposalId && item.organizationId === input.organizationId && item.projectId === input.projectId && item.testId === input.testId);
    if (!proposal) throw new Error('Fix proposal was not found in this project.');
    return proposal;
  }

  async readArtifact(input: { organizationId: string; projectId: string; testId: string; attemptId: string; relativePath: string }) {
    [input.organizationId, input.projectId, input.testId, input.attemptId].forEach((id) => checkedId(id, 'Scope ID'));
    if (!isSafeRelativePath(input.relativePath)) throw new Error('Artifact path is unsafe.');
    const attempt = this.#index.attempts.find((item) => item.id === input.attemptId && item.organizationId === input.organizationId && item.projectId === input.projectId && item.testId === input.testId);
    const artifact = attempt?.artifacts.find((item) => item.relativePath === input.relativePath);
    if (!artifact || artifact.byteLength > 32 * 1024 * 1024) throw new Error('Attempt artifact was not found.');
    const bytes = await readFile(path.join(this.#root, 'attempts', attempt!.id, 'artifacts', artifact.relativePath));
    if (bytes.byteLength !== artifact.byteLength || sha(bytes) !== artifact.sha256) throw new Error('Attempt artifact failed integrity verification.');
    return { bytes, mimeType: artifact.mimeType };
  }

  async run(input: { organizationId: string; projectId: string; testId: string; versionId: string; baseUrl: string }, applicationPatch?: ApplicationPatchLink, verifyApplicationRuntime?: () => Promise<unknown>) {
    const version = this.version(input);
    const prior = applicationPatch ? this.#index.runs.find((run) => run.organizationId === input.organizationId && run.projectId === input.projectId && run.items.some((item) => item.testId === input.testId && item.versionId === input.versionId && item.attemptIds.includes(applicationPatch.originatingAttemptId))) : undefined;
    const item = prior?.items.find((entry) => entry.testId === input.testId && entry.versionId === input.versionId && entry.attemptIds.includes(applicationPatch!.originatingAttemptId));
    return this.#runVersion(version, input.baseUrl, item ? (attemptId) => { item.attemptIds.push(attemptId); } : undefined, false, applicationPatch, verifyApplicationRuntime);
  }

  listRuns(organizationId: string, projectId: string) {
    checkedId(organizationId, 'Organization ID'); checkedId(projectId, 'Project ID');
    return structuredClone(this.#index.runs.filter((run) => run.organizationId === organizationId && run.projectId === projectId));
  }

  async createRun(input: { organizationId: string; projectId: string; name: string; baseUrl: string; testIds: string[]; suiteId?: string }) {
    checkedId(input.organizationId, 'Organization ID'); checkedId(input.projectId, 'Project ID');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || !Array.isArray(input.testIds) || !input.testIds.length || input.testIds.length > 100 || new Set(input.testIds).size !== input.testIds.length) throw new Error('Run requires a name and 1–100 unique tests.');
    input.testIds.forEach((id) => checkedId(id, 'Test ID'));
    if (input.suiteId) checkedId(input.suiteId, 'Suite ID');
    const baseUrl = checkedUrl(input.baseUrl);
    const versions = input.testIds.map((testId) => {
      const candidates = this.projectVersions(input.organizationId, input.projectId).filter((version) => version.testId === testId).sort((a, b) => b.version - a.version);
      const version = candidates[0];
      if (!version || version.contentHash !== contentHash(version)) throw new Error(`Test ${testId} has no intact saved version on this machine.`);
      return version;
    });
    const run: SavedWebRun = { schemaVersion: 1, id: `run_${randomUUID()}`, organizationId: input.organizationId, projectId: input.projectId, name: input.name.trim(), ...(input.suiteId ? { suiteId: input.suiteId } : {}), state: 'queued', createdAt: new Date().toISOString(), baseUrl, environmentHash: sha(canonical({ baseUrl, versions: versions.map((version) => ({ framework: version.runtime.framework, frameworkVersion: version.runtime.frameworkVersion, dependencies: version.runtime.dependencies })) })), runner: 'desktop-local', showBrowser: false, items: versions.map((version) => ({ testId: version.testId, versionId: version.id, title: version.title, contentHash: version.contentHash, version: structuredClone(version), attemptIds: [] })) };
    this.#index.runs.push(run); await this.#persist();
    return structuredClone(run);
  }

  async startRun(input: { organizationId: string; projectId: string; runId: string; showBrowser?: boolean }) {
    const run = this.#findRun(input);
    if (run.state !== 'queued') throw new Error('Only a queued test run can be started.');
    run.showBrowser = input.showBrowser ?? run.showBrowser ?? false;
    await this.#persist();
    const control = { canceled: false, attemptId: undefined as string | undefined };
    this.#runningRuns.set(run.id, control);
    void this.#executeRun(run, control).catch(async () => {
      run.state = 'interrupted'; run.finishedAt = new Date().toISOString(); this.#runningRuns.delete(run.id); await this.#persist();
    });
    return structuredClone(run);
  }

  async #executeRun(run: SavedWebRun, control: { canceled: boolean; attemptId?: string }) {
    try {
      run.state = 'preparing'; await this.#persist();
      for (const item of run.items) {
        if (control.canceled) break;
        run.state = 'running'; await this.#persist();
        const attempt = await this.#runVersion(item.version, run.baseUrl, (id) => { control.attemptId = id; item.attemptIds.push(id); }, run.showBrowser === true);
        control.attemptId = undefined;
        if (attempt.state === 'canceled') { control.canceled = true; break; }
      }
      run.state = control.canceled ? 'canceled' : 'completed'; run.finishedAt = new Date().toISOString(); await this.#persist();
    } finally { this.#runningRuns.delete(run.id); }
  }

  async retryRunItem(input: { organizationId: string; projectId: string; runId: string; testId: string }) {
    const run = this.#findRun(input); const item = run.items.find((value) => value.testId === input.testId);
    if (!item || !['completed', 'canceled', 'interrupted'].includes(run.state) || !item.attemptIds.length) throw new Error('Only an attempted item in a finished run can be retried.');
    const key = `${run.id}:${item.testId}`;
    if (this.#retrying.has(key)) throw new Error('This run item is already retrying.');
    this.#retrying.add(key);
    try { const attempt = await this.#runVersion(item.version, run.baseUrl, (id) => { item.attemptIds.push(id); }, run.showBrowser === true); await this.#persist(); return attempt; }
    finally { this.#retrying.delete(key); }
  }

  cancelRun(input: { organizationId: string; projectId: string; runId: string }) {
    this.#findRun(input);
    const control = this.#runningRuns.get(input.runId);
    if (control) { control.canceled = true; if (control.attemptId) this.cancel(control.attemptId); }
  }

  #findRun(input: { organizationId: string; projectId: string; runId: string }) {
    checkedId(input.organizationId, 'Organization ID'); checkedId(input.projectId, 'Project ID'); checkedId(input.runId, 'Run ID');
    const run = this.#index.runs.find((item) => item.id === input.runId && item.organizationId === input.organizationId && item.projectId === input.projectId);
    if (!run) throw new Error('Run was not found in this project.'); return run;
  }

  async #runVersion(version: SavedWebTestVersion, requestedBaseUrl: string, onStarted?: (attemptId: string) => void, headed = false, applicationPatch?: ApplicationPatchLink, verifyApplicationRuntime?: () => Promise<unknown>) {
    if (version.contentHash !== contentHash(version)) throw new Error('Saved test version failed integrity verification.');
    const files = checkedFiles(version.files);
    let baseUrl = ''; let preflightError = '';
    try { baseUrl = checkedUrl(requestedBaseUrl); } catch (error) { preflightError = error instanceof Error ? error.message : String(error); }
    const environmentHash = sha(canonical({ baseUrl: baseUrl || '<unconfigured>', framework: version.runtime.framework, frameworkVersion: version.runtime.frameworkVersion, dependencies: version.runtime.dependencies, secretPlaceholders: ['BASE_URL'] }));
    const executionManifestHash = sha(canonical({ versionHash: version.contentHash, environmentHash, runner: 'desktop-local-playwright-v1' }));
    const id = `attempt_${randomUUID()}`; const controller = new AbortController(); this.#running.set(id, controller);
    const attempt: SavedWebTestAttempt = { schemaVersion: 1, id, versionId: version.id, testId: version.testId, organizationId: version.organizationId, projectId: version.projectId,
      testVersionHash: version.contentHash, environmentHash, executionManifestHash, ...(baseUrl ? { baseUrl } : {}), state: 'preparing', startedAt: new Date().toISOString(), summary: 'Preparing saved Playwright source.', passed: 0, failed: 0, skipped: 0, detail: '', tests: [], artifacts: [], runner: 'desktop-local', ...(applicationPatch ? { applicationPatch: structuredClone(applicationPatch) } : {}) };
    this.#index.attempts.push(attempt); onStarted?.(id); await this.#persist();
    if (preflightError) {
      attempt.state = 'blocked'; attempt.summary = 'The saved test cannot run until its environment is configured.'; attempt.detail = preflightError; attempt.finishedAt = new Date().toISOString();
      this.#running.delete(id); await this.#persist(); return structuredClone(attempt);
    }
    try {
      attempt.state = 'running'; attempt.summary = 'Executing saved Playwright source without generation.'; await this.#persist();
      const artifactDirectory = path.join(this.#root, 'attempts', id, 'artifacts');
      const result: PlaywrightValidationResult = await this.#validator({ files, entrypoint: version.runtime.entrypoint, baseUrl, headed, signal: controller.signal, artifactDirectory });
      attempt.state = result.status; attempt.summary = result.summary; attempt.passed = result.passed; attempt.failed = result.failed; attempt.skipped = result.skipped ?? 0;
      attempt.detail = result.detail; attempt.tests = result.tests ?? []; attempt.artifacts = result.artifacts ?? []; attempt.exitCode = result.exitCode; attempt.durationMs = result.durationMs;
      if (verifyApplicationRuntime) await verifyApplicationRuntime();
    } catch (error) {
      attempt.state = controller.signal.aborted ? 'canceled' : 'infrastructure-error'; attempt.summary = controller.signal.aborted ? 'Saved test run canceled.' : 'The local runner could not complete.'; attempt.detail = error instanceof Error ? error.message : String(error);
    } finally {
      if (attempt.state === 'passed' && version.state === 'generated') {
        const saved = this.#index.versions.find((item) => item.id === version.id);
        if (saved) saved.state = 'execution-validated';
      }
      attempt.finishedAt = new Date().toISOString(); this.#running.delete(id); await this.#persist();
    }
    return structuredClone(attempt);
  }

  cancel(attemptId: string) { checkedId(attemptId, 'Attempt ID'); this.#running.get(attemptId)?.abort(); }
  async shutdown() { for (const control of this.#runningRuns.values()) control.canceled = true; for (const controller of this.#running.values()) controller.abort(); }

  async publish(input: { organizationId: string; projectId: string; testId: string; versionId: string; approved: true }) {
    if (input.approved !== true) throw new Error('Publication requires an explicit reviewer approval.');
    const version = this.version(input);
    if (version.state !== 'execution-validated' || !this.#index.attempts.some((attempt) => attempt.versionId === version.id && attempt.testVersionHash === version.contentHash && attempt.state === 'passed')) throw new Error('Only a version with a retained passing attempt can be published.');
    const saved = this.#index.versions.find((item) => item.id === version.id)!;
    saved.state = 'published'; await this.#persist(); return structuredClone(saved);
  }

  export(input: { organizationId: string; projectId: string; testId: string; versionId: string }): PortableWebTestBundle {
    const version = this.version(input);
    if (version.contentHash !== contentHash(version)) throw new Error('Saved test version failed integrity verification.');
    if (version.files.some((file) => CREDENTIAL.test(file.text)) || version.steps.some((step) => CREDENTIAL.test(`${step.instruction}\n${step.assertion}`))) throw new Error('Source or intent appears to contain a credential. Replace it with a placeholder before export.');
    return validatePortableWebTestBundle({ schemaVersion: 1, kind: 'sayspec-playwright-bundle', exportedAt: new Date().toISOString(), original: { testId: version.testId, versionId: version.id, contentHash: version.contentHash, state: version.state },
      title: version.title, steps: version.steps, files: version.files, runtime: version.runtime, secretPlaceholders: ['BASE_URL'],
      provenance: { provider: version.provenance.provider, cliVersion: version.provenance.cliVersion, inputRevisionHash: version.provenance.inputRevisionHash, generatedAt: version.provenance.generatedAt } });
  }

  previewImport(input: unknown) {
    const bundle = validatePortableWebTestBundle(input);
    return { title: bundle.title, fileCount: bundle.files.length, contentHash: bundle.original.contentHash, requirements: bundle.runtime.requirements };
  }

  async import(organizationId: string, projectId: string, input: unknown, requestedTestId?: string) {
    checkedId(organizationId, 'Organization ID'); checkedId(projectId, 'Project ID');
    const bundle = validatePortableWebTestBundle(input);
    const testId = requestedTestId ? checkedId(requestedTestId, 'Test ID') : `import_${randomUUID()}`;
    if (this.#index.versions.some((item) => item.organizationId === organizationId && item.projectId === projectId && item.testId === testId)) throw new Error('An existing test cannot be overwritten by import.');
    const version: SavedWebTestVersion = { schemaVersion: 1, id: `version_${randomUUID()}`, testId, organizationId, projectId, version: 1,
      title: bundle.title, createdAt: new Date().toISOString(), state: 'generated', contentHash: bundle.original.contentHash,
      steps: bundle.steps, files: bundle.files, runtime: bundle.runtime,
      provenance: { ...bundle.provenance, recordingId: `import_${randomUUID()}`, selectedEvidenceEventIds: [], executionValidated: false, published: false } };
    this.#index.versions.push(version); await this.#persist(); return structuredClone(version);
  }

  /**
   * Makes the source read from a storage folder the latest version of a test,
   * so runs, fixes and agents use exactly what is in the folder. Unchanged
   * source returns the current version; a changed file (a hand edit or a
   * teammate's commit) becomes a new, not yet validated version.
   */
  async saveFolderVersion(input: { organizationId: string; projectId: string; testId: string; title: string; recordingId?: string; entrypoint: string; files: readonly { relativePath: string; text: string }[]; steps: readonly { instruction: string; assertion: string }[]; runtime?: PlaywrightDraftRuntime; provenance?: PlaywrightDraftProvenance }) {
    [input.organizationId, input.projectId, input.testId].forEach((id) => checkedId(id, 'Scope ID'));
    if (!input.entrypoint.endsWith('.spec.ts') || !input.files.some((file) => file.relativePath === input.entrypoint)) throw new Error('A Playwright test needs a .spec.ts entry file.');
    const latest = this.versions(input.organizationId, input.projectId, input.testId).sort((left, right) => right.version - left.version)[0];
    const files = checkedFiles(input.files.map((file, index) => ({
      id: latest?.files.find((item) => item.relativePath === file.relativePath)?.id ?? `file_${index + 1}`,
      relativePath: file.relativePath, text: file.text, sha256: sha(file.text), byteLength: Buffer.byteLength(file.text),
      mimeType: file.relativePath.endsWith('.json') ? 'application/json' : file.relativePath.endsWith('.md') ? 'text/markdown' : 'text/typescript',
    })));
    const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();
    const sameSteps = latest && latest.steps.length === input.steps.length && latest.steps.every((step, index) => oneLine(step.instruction) === oneLine(input.steps[index].instruction) && oneLine(step.assertion) === oneLine(input.steps[index].assertion));
    const steps = sameSteps ? latest.steps : input.steps.map((step, index) => ({ id: `step_${index + 1}`, instruction: step.instruction, assertion: step.assertion, intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }));
    const runtime = latest ? { ...latest.runtime, entrypoint: input.entrypoint } : input.runtime ? { ...input.runtime, entrypoint: input.entrypoint }
      : { framework: 'playwright' as const, frameworkVersion: '1.63.0' as const, entrypoint: input.entrypoint, dependencies: { '@playwright/test': '1.63.0' }, requirements: ['Node.js >=22.12.0', 'Playwright Chromium installed'] };
    const hash = contentHash({ steps, files, runtime });
    if (latest?.contentHash === hash) return structuredClone(latest);
    const version: SavedWebTestVersion = { schemaVersion: 1, id: `version_${randomUUID()}`, testId: input.testId, organizationId: input.organizationId, projectId: input.projectId,
      ...(input.recordingId && ID.test(input.recordingId) ? { recordingId: input.recordingId } : {}),
      version: (latest?.version ?? 0) + 1, title: input.title.slice(0, 160) || 'Untitled test', createdAt: new Date().toISOString(), state: 'generated', steps: structuredClone(steps), files, runtime, contentHash: hash,
      provenance: latest ? { ...latest.provenance, executionValidated: false, published: false }
        : input.provenance ? { ...input.provenance, executionValidated: false, published: false }
        : { provider: 'claude-code', cliVersion: 'storage-folder', generatedAt: new Date().toISOString(), inputRevisionHash: sha(canonical(files)), recordingId: input.recordingId ?? `folder_${input.testId}`, selectedEvidenceEventIds: [], executionValidated: false, published: false } };
    this.#index.versions.push(version); await this.#persist(); return structuredClone(version);
  }

  async #persist() {
    const serialized = `${JSON.stringify(this.#index, null, 2)}\n`;
    this.#write = this.#write.then(async () => {
      const temporary = path.join(this.#root, 'index.json.tmp');
      await writeFile(temporary, serialized, { mode: 0o600 }); await rename(temporary, path.join(this.#root, 'index.json'));
    });
    await this.#write;
  }
}
