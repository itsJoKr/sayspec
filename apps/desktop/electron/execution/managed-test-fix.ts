import { createHash, randomUUID } from 'node:crypto';
import type { FailureAnalysis, ManagedTestFixProposal, SavedWebTestVersion } from '@sayspec/contracts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const assertionLines = (text: string) => text.split('\n').flatMap((line) => [...line.matchAll(/\b(?:expect|assert)\s*\(/g)].map(() => line));
const importedPackages = (text: string) => [...text.matchAll(/\b(?:from\s*|require\s*\(|import\s*\()['"]([^.'\/][^'"]*)['"]/g)].map((match) => match[1]);

export function proposalContentHash(proposal: Pick<ManagedTestFixProposal, 'scope' | 'attemptId' | 'analysisId' | 'baseVersionId' | 'baseContentHash' | 'fileChanges' | 'rationale' | 'assertionImpact'>) {
  const { scope, attemptId, analysisId, baseVersionId, baseContentHash, fileChanges, rationale, assertionImpact } = proposal;
  return sha(canonical({ scope, attemptId, analysisId, baseVersionId, baseContentHash, fileChanges, rationale, assertionImpact }));
}

function changedLines(base: string, proposed: string, relativePath: string) {
  const before = base.split('\n'); const after = proposed.split('\n');
  let prefix = 0; while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0; while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const oldLines = before.slice(prefix, before.length - suffix); const newLines = after.slice(prefix, after.length - suffix);
  return [`--- a/${relativePath}`, `+++ b/${relativePath}`, `@@ -${prefix + 1},${oldLines.length} +${prefix + 1},${newLines.length} @@`,
    ...before.slice(Math.max(0, prefix - 2), prefix).map((line) => ` ${line}`), ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`),
    ...before.slice(before.length - suffix, before.length - suffix + Math.min(2, suffix)).map((line) => ` ${line}`)].join('\n');
}

/** Accept only replacement text for existing managed files; the agent never supplies a path outside the saved version. */
export function createManagedTestFixProposal(input: { version: SavedWebTestVersion; analysis: FailureAnalysis; changes: { relativePath: string; text: string }[]; rationale: string }): ManagedTestFixProposal {
  const { version, analysis } = input;
  if (analysis.status !== 'complete' || analysis.category !== 'test' || !analysis.evidenceIds.length || analysis.versionId !== version.id || analysis.testVersionHash !== version.contentHash || analysis.organizationId !== version.organizationId || analysis.projectId !== version.projectId || analysis.testId !== version.testId) throw new Error('This failed attempt has no supported managed-test fix analysis.');
  if (typeof input.rationale !== 'string' || !input.rationale.trim() || input.rationale.length > 3000) throw new Error('A bounded fix rationale is required.');
  if (!Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 16 || new Set(input.changes.map((item) => item.relativePath)).size !== input.changes.length) throw new Error('A proposal needs unique managed file changes.');
  const impact: string[] = []; const diffs: string[] = [];
  const fileChanges = input.changes.map((change) => {
    const original = version.files.find((file) => file.relativePath === change.relativePath);
    if (!original || typeof change.text !== 'string' || !change.text || Buffer.byteLength(change.text) > 128 * 1024 || original.sha256 !== sha(original.text)) throw new Error('Proposal attempted an unsafe, missing, or changed managed file.');
    if (change.text === original.text) throw new Error('Proposal contains an unchanged file.');
    const oldAssertions = assertionLines(original.text); const newAssertions = assertionLines(change.text);
    if (newAssertions.length < oldAssertions.length) impact.push(`${change.relativePath}: removed assertions (${oldAssertions.length} → ${newAssertions.length})`);
    if (oldAssertions.some((line) => !newAssertions.includes(line))) impact.push(`${change.relativePath}: changed expectations or assertions`);
    if (/\.skip\s*\(|\.fixme\s*\(|\btest\.skip\b|\btest\.fixme\b/.test(change.text) && !/\.skip\s*\(|\.fixme\s*\(|\btest\.skip\b|\btest\.fixme\b/.test(original.text)) impact.push(`${change.relativePath}: introduced a skip or fixme`);
    const tolerancePattern = /toBeCloseTo\s*\(|threshold\s*:|tolerance\s*:|maxDiffPixelRatio\s*:/;
    if (tolerancePattern.test(change.text) && change.text !== original.text && (!tolerancePattern.test(original.text) || original.text.split('\n').some((line) => tolerancePattern.test(line) && !change.text.split('\n').includes(line)))) impact.push(`${change.relativePath}: introduced or changed a tolerance; inspect whether it widens acceptance`);
    const oldPackages = new Set(importedPackages(original.text));
    for (const name of importedPackages(change.text)) if (!oldPackages.has(name) && name !== '@playwright/test') impact.push(`${change.relativePath}: new dependency ${name}`);
    diffs.push(changedLines(original.text, change.text, change.relativePath));
    return { relativePath: change.relativePath, baseSha256: original.sha256, proposedSha256: sha(change.text), proposedText: change.text };
  });
  if (!impact.length) impact.push('No assertion weakening pattern detected; reviewer must still inspect the diff.');
  const content = { scope: 'managed-web-test' as const, attemptId: analysis.attemptId, analysisId: analysis.id, baseVersionId: version.id, baseContentHash: version.contentHash, fileChanges, rationale: input.rationale.trim(), assertionImpact: impact };
  return { schemaVersion: 1, id: `proposal_${randomUUID()}`, organizationId: version.organizationId, projectId: version.projectId, testId: version.testId,
    ...content, createdAt: new Date().toISOString(), proposalHash: proposalContentHash(content), diff: diffs.join('\n\n'), status: 'proposed' };
}
