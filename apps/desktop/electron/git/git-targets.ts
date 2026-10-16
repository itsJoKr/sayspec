import type { ApplicationFixProposal, GitTarget } from '@sayspec/contracts';
import { selectedSourceIdentity, type ApplicationFixStore } from '../execution/application-fix.ts';
import type { DirectoryHandleRegistry } from '../jobs/directory-handles.ts';
import type { TestStorage } from '../test-storage/test-storage.ts';
import { branchStem, type GitTargetSpec } from './git-workspace.ts';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const HANDLE = /^directory_[a-f0-9-]{36}$/;

/** Validates a target sent by the renderer. */
export function parseGitTarget(value: unknown): GitTarget {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const id = (key: string) => { const item = input[key]; if (typeof item !== 'string' || !ID.test(item)) throw new Error('Git request is invalid.'); return item; };
  const handle = () => { const item = input.sourceHandle; if (typeof item !== 'string' || !HANDLE.test(item)) throw new Error('Git request is invalid.'); return item; };
  if (input.kind === 'application-fix') return { kind: 'application-fix', organizationId: id('organizationId'), projectId: id('projectId'), testId: id('testId'), proposalId: id('proposalId'), sourceHandle: handle() };
  if (input.kind === 'source') return { kind: 'source', sourceHandle: handle() };
  if (input.kind === 'tests') {
    const testIds = input.testIds;
    if (testIds !== undefined && (!Array.isArray(testIds) || testIds.length > 200 || testIds.some((item) => typeof item !== 'string' || !ID.test(item)))) throw new Error('Git request is invalid.');
    return { kind: 'tests', organizationId: id('organizationId'), projectId: id('projectId'), ...(testIds?.length ? { testIds: [...new Set(testIds as string[])].sort() } : {}) };
  }
  throw new Error('Git request is invalid.');
}

/** A commit subject from free text: its first sentence, clipped to a readable length. */
export function subjectFrom(prefix: string, text: string) {
  const line = text.trim().split('\n')[0] ?? '';
  const sentence = (/^(.+?[.!?])(?:\s|$)/.exec(line)?.[1] ?? line).replace(/[.!?]+$/, '').trim();
  const subject = `${prefix}${sentence || 'apply the SaySpec fix'}`;
  return subject.length > 72 ? `${subject.slice(0, 71).trimEnd()}…` : subject;
}

function applicationFixMessage(proposal: ApplicationFixProposal) {
  return `${subjectFrom('Fix: ', proposal.rationale)}\n\n${proposal.rationale.trim()}\n\nProposed by a coding agent in SaySpec for a failed test and applied after review.`;
}

/** Resolves what a Git target may commit on this machine. */
export async function resolveGitTarget(target: GitTarget, deps: { applicationFixes?: ApplicationFixStore; handles: DirectoryHandleRegistry; testStorage?: TestStorage }): Promise<GitTargetSpec> {
  if (target.kind === 'source') return { key: 'source', directory: deps.handles.root(target.sourceHandle), statusOnly: true, branchStem: 'change', message: '', note: 'This folder is not a Git repository.' };
  if (target.kind === 'application-fix') {
    if (!deps.applicationFixes) throw new Error('Application fixes are unavailable.');
    const scope = { organizationId: target.organizationId, projectId: target.projectId, testId: target.testId, proposalId: target.proposalId };
    const proposal = deps.applicationFixes.get(scope);
    const receipt = deps.applicationFixes.receipt(scope);
    const directory = deps.handles.root(target.sourceHandle);
    const base = { key: `application-fix:${target.organizationId}/${target.projectId}/${proposal.id}`, directory, branchStem: branchStem('fix', proposal.rationale, proposal.id), message: applicationFixMessage(proposal), note: 'The source folder is not a Git repository, so the fix stays as an edit in the folder.' };
    if (proposal.status !== 'applied' || !receipt) return { ...base, statusOnly: true };
    if ((await selectedSourceIdentity(deps.handles, target.sourceHandle)).rootHash !== receipt.sourceRootHash) throw new Error('The selected source folder is not the one this fix was applied to.');
    return {
      ...base, paths: [...receipt.changedPaths], exactPaths: true,
      // The commit must hold exactly the reviewed change: each file as applied, on top of the version the fix started from.
      async verify(repository) {
        for (const relativePath of receipt.changedPaths) {
          if (await repository.workingSha256(relativePath) !== receipt.appliedHashes[relativePath]) return `${relativePath} changed after SaySpec applied the fix, so a commit would hold more than the fix. Commit it yourself.`;
          const committed = await repository.committedSha256(relativePath);
          if (committed !== receipt.baseHashes[relativePath] && committed !== receipt.appliedHashes[relativePath]) return `${relativePath} had uncommitted edits before the fix was applied, so a commit would hold more than the fix. Commit it yourself.`;
        }
        return undefined;
      },
    };
  }
  const scope = { organizationId: target.organizationId, projectId: target.projectId };
  const prefix = `tests:${target.organizationId}/${target.projectId}:`;
  const location = await deps.testStorage?.gitLocation(scope, target.testIds);
  if (!target.testIds) {
    const day = new Date().toISOString().slice(0, 10);
    return { key: `${prefix}all`, keyPrefix: prefix, directory: location?.directory, ...(location?.include ? { include: location.include } : {}), branchStem: `tests-${day}`, message: 'Update SaySpec tests', note: location ? 'The test folder is not a Git repository.' : undefined };
  }
  const title = location?.titles.length === 1 ? location.titles[0] : `${target.testIds.length} tests`;
  return {
    key: `${prefix}${target.testIds.join(',')}`, directory: location?.directory, paths: location?.paths ?? [],
    branchStem: branchStem('test', title), message: location?.titles.length === 1 ? `Update SaySpec test “${title}”` : 'Update SaySpec tests',
    note: location ? 'The test folder is not a Git repository, so the new version stays as a file in it.' : undefined,
  };
}
