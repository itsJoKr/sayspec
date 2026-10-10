import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isSafeRelativePath, type ApplicationFixProposal, type ApplicationFixReceipt, type FailureAnalysis } from '@sayspec/contracts';
import { DirectoryHandleRegistry } from '../jobs/directory-handles.ts';

const run = promisify(execFile);
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/;
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|dart|html|css|scss|json|yaml|yml)$/i;
const FORBIDDEN_PART = /^(?:\.git|\.env(?:\..*)?|node_modules|build|dist|\.dart_tool|\.gradle|\.idea|\.fvm|coverage|release|vendor|tmp|temp|secrets?|credentials?|keys?|test|tests|__tests__|integration_test|patrol_test|e2e)$/i;
const TEST_FILE = /(?:^|\/)(?:.*(?:\.test|\.spec|_test)\.(?:[cm]?[jt]sx?|dart)|(?:playwright|patrol)\.config\.[^/]+)$/i;
const SOURCE_CREDENTIAL = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:password|secret|api[_-]?key|authorization|auth[_-]?token|aws_secret_access_key|private_key|current_key|client_secret)\s*[:=]\s*['"][^'"]{4,}['"]|Bearer\s+[A-Za-z0-9._~-]{12,}/i;
const MAX_CONTEXT_FILES = 32;
const MAX_CONTEXT_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024;

export function applicationProposalHash(value: ApplicationFixProposal) {
  return sha(JSON.stringify({ organizationId: value.organizationId, projectId: value.projectId, testId: value.testId, attemptId: value.attemptId, analysisId: value.analysisId, target: value.target, testVersionId: value.testVersionId, testVersionHash: value.testVersionHash, sourceRootHash: value.sourceRootHash, sourceRevision: value.sourceRevision ?? null, rationale: value.rationale, evidenceIds: value.evidenceIds, fileChanges: value.fileChanges, changedPaths: value.changedPaths, reviewFlags: value.reviewFlags, diff: value.diff }));
}

export function applicationSourcePathAllowed(relativePath: string) {
  const parts = relativePath.split('/');
  return isSafeRelativePath(relativePath) && SOURCE_EXT.test(relativePath) && !parts.some((part) => FORBIDDEN_PART.test(part) || part.startsWith('.')) && !TEST_FILE.test(relativePath) && !/(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|pubspec\.lock|google-services\.json|GoogleService-Info\.plist|firebase-adminsdk[^/]*\.json|service-account[^/]*\.json)$/i.test(relativePath);
}

async function readSource(handles: DirectoryHandleRegistry, handle: string, relativePath: string) {
  if (!applicationSourcePathAllowed(relativePath)) throw new Error(`${relativePath} is not an application source path. Managed-test changes need a separate test proposal.`);
  await assertNoSourceLinks(handles, handle, relativePath);
  const absolute = await handles.resolve(handle, relativePath, { maxBytes: MAX_FILE_BYTES });
  const bytes = await readFile(absolute);
  if (!bytes.length || bytes.byteLength > MAX_FILE_BYTES || bytes.includes(0)) throw new Error(`${relativePath} is empty, binary or over the source budget.`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (SOURCE_CREDENTIAL.test(text)) throw new Error(`${relativePath} appears to contain a credential and cannot enter application fix context.`);
  return { text, sha256: sha(bytes) };
}

async function assertNoSourceLinks(handles: DirectoryHandleRegistry, handle: string, relativePath: string) {
  let cursor = handles.root(handle);
  for (const part of relativePath.split('/')) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error('Application source path contains a symbolic link.');
  }
}

export async function selectedSourceIdentity(handles: DirectoryHandleRegistry, handle: string) {
  const root = handles.root(handle);
  if (await realpath(root) !== root) throw new Error('The selected source folder moved or changed. Select it again.');
  const identity = await stat(root);
  if (!identity.isDirectory()) throw new Error('The selected source folder is no longer a directory.');
  return { root, rootHash: sha(`${root}:${identity.dev}:${identity.ino}`) };
}

export async function sourceRevision(root: string) {
  try {
    const { stdout } = await run('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { timeout: 3_000 });
    return /^[a-f0-9]{40,64}$/.test(stdout.trim()) ? stdout.trim() : undefined;
  } catch { return undefined; }
}

/** A bounded source view for the existing interactive PTY; excludes tests, secrets and build products. */
export async function stageApplicationContext(handles: DirectoryHandleRegistry, handle: string, analysis: FailureAnalysis) {
  const { root, rootHash } = await selectedSourceIdentity(handles, handle);
  const candidates: string[] = [];
  async function walk(directory: string, relative = '', depth = 0) {
    if (depth > 6 || candidates.length > 240) return;
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || FORBIDDEN_PART.test(entry.name) || entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), next, depth + 1);
      else if (entry.isFile() && applicationSourcePathAllowed(next)) candidates.push(next);
    }
  }
  await walk(root);
  const cited = analysis.evidence.map((item) => item.text).join('\n');
  const ordered = candidates.sort((left, right) => {
    const score = (value: string) => (cited.includes(value) ? 100 : 0) + (/^(?:lib|src|app)\//.test(value) ? 10 : 0) + (/^(?:package\.json|pubspec\.yaml|vite\.config\.)/.test(value) ? 5 : 0) - value.split('/').length;
    return score(right) - score(left) || left.localeCompare(right);
  });
  const files: { relativePath: string; text: string; sha256: string }[] = [];
  let bytes = 0;
  for (const relativePath of ordered) {
    if (files.length >= MAX_CONTEXT_FILES) break;
    try {
      const file = await readSource(handles, handle, relativePath);
      const size = Buffer.byteLength(file.text);
      if (bytes + size > MAX_CONTEXT_BYTES) continue;
      files.push({ relativePath, ...file }); bytes += size;
    } catch { /* skipped unsafe, binary or oversized source */ }
  }
  if (!files.length) throw new Error('No safe application source files were found in the selected folder. URL-only projects can still run tests.');
  return { rootHash, sourceRevision: await sourceRevision(root), files };
}

function unifiedDiff(relativePath: string, before: string, after: string) {
  const a = before.split('\n'); const b = after.split('\n');
  let first = 0; while (first < a.length && first < b.length && a[first] === b[first]) first++;
  let tail = 0; while (tail < a.length - first && tail < b.length - first && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return [`--- a/${relativePath}`, `+++ b/${relativePath}`, `@@ -${first + 1},${a.length - first - tail} +${first + 1},${b.length - first - tail} @@`, ...a.slice(Math.max(0, first - 2), first).map((line) => ` ${line}`), ...a.slice(first, a.length - tail).map((line) => `-${line}`), ...b.slice(first, b.length - tail).map((line) => `+${line}`), ...a.slice(a.length - tail, a.length - tail + Math.min(2, tail)).map((line) => ` ${line}`)].join('\n');
}

function importedPackages(value: string) {
  return new Set([...value.matchAll(/(?:from\s+|require\s*\(|import\s+['"]|package:)(?:['"])?([@a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)/g)].map((item) => item[1]));
}

type ApplicationJournal = { proposalId: string; receipt: ApplicationFixReceipt; state: 'writing' | 'applied' | 'rolled-back' | 'recovery-required'; completedPaths: string[]; error?: string };

export class ApplicationFixStore {
  readonly #path: string;
  readonly #journalPath: string;
  #items: ApplicationFixProposal[] = [];
  #journals: ApplicationJournal[] = [];
  readonly #applying = new Map<string, Promise<unknown>>();
  readonly #afterWrite?: (count: number) => Promise<void>;
  constructor(root: string, options: { afterWrite?: (count: number) => Promise<void> } = {}) { this.#path = path.join(root, 'proposals.json'); this.#journalPath = path.join(root, 'journals.json'); this.#afterWrite = options.afterWrite; }
  async initialize() { await mkdir(path.dirname(this.#path), { recursive: true }); this.#items = await readJsonOrEmpty<ApplicationFixProposal>(this.#path); this.#journals = await readJsonOrEmpty<ApplicationJournal>(this.#journalPath); }
  list(input: { organizationId: string; projectId: string; testId?: string }) {
    return structuredClone(this.#items.filter((item) => item.organizationId === input.organizationId && item.projectId === input.projectId && (!input.testId || item.testId === input.testId)));
  }
  get(input: { organizationId: string; projectId: string; testId: string; proposalId: string }) {
    const found = this.#items.find((item) => item.id === input.proposalId && item.organizationId === input.organizationId && item.projectId === input.projectId && item.testId === input.testId);
    if (!found) throw new Error('Application proposal was not found in this project.');
    return structuredClone(found);
  }
  receipt(input: { organizationId: string; projectId: string; testId: string; proposalId: string }) {
    this.get(input);
    const journal = this.#journals.find((item) => item.proposalId === input.proposalId && item.state === 'applied');
    return journal ? structuredClone(journal.receipt) : undefined;
  }
  async validateApplied(input: { organizationId: string; projectId: string; testId: string; proposalId: string; handles: DirectoryHandleRegistry; sourceHandle: string }) {
    const proposal = this.#item(input); this.#verifyProposal(proposal);
    const receipt = this.receipt(input);
    if (proposal.status !== 'applied' || !receipt || proposal.receiptId !== receipt.id || receipt.proposalHash !== proposal.proposalHash) throw new Error('This application proposal has no intact applied receipt.');
    const identity = await selectedSourceIdentity(input.handles, input.sourceHandle);
    if (identity.rootHash !== receipt.sourceRootHash) throw new Error('The selected checkout differs from the applied application patch.');
    for (const change of proposal.fileChanges) if ((await readSource(input.handles, input.sourceHandle, change.relativePath)).sha256 !== change.proposedSha256) throw new Error(`${change.relativePath} changed after application. Review the checkout before rerunning.`);
    return { proposal: structuredClone(proposal), receipt, sourcePath: identity.root };
  }
  async decide(input: { organizationId: string; projectId: string; testId: string; proposalId: string; kind: 'approve' | 'reject'; actorUid: string; handles: DirectoryHandleRegistry; sourceHandle: string }) {
    const proposal = this.#item(input);
    if (!ID.test(input.actorUid) || !['approve', 'reject'].includes(input.kind)) throw new Error('Application fix decision is invalid.');
    this.#verifyProposal(proposal);
    if (proposal.status === 'approved' && input.kind === 'approve' && proposal.decision?.actorUid === input.actorUid) return structuredClone(proposal);
    if (proposal.status !== 'proposed') throw new Error('This application proposal already has a decision.');
    if (input.kind === 'approve') await this.#checkBase(proposal, input.handles, input.sourceHandle);
    proposal.status = input.kind === 'approve' ? 'approved' : 'rejected';
    proposal.decision = { actorUid: input.actorUid, kind: input.kind, proposalHash: proposal.proposalHash, sourceRootHash: proposal.sourceRootHash, decidedAt: new Date().toISOString() };
    await this.#persist(); return structuredClone(proposal);
  }

  /** Serializes applications per proposal: a concurrent duplicate waits and then observes the first journal. */
  apply(input: { organizationId: string; projectId: string; testId: string; proposalId: string; actorUid: string; handles: DirectoryHandleRegistry; sourceHandle: string }): Promise<ApplicationFixReceipt> {
    const previous = this.#applying.get(input.proposalId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#apply(input));
    const settled = next.catch(() => undefined);
    this.#applying.set(input.proposalId, settled);
    void settled.then(() => { if (this.#applying.get(input.proposalId) === settled) this.#applying.delete(input.proposalId); });
    return next;
  }

  async #apply(input: { organizationId: string; projectId: string; testId: string; proposalId: string; actorUid: string; handles: DirectoryHandleRegistry; sourceHandle: string }): Promise<ApplicationFixReceipt> {
    const proposal = this.#item(input);
    this.#verifyProposal(proposal);
    if (proposal.decision?.kind !== 'approve' || proposal.decision.actorUid !== input.actorUid || proposal.decision.proposalHash !== proposal.proposalHash || proposal.decision.sourceRootHash !== proposal.sourceRootHash) throw new Error('An intact exact approval from this actor is required.');
    const identity = await selectedSourceIdentity(input.handles, input.sourceHandle);
    if (identity.rootHash !== proposal.sourceRootHash) throw new Error('The selected checkout differs from the approved destination.');
    let journal = this.#journals.find((item) => item.proposalId === proposal.id);
    if (journal?.state === 'rolled-back') { this.#journals = this.#journals.filter((item) => item !== journal); await this.#persistJournals(); journal = undefined; }
    if (journal) {
      if (journal.receipt.proposalHash !== proposal.proposalHash || journal.receipt.actorUid !== input.actorUid) throw new Error('The application journal differs from the approved patch.');
      if (journal.state === 'applied') {
        for (const change of proposal.fileChanges) if ((await readSource(input.handles, input.sourceHandle, change.relativePath)).sha256 !== change.proposedSha256) throw new Error('This patch was applied earlier, but the checkout has since changed. The receipt remains in history.');
        return structuredClone(journal.receipt);
      }
      const recovered = await this.#recover(proposal, journal, input.handles, input.sourceHandle);
      if (recovered === 'applied') return structuredClone(journal.receipt);
      if (recovered === 'recovery-required') throw new Error('Application patch recovery requires review because an intervening edit was preserved.');
      throw new Error('An interrupted application was safely rolled back. Review and retry the exact approval.');
    }
    if (proposal.status !== 'approved') throw new Error('Only an approved application proposal can be applied.');
    await this.#checkBase(proposal, input.handles, input.sourceHandle);
    const receipt: ApplicationFixReceipt = { schemaVersion: 1, id: `app_receipt_${randomUUID()}`, proposalId: proposal.id, proposalHash: proposal.proposalHash, organizationId: proposal.organizationId, projectId: proposal.projectId, testId: proposal.testId, sourceRootHash: proposal.sourceRootHash, ...(proposal.sourceRevision ? { sourceRevision: proposal.sourceRevision } : {}), actorUid: input.actorUid, appliedAt: new Date().toISOString(), changedPaths: [...proposal.changedPaths], baseHashes: Object.fromEntries(proposal.fileChanges.map((item) => [item.relativePath, item.baseSha256])), appliedHashes: Object.fromEntries(proposal.fileChanges.map((item) => [item.relativePath, item.proposedSha256])), originatingAttemptId: proposal.attemptId, originatingAnalysisId: proposal.analysisId, testVersionId: proposal.testVersionId, testVersionHash: proposal.testVersionHash, clientReported: true };
    journal = { proposalId: proposal.id, receipt, state: 'writing', completedPaths: [] };
    this.#journals.push(journal); proposal.status = 'applying'; await this.#persistAll();
    try {
      for (const change of proposal.fileChanges) {
        const current = await readSource(input.handles, input.sourceHandle, change.relativePath);
        if (current.sha256 !== change.baseSha256) throw new Error(`${change.relativePath} changed after approval; no further files were written.`);
        const absolute = await input.handles.resolve(input.sourceHandle, change.relativePath);
        await atomicReplace(absolute, change.proposedText);
        journal.completedPaths.push(change.relativePath); await this.#persistJournals();
        await this.#afterWrite?.(journal.completedPaths.length);
      }
      journal.state = 'applied'; proposal.status = 'applied'; proposal.receiptId = receipt.id; await this.#persistAll();
      return structuredClone(receipt);
    } catch (error) {
      journal.error = error instanceof Error ? error.message : String(error);
      await this.#recover(proposal, journal, input.handles, input.sourceHandle);
      throw error;
    }
  }

  async #recover(proposal: ApplicationFixProposal, journal: ApplicationJournal, handles: DirectoryHandleRegistry, sourceHandle: string): Promise<ApplicationJournal['state']> {
    const states: Array<{ change: ApplicationFixProposal['fileChanges'][number]; state: 'base' | 'proposed' | 'other' }> = [];
    for (const change of proposal.fileChanges) {
      try {
        const current = await readSource(handles, sourceHandle, change.relativePath);
        states.push({ change, state: current.sha256 === change.baseSha256 ? 'base' : current.sha256 === change.proposedSha256 ? 'proposed' : 'other' });
      } catch { states.push({ change, state: 'other' }); }
    }
    if (states.every((item) => item.state === 'proposed')) {
      journal.state = 'applied'; proposal.status = 'applied'; proposal.receiptId = journal.receipt.id; await this.#persistAll(); return journal.state;
    }
    const hasInterveningEdit = states.some((item) => item.state === 'other');
    for (const item of states.filter((item) => item.state === 'proposed')) {
      const current = await readSource(handles, sourceHandle, item.change.relativePath);
      if (current.sha256 !== item.change.proposedSha256) { journal.state = 'recovery-required'; proposal.status = 'recovery-required'; await this.#persistAll(); return journal.state; }
      const absolute = await handles.resolve(sourceHandle, item.change.relativePath);
      await atomicReplace(absolute, item.change.baseText);
    }
    journal.state = hasInterveningEdit ? 'recovery-required' : 'rolled-back'; proposal.status = hasInterveningEdit ? 'recovery-required' : 'approved'; await this.#persistAll(); return journal.state;
  }

  async #checkBase(proposal: ApplicationFixProposal, handles: DirectoryHandleRegistry, sourceHandle: string) {
    const identity = await selectedSourceIdentity(handles, sourceHandle);
    if (identity.rootHash !== proposal.sourceRootHash) throw new Error('The selected checkout differs from the proposed destination.');
    for (const change of proposal.fileChanges) {
      const current = await readSource(handles, sourceHandle, change.relativePath);
      if (current.sha256 !== change.baseSha256) throw new Error(`${change.relativePath} changed since the proposal was staged. Review a new patch.`);
      if (sha(change.baseText) !== change.baseSha256 || sha(change.proposedText) !== change.proposedSha256) throw new Error('A proposed file failed integrity verification.');
    }
  }

  #item(input: { organizationId: string; projectId: string; testId: string; proposalId: string }) {
    const found = this.#items.find((item) => item.id === input.proposalId && item.organizationId === input.organizationId && item.projectId === input.projectId && item.testId === input.testId);
    if (!found) throw new Error('Application proposal was not found in this project.');
    return found;
  }
  #verifyProposal(proposal: ApplicationFixProposal) {
    if (proposal.proposalHash !== applicationProposalHash(proposal) || proposal.changedPaths.length !== proposal.fileChanges.length || proposal.changedPaths.some((item, index) => item !== proposal.fileChanges[index]?.relativePath) || proposal.diff !== proposal.fileChanges.map((item) => unifiedDiff(item.relativePath, item.baseText, item.proposedText)).join('\n\n')) throw new Error('The application proposal changed after it was staged.');
  }
  async propose(input: { handles: DirectoryHandleRegistry; sourceHandle: string; analysis: FailureAnalysis; target: 'web' | 'flutter'; stagedFiles: { relativePath: string; sha256: string }[]; changes: { relativePath: string; text: string }[]; rationale: string }) {
    const { analysis } = input;
    if (analysis.status !== 'complete' || analysis.category !== 'application' || !analysis.evidenceIds.length) throw new Error('This failure has no supported application-defect analysis.');
    if (!ID.test(analysis.organizationId) || !ID.test(analysis.projectId) || !ID.test(analysis.testId) || !ID.test(analysis.attemptId)) throw new Error('Application proposal scope is invalid.');
    if (!input.rationale?.trim() || input.rationale.length > 3_000) throw new Error('A bounded application-fix rationale is required.');
    if (!Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 16 || new Set(input.changes.map((item) => item.relativePath)).size !== input.changes.length) throw new Error('Application proposal needs 1–16 unique file replacements.');
    const { root, rootHash } = await selectedSourceIdentity(input.handles, input.sourceHandle);
    const allowed = new Map(input.stagedFiles.map((item) => [item.relativePath, item.sha256]));
    const reviewFlags: string[] = [];
    const fileChanges = [] as ApplicationFixProposal['fileChanges'];
    const diffs: string[] = [];
    for (const change of input.changes) {
      if (!allowed.has(change.relativePath)) throw new Error('The proposed path was not in the reviewed source context.');
      if (typeof change.text !== 'string' || !change.text || Buffer.byteLength(change.text) > MAX_FILE_BYTES || change.text.includes('\0')) throw new Error('An application replacement is malformed or exceeds its budget.');
      if (SOURCE_CREDENTIAL.test(change.text)) throw new Error('An application replacement appears to contain a credential.');
      const base = await readSource(input.handles, input.sourceHandle, change.relativePath);
      if (base.sha256 !== allowed.get(change.relativePath)) throw new Error('The selected source changed after the proposal session opened. Start a new review.');
      if (base.text === change.text) throw new Error('A proposed application file is unchanged.');
      if (/\b(?:expect|assert)\s*\(/.test(change.text) && !/\b(?:expect|assert)\s*\(/.test(base.text)) throw new Error('Application proposals cannot add or change managed test assertions.');
      for (const name of importedPackages(change.text)) if (!importedPackages(base.text).has(name)) reviewFlags.push(`${change.relativePath}: new dependency or import ${name}`);
      if (/^(?:package\.json|pubspec\.yaml)$/.test(change.relativePath)) reviewFlags.push(`${change.relativePath}: dependency manifest changed`);
      fileChanges.push({ relativePath: change.relativePath, baseSha256: base.sha256, proposedSha256: sha(change.text), baseText: base.text, proposedText: change.text });
      diffs.push(unifiedDiff(change.relativePath, base.text, change.text));
    }
    if (fileChanges.length > 1) reviewFlags.push('Multiple application files changed; inspect each path for unrelated edits.');
    if (!reviewFlags.length) reviewFlags.push('No dependency or test change detected; review the full diff for scope.');
    const revision = await sourceRevision(root);
    const proposal: ApplicationFixProposal = { schemaVersion: 1, id: `app_proposal_${randomUUID()}`, organizationId: analysis.organizationId, projectId: analysis.projectId, testId: analysis.testId, attemptId: analysis.attemptId, analysisId: analysis.id, target: input.target, testVersionId: analysis.versionId, testVersionHash: analysis.testVersionHash, sourceRootHash: rootHash, ...(revision ? { sourceRevision: revision } : {}), createdAt: new Date().toISOString(), rationale: input.rationale.trim(), evidenceIds: [...analysis.evidenceIds], fileChanges, changedPaths: fileChanges.map((item) => item.relativePath), reviewFlags, diff: diffs.join('\n\n'), proposalHash: '', status: 'proposed' };
    proposal.proposalHash = applicationProposalHash(proposal);
    this.#items.push(proposal); await this.#persist(); return structuredClone(proposal);
  }
  async #persist() { await durableJson(this.#path, this.#items); }
  async #persistJournals() { await durableJson(this.#journalPath, this.#journals); }
  async #persistAll() { await this.#persistJournals(); await this.#persist(); }
}

async function durableJson(target: string, value: unknown) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, target);
}

async function readJsonOrEmpty<T>(target: string): Promise<T[]> {
  let text: string;
  try { text = await readFile(target, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${path.basename(target)} is malformed; local fix history was not discarded.`);
  return parsed as T[];
}

async function atomicReplace(target: string, text: string) {
  const temporary = path.join(path.dirname(target), `.sayspec-fix-${randomUUID()}.tmp`);
  const mode = (await stat(target)).mode & 0o777;
  const file = await open(temporary, 'wx', mode);
  try { await file.writeFile(text); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, target); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}
