import { FieldValue, Timestamp, type DocumentData, type Firestore, type QuerySnapshot, type Transaction } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import { auditRef, defaultPlan, directoryFields, isProPlan, planKind, readAuthorizedProjects, readSeats, requireSeat, seatFields, seatLimit, writeActiveMembership } from './membership.js';

type ShareableRecordingManifest = {
  schemaVersion: '1.0.0'; kind: 'recording'; id: string; organizationId: string; projectId: string; createdByUid: string;
  artifacts: Array<{ id: string; sha256: string; byteLength: number; mimeType: string; storage: 'cloud-storage' }>;
  [key: string]: unknown;
};

export type Role = 'owner' | 'admin' | 'editor' | 'reviewer' | 'viewer';
export interface Actor { uid: string; email?: string; displayName?: string; }
export class CommandError extends Error {
  readonly code: 'invalid-argument' | 'permission-denied' | 'not-found' | 'already-exists' | 'failed-precondition' | 'aborted' | 'resource-exhausted' | 'unavailable';
  /** Stable machine-readable details (for example `{ reason: 'seats-full' }`); never secrets or codes. */
  readonly details?: Record<string, unknown>;
  constructor(code: CommandError['code'], message: string, details?: Record<string, unknown>) { super(message); this.name = 'CommandError'; this.code = code; this.details = details; }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function recordingManifestHash(manifest: ShareableRecordingManifest) {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

type FlutterSliceManifest = {
  schemaVersion: 1; kind: 'flutter-slice'; id: string; organizationId: string; projectId: string; createdByUid: string; includeRawAudio: boolean;
  capture: { id: string; organizationId: string; projectId: string; platform: 'android'; [key: string]: unknown };
  testVersion: { id: string; versionId: string; organizationId: string; projectId: string; recordingCaptureId: string; relativePath: string; source: string; contentHash: string; state: 'published'; requirements: Record<string, unknown>; [key: string]: unknown };
  attempt: { id: string; testId: string; versionId: string; projectId: string; organizationId: string; testContentHash: string; clientReported: true; runner: 'desktop-local-patrol'; [key: string]: unknown };
  artifacts: Array<{ id: string; kind: 'screenshot' | 'narration' | 'attempt'; sha256: string; byteLength: number; mimeType: string; storage: 'cloud-storage' }>;
};

export function flutterSliceManifestHash(manifest: FlutterSliceManifest) {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

function validatedFlutterSliceManifest(value: unknown, actor: Actor) {
  if (!value || typeof value !== 'object' || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new CommandError('invalid-argument', 'Flutter share manifest is invalid or too large.');
  const manifest = value as FlutterSliceManifest;
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'flutter-slice' || manifest.createdByUid !== actor.uid || manifest.capture?.platform !== 'android' || manifest.testVersion?.state !== 'published' || manifest.attempt?.clientReported !== true || manifest.attempt?.runner !== 'desktop-local-patrol') throw new CommandError('invalid-argument', 'Flutter share manifest identity or support lane is invalid.');
  for (const value_ of [manifest.id, manifest.organizationId, manifest.projectId, manifest.createdByUid, manifest.capture?.id, manifest.testVersion?.id, manifest.testVersion?.versionId, manifest.attempt?.id]) validId(value_, 'Flutter share identity');
  if (manifest.capture.organizationId !== manifest.organizationId || manifest.capture.projectId !== manifest.projectId || manifest.testVersion.organizationId !== manifest.organizationId || manifest.testVersion.projectId !== manifest.projectId || manifest.attempt.organizationId !== manifest.organizationId || manifest.attempt.projectId !== manifest.projectId) throw new CommandError('invalid-argument', 'Flutter share references must belong to the same project.');
  if (manifest.testVersion.recordingCaptureId !== manifest.capture.id || manifest.attempt.testId !== manifest.testVersion.id || manifest.attempt.versionId !== manifest.testVersion.versionId || manifest.attempt.testContentHash !== manifest.testVersion.contentHash) throw new CommandError('invalid-argument', 'Flutter share capture, version and attempt references do not match.');
  if (!/^patrol_test\/[A-Za-z0-9_./-]+\.dart$/.test(manifest.testVersion.relativePath) || manifest.testVersion.relativePath.includes('..') || Buffer.byteLength(manifest.testVersion.source) > 512 * 1024 || createHash('sha256').update(manifest.testVersion.source).digest('hex') !== manifest.testVersion.contentHash || !manifest.testVersion.source.includes('package:patrol/patrol.dart')) throw new CommandError('invalid-argument', 'Flutter share Patrol source failed integrity validation.');
  const requirements = manifest.testVersion.requirements;
  if (!requirements || requirements.platform !== 'android' || typeof requirements.flutterVersion !== 'string' || typeof requirements.patrolCliVersion !== 'string' || typeof requirements.patrolPackageVersion !== 'string' || typeof requirements.appId !== 'string' || Object.keys(requirements).some((key) => /path|credential|lease|deviceId|deviceName/i.test(key))) throw new CommandError('invalid-argument', 'Flutter share runtime requirements are incomplete or contain machine-local data.');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length > 200 || manifest.artifacts.some((item) => !item || !ID.test(item.id) || !['screenshot', 'narration', 'attempt'].includes(item.kind) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > 20 * 1024 * 1024 || typeof item.mimeType !== 'string' || item.storage !== 'cloud-storage')) throw new CommandError('invalid-argument', 'Flutter share artifact manifest is invalid.');
  if (!manifest.includeRawAudio && manifest.artifacts.some((item) => item.kind === 'narration')) throw new CommandError('invalid-argument', 'Raw narration requires explicit sharing choice.');
  if (new Set(manifest.artifacts.map((item) => item.id)).size !== manifest.artifacts.length) throw new CommandError('invalid-argument', 'Flutter share artifact IDs must be unique.');
  return manifest;
}

export async function beginFlutterSliceShare(db: Firestore, actor: Actor, input: { manifest: unknown; manifestHash: string }) {
  const manifest = validatedFlutterSliceManifest(input.manifest, actor);
  const expectedHash = flutterSliceManifestHash(manifest);
  if (input.manifestHash !== expectedHash) throw new CommandError('invalid-argument', 'Flutter share manifest hash does not match.');
  return db.runTransaction(async (tx) => {
    const project = await requireProjectAuthor(tx, db, manifest.organizationId, manifest.projectId, actor);
    if (project.data()?.targetType !== 'flutter') throw new CommandError('failed-precondition', 'Flutter slices can only be shared into a Flutter project.');
    const share = project.ref.collection('flutterShares').doc(manifest.id); const existing = await tx.get(share);
    if (existing.exists) {
      if (existing.data()?.manifestHash !== expectedHash) throw new CommandError('aborted', 'Flutter share conflict: the manifest changed.');
      return { shareId: manifest.id, manifestHash: expectedHash, status: existing.data()?.status as string };
    }
    tx.create(share, { id: manifest.id, organizationId: manifest.organizationId, projectId: manifest.projectId, createdByUid: actor.uid, createdAt: FieldValue.serverTimestamp(), status: 'uploading', manifestHash: expectedHash, manifest, expectedArtifacts: manifest.artifacts, clientReported: true });
    return { shareId: manifest.id, manifestHash: expectedHash, status: 'uploading' };
  });
}

export async function finalizeFlutterSliceShare(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; shareId: string; manifestHash: string }, artifactMetadata: (path: string) => Promise<{ byteLength: number; sha256?: string; organizationId?: string; projectId?: string } | null>) {
  validId(input.shareId, 'shareId');
  const snapshot = await db.runTransaction(async (tx) => {
    const project = await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const share = project.ref.collection('flutterShares').doc(input.shareId); const current = await tx.get(share);
    if (!current.exists) throw new CommandError('not-found', 'Flutter share was not started.');
    if (current.data()?.manifestHash !== input.manifestHash) throw new CommandError('aborted', 'Flutter share conflict: the manifest changed.');
    return { path: share.path, data: current.data()! };
  });
  for (const artifact of snapshot.data.expectedArtifacts as FlutterSliceManifest['artifacts']) {
    const objectPath = `organizations/${input.organizationId}/projects/${input.projectId}/flutterShares/${input.shareId}/${artifact.id}`;
    const metadata = await artifactMetadata(objectPath);
    if (!metadata || metadata.byteLength !== artifact.byteLength || metadata.sha256 !== artifact.sha256 || metadata.organizationId !== input.organizationId || metadata.projectId !== input.projectId) throw new CommandError('failed-precondition', `Flutter share artifact ${artifact.id} is missing or failed integrity validation.`);
  }
  await db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const share = db.doc(snapshot.path); const current = await tx.get(share);
    if (!current.exists || current.data()?.manifestHash !== input.manifestHash) throw new CommandError('aborted', 'Flutter share conflict: the manifest changed.');
    if (current.data()?.status !== 'shared') tx.update(share, { status: 'shared', sharedAt: FieldValue.serverTimestamp(), sharedByUid: actor.uid });
  });
  return { shareId: input.shareId, status: 'shared' as const };
}

export async function readFlutterSliceShare(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; shareId: string }) {
  validId(input.shareId, 'shareId');
  return db.runTransaction(async (tx) => {
    const project = projectRef(db, input.organizationId, input.projectId);
    await requireProjectCollaborator(tx, db, input.organizationId, input.projectId, actor);
    const share = await tx.get(project.collection('flutterShares').doc(input.shareId));
    if (!share.exists || share.data()?.status !== 'shared') throw new CommandError('not-found', 'Shared Flutter slice is unavailable.');
    return { shareId: input.shareId, status: 'shared' as const, manifestHash: share.data()?.manifestHash as string, manifest: share.data()?.manifest as FlutterSliceManifest };
  });
}

async function requireAuthor(tx: Transaction, db: Firestore, orgId: string, actor: Actor, publish = false) {
  const member = await tx.get(memberRef(db, orgId, actor.uid)); const data = member.data();
  const roles = publish ? ['owner', 'admin', 'reviewer'] : ['owner', 'admin', 'editor'];
  if (!member.exists || data?.status !== 'active' || !roles.includes(data.role)) throw new CommandError('permission-denied', publish ? 'Publishing requires reviewer authority.' : 'Authoring requires editor authority.');
  return data as { role: Role };
}
export async function requireProjectAuthor(tx: Transaction, db: Firestore, orgId: string, projectId: string, actor: Actor, publish = false) {
  const membership = await requireAuthor(tx, db, orgId, actor, publish);
  const project = await tx.get(projectRef(db, orgId, projectId));
  if (!project.exists) throw new CommandError('not-found', 'Project does not exist.');
  if (!['owner', 'admin'].includes(membership.role) && project.data()?.access !== 'all-members') {
    const grant = await tx.get(project.ref.collection('grants').doc(actor.uid));
    if (!grant.exists) throw new CommandError('permission-denied', 'An active project grant is required.');
  }
  return project;
}
async function requireProjectCollaborator(tx: Transaction, db: Firestore, orgId: string, projectId: string, actor: Actor) {
  const member = await tx.get(memberRef(db, orgId, actor.uid));
  if (!member.exists || member.data()?.status !== 'active') throw new CommandError('permission-denied', 'Active membership is required.');
  const project = await tx.get(projectRef(db, orgId, projectId));
  if (!project.exists) throw new CommandError('not-found', 'Project does not exist.');
  if (!['owner', 'admin'].includes(member.data()?.role) && project.data()?.access !== 'all-members' && !(await tx.get(project.ref.collection('grants').doc(actor.uid))).exists) throw new CommandError('permission-denied', 'Project access was revoked.');
  return member.data() as { role: Role };
}

export async function saveSuite(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; suiteId: string; expectedRevision: number; name: string; testIds: string[]; sourceRecordingId?: string }) {
  validId(input.suiteId, 'suiteId');
  if (input.sourceRecordingId !== undefined) validId(input.sourceRecordingId, 'sourceRecordingId');
  if (!input.suiteId.startsWith('suite_') || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || !Array.isArray(input.testIds) || input.testIds.length > 500 || new Set(input.testIds).size !== input.testIds.length) throw new CommandError('invalid-argument', 'Suite name, revision or membership is invalid.');
  input.testIds.forEach((id) => validId(id, 'testId'));
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const suite = projectRef(db, input.organizationId, input.projectId).collection('suites').doc(input.suiteId);
    const old = await tx.get(suite);
    if ((old.exists ? old.data()?.revision : 0) !== input.expectedRevision) throw new CommandError('aborted', 'Suite changed elsewhere. Reload and review membership before saving.');
    const tests = await Promise.all(input.testIds.map((id) => tx.get(testRef(db, input.organizationId, input.projectId, id))));
    if (tests.some((test) => !test.exists || test.data()?.status === 'archived')) throw new CommandError('failed-precondition', 'Suite members must be active tests from this project.');
    const revision = input.expectedRevision + 1;
    tx.set(suite, { id: input.suiteId, organizationId: input.organizationId, projectId: input.projectId, name: input.name.trim(), testIds: input.testIds, revision, updatedByUid: actor.uid, updatedAt: FieldValue.serverTimestamp(), ...(input.sourceRecordingId ? { sourceRecordingId: input.sourceRecordingId } : old.data()?.sourceRecordingId ? { sourceRecordingId: old.data()?.sourceRecordingId } : {}) });
    tx.create(projectRef(db, input.organizationId, input.projectId).collection('activity').doc(), { kind: old.exists ? 'suite-updated' : 'suite-created', suiteId: input.suiteId, revision, actorUid: actor.uid, at: FieldValue.serverTimestamp() });
    return { suiteId: input.suiteId, revision };
  });
}

// "Just Recorded" suites only stage fresh recordings: tests move out of them, never in, and they are deleted once empty.
const isJustRecordedSuite = (data: DocumentData | undefined) => Boolean(data?.sourceRecordingId) && data?.name === 'Just Recorded';

function removeTestFromSuites(tx: Transaction, suites: QuerySnapshot, actor: Actor, testId: string, targetSuiteId: string | null = null) {
  for (const suite of suites.docs) {
    const data = suite.data(); const current = Array.isArray(data.testIds) ? data.testIds.filter((id): id is string => typeof id === 'string') : [];
    const next = current.filter((id) => id !== testId);
    if (suite.id === targetSuiteId) next.push(testId);
    if (!next.length && isJustRecordedSuite(data)) tx.delete(suite.ref);
    else if (JSON.stringify(next) !== JSON.stringify(current)) tx.update(suite.ref, { testIds: next, revision: Number(data.revision ?? 0) + 1, updatedByUid: actor.uid, updatedAt: FieldValue.serverTimestamp() });
  }
}

export async function moveTestToSuite(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string; targetSuiteId: string | null }) {
  validId(input.testId, 'testId');
  if (input.targetSuiteId !== null) { validId(input.targetSuiteId, 'targetSuiteId'); if (!input.targetSuiteId.startsWith('suite_')) throw new CommandError('invalid-argument', 'targetSuiteId is invalid.'); }
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const test = await tx.get(testRef(db, input.organizationId, input.projectId, input.testId));
    if (!test.exists || test.data()?.status === 'archived') throw new CommandError('failed-precondition', 'Archived or missing tests cannot be moved.');
    const suites = await tx.get(projectRef(db, input.organizationId, input.projectId).collection('suites'));
    const target = input.targetSuiteId ? suites.docs.find((suite) => suite.id === input.targetSuiteId) : undefined;
    if (input.targetSuiteId && !target) throw new CommandError('not-found', 'The destination suite was not found.');
    if (target && isJustRecordedSuite(target.data()) && !(target.data().testIds ?? []).includes(input.testId)) throw new CommandError('failed-precondition', 'Tests cannot be moved into a Just Recorded suite.');
    removeTestFromSuites(tx, suites, actor, input.testId, input.targetSuiteId);
    tx.create(projectRef(db, input.organizationId, input.projectId).collection('activity').doc(), { kind: 'test-suite-moved', testId: input.testId, targetSuiteId: input.targetSuiteId, actorUid: actor.uid, at: FieldValue.serverTimestamp() });
    return { testId: input.testId, targetSuiteId: input.targetSuiteId };
  });
}

export async function commentOnTest(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string; versionId: string; versionHash: string; commentId: string; body: string }) {
  validId(input.versionId, 'versionId'); validId(input.commentId, 'commentId');
  if (!/^comment_/.test(input.commentId) || !/^[a-f0-9]{64}$/.test(input.versionHash) || typeof input.body !== 'string' || !input.body.trim() || input.body.length > 4000) throw new CommandError('invalid-argument', 'Comment is invalid.');
  return db.runTransaction(async (tx) => {
    await requireProjectCollaborator(tx, db, input.organizationId, input.projectId, actor);
    const test = testRef(db, input.organizationId, input.projectId, input.testId);
    const published = test.collection('versions').doc(input.versionId);
    const version = await tx.get(published);
    const anchor = test.collection('versionAnchors').doc(input.versionId);
    const anchored = version.exists ? null : await tx.get(anchor);
    let target = published; let createAnchor = false;
    if (!version.exists) {
      target = anchor;
      if (!anchored?.exists) {
        const draft = await tx.get(test.collection('drafts').doc('current'));
        const source = draft.data()?.generation ?? draft.data()?.importedBundle;
        if (!source || portableContentHash(source) !== input.versionHash) throw new CommandError('failed-precondition', 'The saved source version is not available in this project.');
        createAnchor = true;
      } else if (anchored.data()?.contentHash !== input.versionHash) throw new CommandError('failed-precondition', 'The version hash does not match its immutable anchor.');
    } else if (version.data()?.contentHash !== input.versionHash) throw new CommandError('failed-precondition', 'The referenced version hash does not match.');
    const comment = target.collection('comments').doc(input.commentId);
    if ((await tx.get(comment)).exists) throw new CommandError('already-exists', 'Comment already exists.');
    if (createAnchor) tx.create(anchor, { id: input.versionId, contentHash: input.versionHash, organizationId: input.organizationId, projectId: input.projectId, testId: input.testId, clientReported: true, createdAt: FieldValue.serverTimestamp() });
    tx.create(comment, { id: input.commentId, organizationId: input.organizationId, projectId: input.projectId, testId: input.testId, versionId: input.versionId, versionHash: input.versionHash, body: input.body.trim(), authorUid: actor.uid, createdAt: FieldValue.serverTimestamp() });
    tx.create(projectRef(db, input.organizationId, input.projectId).collection('activity').doc(), { kind: 'version-commented', testId: input.testId, versionId: input.versionId, actorUid: actor.uid, at: FieldValue.serverTimestamp() });
    return { commentId: input.commentId };
  });
}

export async function assignTestReviewer(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string; reviewerUid: string | null; expectedRevision: number }) {
  if (input.reviewerUid !== null) validId(input.reviewerUid, 'reviewerUid');
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new CommandError('invalid-argument', 'Reviewer revision is invalid.');
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    if (input.reviewerUid) {
      const member = await requireProjectCollaborator(tx, db, input.organizationId, input.projectId, { uid: input.reviewerUid });
      if (!['owner', 'admin', 'reviewer'].includes(member.role)) throw new CommandError('failed-precondition', 'Assignee must have active reviewer authority.');
    }
    const test = testRef(db, input.organizationId, input.projectId, input.testId); const snapshot = await tx.get(test);
    if (!snapshot.exists || snapshot.data()?.status === 'archived') throw new CommandError('failed-precondition', 'Cannot assign an archived or missing test.');
    if ((snapshot.data()?.reviewerRevision ?? 0) !== input.expectedRevision) throw new CommandError('aborted', 'Reviewer assignment changed elsewhere.');
    tx.update(test, { reviewerUid: input.reviewerUid, reviewerRevision: input.expectedRevision + 1, updatedAt: FieldValue.serverTimestamp() });
    tx.create(projectRef(db, input.organizationId, input.projectId).collection('activity').doc(), { kind: 'reviewer-assigned', testId: input.testId, actorUid: actor.uid, reviewerUid: input.reviewerUid, at: FieldValue.serverTimestamp() });
    return { revision: input.expectedRevision + 1 };
  });
}

function testRef(db: Firestore, orgId: string, projectId: string, testId: string) { validId(testId, 'testId'); return projectRef(db, orgId, projectId).collection('tests').doc(testId); }
function normalizedIntent(value: unknown) {
  const input = value as { prerequisites?: unknown; steps?: unknown; unresolvedQuestions?: unknown };
  if (!input || !Array.isArray(input.prerequisites) || !Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 200) throw new CommandError('invalid-argument', 'Intent requires bounded prerequisites and at least one step.');
  const prerequisites = input.prerequisites.map((item) => String(item).trim()).filter(Boolean);
  const steps = input.steps.map((item, index) => {
    const step = item as Record<string, unknown>;
    const action = String(step?.action ?? '').trim(); const expectedOutcome = String(step?.expectedOutcome ?? '').trim();
    if (!action || !expectedOutcome) throw new CommandError('invalid-argument', `Step ${index + 1} needs an action and expected outcome.`);
    const evidenceIds = Array.isArray(step.evidenceIds) ? [...new Set(step.evidenceIds.map((item) => String(item).trim()).filter((item) => ID.test(item)))] : [];
    return { id: `step_${index + 1}`, action, target: String(step.target ?? '').trim(), expectedOutcome, allowedVariation: String(step.allowedVariation ?? '').trim(), evidenceIds };
  });
  const unresolvedQuestions = Array.isArray(input.unresolvedQuestions) ? input.unresolvedQuestions.map((item) => String(item).trim()).filter(Boolean) : [];
  if (unresolvedQuestions.length > 100 || unresolvedQuestions.some((item) => item.length > 2_000)) throw new CommandError('invalid-argument', 'Intent unresolved questions are invalid.');
  return { prerequisites, steps, unresolvedQuestions };
}

function safeRelativePath(value: string) {
  return Boolean(value) && Buffer.byteLength(value) <= 512 && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !/^[a-zA-Z]:/.test(value) && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function normalizedBaseUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new CommandError('invalid-argument', 'Web projects require a complete URL.');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new CommandError('invalid-argument', 'Web projects require a complete URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new CommandError('invalid-argument', 'Web URL must use HTTP(S) and cannot contain credentials.');
  return url.href;
}

function normalizedGenerationDraft(value: unknown) {
  const input = value as Record<string, unknown>;
  if (!input || input.schemaVersion !== 1 || input.state !== 'draft' || typeof input.recordingId !== 'string' || !ID.test(input.recordingId) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160) throw new CommandError('invalid-argument', 'Generated draft identity is invalid.');
  const provenance = input.provenance as Record<string, unknown>;
  const validation = input.validation as Record<string, unknown> | undefined;
  const validationHistory = input.validationHistory as Array<Record<string, unknown>> | undefined;
  const validated = provenance?.executionValidated === true && validation?.status === 'passed' && Number(validation.passed) > 0 && Number(validation.failed) === 0;
  if (!provenance || !['claude-code', 'codex'].includes(String(provenance.provider)) || typeof provenance.cliVersion !== 'string' || !/^[a-f0-9]{64}$/.test(String(provenance.inputRevisionHash)) || provenance.recordingId !== input.recordingId || ![true, false].includes(provenance.executionValidated as boolean) || (provenance.executionValidated === true && !validated) || provenance.published !== false) throw new CommandError('invalid-argument', 'Generated draft provenance is invalid.');
  if (validationHistory && (!Array.isArray(validationHistory) || validationHistory.length > 3 || validationHistory.some((item) => !/^[a-f0-9]{64}$/.test(String(item.candidateSha256)) || !['passed', 'failed', 'skipped', 'blocked', 'canceled', 'infrastructure-error'].includes(String(item.status)) || typeof item.detail !== 'string' || item.detail.length > 14_000))) throw new CommandError('invalid-argument', 'Generated validation history is invalid.');
  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length || files.length > 16) throw new CommandError('invalid-argument', 'Generated draft files are missing or unbounded.');
  let totalBytes = 0; const paths = new Set<string>();
  const normalizedFiles = files.map((entry, index) => {
    const file = entry as Record<string, unknown>; const relativePath = String(file.relativePath ?? ''); const text = String(file.text ?? '');
    const byteLength = Buffer.byteLength(text); totalBytes += byteLength;
    if (!safeRelativePath(relativePath) || ['node_modules', 'playwright.config.cjs', 'result.json', 'test-results'].includes(relativePath.split('/')[0]) || paths.has(relativePath) || byteLength < 1 || byteLength > 128 * 1024 || !['text/typescript', 'application/json', 'text/markdown'].includes(String(file.mimeType))) throw new CommandError('invalid-argument', `Generated draft file ${index + 1} is invalid.`);
    paths.add(relativePath); const sha256 = createHash('sha256').update(text).digest('hex');
    if (file.sha256 !== sha256 || file.byteLength !== byteLength) throw new CommandError('invalid-argument', `Generated draft file ${relativePath} failed integrity validation.`);
    return { id: String(file.id ?? `file_${index + 1}`), relativePath, text, byteLength, sha256, mimeType: String(file.mimeType) };
  });
  if (totalBytes > 512 * 1024) throw new CommandError('invalid-argument', 'Generated draft exceeds the 512 KiB cloud draft budget.');
  const runtime = input.runtime as Record<string, unknown>; const dependencies = runtime?.dependencies as Record<string, unknown>;
  if (!runtime || runtime.framework !== 'playwright' || runtime.frameworkVersion !== '1.63.0' || typeof runtime.entrypoint !== 'string' || !paths.has(runtime.entrypoint) || !runtime.entrypoint.endsWith('.spec.ts') || !dependencies || Object.keys(dependencies).length !== 1 || dependencies['@playwright/test'] !== '1.63.0') throw new CommandError('invalid-argument', 'Generated draft runtime is invalid.');
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (!steps.length || steps.length > 200 || steps.some((step) => !step || typeof step !== 'object' || !String((step as Record<string, unknown>).instruction ?? '').trim() || !String((step as Record<string, unknown>).assertion ?? '').trim())) throw new CommandError('invalid-argument', 'Generated draft steps require explicit assertions.');
  const unresolvedQuestions = Array.isArray(input.unresolvedQuestions) ? input.unresolvedQuestions.map((item) => String(item).trim()).filter(Boolean) : [];
  if (unresolvedQuestions.length > 100) throw new CommandError('invalid-argument', 'Generated draft has too many unresolved questions.');
  return { ...input, recordingId: String(input.recordingId), title: input.title.trim(), files: normalizedFiles, unresolvedQuestions };
}

export async function createTestDraft(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string; title: string; folder?: string; tags?: string[] }) {
  if (!input.title?.trim() || input.title.length > 160) throw new CommandError('invalid-argument', 'Test title is invalid.');
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  if (tags.length > 20 || tags.some((tag) => tag.length > 40)) throw new CommandError('invalid-argument', 'Tags are invalid.');
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const test = testRef(db, input.organizationId, input.projectId, input.testId); if ((await tx.get(test)).exists) throw new CommandError('already-exists', 'Test already exists.');
    const draft = test.collection('drafts').doc('current');
    const authorLabel = (actor.displayName?.trim() || actor.email?.trim() || actor.uid).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120);
    tx.create(test, { id: input.testId, organizationId: input.organizationId, projectId: input.projectId, title: input.title.trim(), normalizedTitle: input.title.trim().toLowerCase(), folder: input.folder?.trim() || 'Unfiled', tags, ownerUid: actor.uid, authorLabel, status: 'draft', currentVersionId: null, versionCount: 0, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.create(draft, { organizationId: input.organizationId, projectId: input.projectId, testId: input.testId, revision: 0, intent: { prerequisites: [], steps: [], unresolvedQuestions: [] }, updatedByUid: actor.uid, updatedAt: FieldValue.serverTimestamp() });
    return { testId: input.testId, revision: 0 };
  });
}

export async function archiveTest(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string }) {
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const test = testRef(db, input.organizationId, input.projectId, input.testId);
    if (!(await tx.get(test)).exists) throw new CommandError('not-found', 'Test does not exist.');
    const suites = await tx.get(projectRef(db, input.organizationId, input.projectId).collection('suites'));
    removeTestFromSuites(tx, suites, actor, input.testId);
    tx.update(test, { status: 'archived', archivedAt: FieldValue.serverTimestamp(), archivedByUid: actor.uid, updatedAt: FieldValue.serverTimestamp() });
  });
}

export async function renameTest(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string; title: string }) {
  const title = input.title?.trim();
  if (!title || title.length > 160) throw new CommandError('invalid-argument', 'Test title is invalid.');
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const test = testRef(db, input.organizationId, input.projectId, input.testId);
    if (!(await tx.get(test)).exists) throw new CommandError('not-found', 'Test does not exist.');
    tx.update(test, { title, normalizedTitle: title.toLowerCase(), renamedByUid: actor.uid, renamedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { testId: input.testId, title };
  });
}

const PATROL_TEST_PATH = /^patrol_test\/[A-Za-z0-9_./-]+\.dart$/;

function normalizedPatrolVersion(input: Record<string, unknown>) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 160) throw new CommandError('invalid-argument', 'Test title is invalid.');
  const relativePath = String(input.relativePath ?? '');
  if (!PATROL_TEST_PATH.test(relativePath) || relativePath.includes('..')) throw new CommandError('invalid-argument', 'A Patrol test must live under patrol_test/ with a .dart extension.');
  const source = typeof input.source === 'string' ? input.source : '';
  if (!source || Buffer.byteLength(source) > 512 * 1024 || !source.includes('package:patrol/patrol.dart') || !/patrolTest\s*\(/.test(source)) throw new CommandError('invalid-argument', 'The source is not a Patrol test of at most 512 KiB.');
  const contentHash = createHash('sha256').update(source).digest('hex');
  if (input.contentHash !== contentHash) throw new CommandError('invalid-argument', 'Source hash does not match content.');
  // The app version the test was recorded against, from the app's pubspec.yaml.
  if (input.appVersion !== undefined && (typeof input.appVersion !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(input.appVersion))) throw new CommandError('invalid-argument', 'App version is invalid.');
  const dependencies = input.dependencies as Record<string, unknown> | undefined;
  if (dependencies !== undefined && (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies) || Object.keys(dependencies).length > 32 || Object.entries(dependencies).some(([name, version]) => !/^[a-z0-9_]{1,64}$/.test(name) || typeof version !== 'string' || !version || version.length > 64))) throw new CommandError('invalid-argument', 'Dependency versions are invalid.');
  if (input.recordingId !== undefined) validId(input.recordingId as string, 'recordingId');
  if (input.provider !== undefined && !['claude-code', 'codex'].includes(String(input.provider))) throw new CommandError('invalid-argument', 'Coding agent is invalid.');
  return {
    title, relativePath, source, contentHash,
    ...(input.appVersion !== undefined ? { appVersion: input.appVersion as string } : {}),
    ...(dependencies !== undefined ? { dependencies: dependencies as Record<string, string> } : {}),
    ...(input.recordingId !== undefined ? { recordingId: input.recordingId as string } : {}),
    ...(input.provider !== undefined ? { provider: input.provider as string } : {}),
  };
}

/**
 * Saves a Flutter test's source as a new immutable version in SaySpec Cloud,
 * creating the test when it does not exist yet. Nothing runs in the cloud:
 * each Mac pulls the current version and runs it locally. Saving the current
 * source again is a no-op; saving a deleted test brings it back.
 */
export async function savePatrolTestVersion(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string; title: string; relativePath: string; source: string; contentHash: string; appVersion?: string; dependencies?: Record<string, string>; recordingId?: string; provider?: string }) {
  validId(input.testId, 'testId');
  const version = normalizedPatrolVersion(input as unknown as Record<string, unknown>);
  return db.runTransaction(async (tx) => {
    const project = await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    if (project.data()?.targetType !== 'flutter') throw new CommandError('failed-precondition', 'Patrol tests belong to Flutter projects.');
    // The project may still use another storage: switching to SaySpec Cloud copies its tests here first.
    requireAllowedTestStorage('cloud', (await tx.get(orgRef(db, input.organizationId))).data());
    const test = testRef(db, input.organizationId, input.projectId, input.testId); const snapshot = await tx.get(test); const current = snapshot.data();
    if (snapshot.exists && current?.framework !== 'patrol') throw new CommandError('failed-precondition', 'This test is not a Patrol test.');
    const restore = current?.status === 'archived' ? { archivedAt: FieldValue.delete(), archivedByUid: FieldValue.delete() } : {};
    if (snapshot.exists && current?.currentVersionHash === version.contentHash) {
      if (current?.status === 'archived') tx.update(test, { status: 'published', ...restore, updatedAt: FieldValue.serverTimestamp() });
      return { testId: input.testId, versionId: String(current.currentVersionId), version: Number(current.versionCount), contentHash: version.contentHash, created: false };
    }
    const versionNumber = Number(current?.versionCount ?? 0) + 1;
    const versionId = `version_${versionNumber}`;
    tx.create(test.collection('versions').doc(versionId), { id: versionId, organizationId: input.organizationId, projectId: input.projectId, testId: input.testId, version: versionNumber, framework: 'patrol', ...version, publishedByUid: actor.uid, publishedAt: FieldValue.serverTimestamp() });
    const head = { status: 'published', currentVersionId: versionId, currentVersionHash: version.contentHash, versionCount: versionNumber, updatedAt: FieldValue.serverTimestamp() };
    if (!snapshot.exists) {
      const authorLabel = (actor.displayName?.trim() || actor.email?.trim() || actor.uid).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120);
      tx.create(test, { id: input.testId, organizationId: input.organizationId, projectId: input.projectId, framework: 'patrol', title: version.title, normalizedTitle: version.title.toLowerCase(), folder: 'Generated tests', tags: ['flutter', 'patrol'], ownerUid: actor.uid, authorLabel, ...(version.recordingId ? { recordingId: version.recordingId } : {}), createdAt: FieldValue.serverTimestamp(), ...head });
    } else tx.update(test, { ...head, ...restore });
    tx.create(projectRef(db, input.organizationId, input.projectId).collection('activity').doc(), { kind: 'test-version-saved', testId: input.testId, versionId, actorUid: actor.uid, at: FieldValue.serverTimestamp() });
    return { testId: input.testId, versionId, version: versionNumber, contentHash: version.contentHash, created: !snapshot.exists };
  });
}

export async function beginRecordingShare(db: Firestore, actor: Actor, input: { manifest: unknown; manifestHash: string }) {
  const manifest = input.manifest as ShareableRecordingManifest;
  if (!manifest || typeof manifest !== 'object' || manifest.schemaVersion !== '1.0.0' || manifest.kind !== 'recording' || !Array.isArray(manifest.artifacts)) throw new CommandError('invalid-argument', 'Recording manifest is invalid.');
  for (const value of [manifest.id, manifest.organizationId, manifest.projectId, manifest.createdByUid]) validId(value, 'recording identity');
  if (manifest.artifacts.some((item) => !item || !ID.test(item.id) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0 || typeof item.mimeType !== 'string')) throw new CommandError('invalid-argument', 'Recording artifact manifest is invalid.');
  if (manifest.createdByUid !== actor.uid || manifest.artifacts.some((item) => item.storage !== 'cloud-storage' || item.byteLength > 20 * 1024 * 1024)) throw new CommandError('invalid-argument', 'Recording manifest is not shareable.');
  const expectedHash = recordingManifestHash(manifest);
  if (input.manifestHash !== expectedHash) throw new CommandError('invalid-argument', 'Recording manifest hash does not match.');
  return db.runTransaction(async (tx) => {
    const project = await requireProjectAuthor(tx, db, manifest.organizationId, manifest.projectId, actor);
    const recording = project.ref.collection('recordings').doc(manifest.id);
    const existing = await tx.get(recording);
    if (existing.exists) {
      if (existing.data()?.manifestHash !== expectedHash) throw new CommandError('aborted', 'Recording share conflict: the manifest changed.');
      return { recordingId: manifest.id, manifestHash: expectedHash, status: existing.data()?.status as string };
    }
    tx.create(recording, {
      id: manifest.id, organizationId: manifest.organizationId, projectId: manifest.projectId,
      createdByUid: actor.uid, createdAt: FieldValue.serverTimestamp(), status: 'uploading',
      manifestHash: expectedHash, manifest, artifactCount: manifest.artifacts.length,
      expectedArtifacts: manifest.artifacts.map((item) => ({ id: item.id, sha256: item.sha256, byteLength: item.byteLength, mimeType: item.mimeType })),
    });
    return { recordingId: manifest.id, manifestHash: expectedHash, status: 'uploading' };
  });
}

export async function finalizeRecordingShare(
  db: Firestore,
  actor: Actor,
  input: { organizationId: string; projectId: string; recordingId: string; manifestHash: string },
  artifactMetadata: (path: string) => Promise<{ byteLength: number; sha256?: string; organizationId?: string; projectId?: string } | null>,
) {
  validId(input.recordingId, 'recordingId');
  const snapshot = await db.runTransaction(async (tx) => {
    const project = await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const recording = project.ref.collection('recordings').doc(input.recordingId); const current = await tx.get(recording);
    if (!current.exists) throw new CommandError('not-found', 'Recording share was not started.');
    if (current.data()?.manifestHash !== input.manifestHash) throw new CommandError('aborted', 'Recording share conflict: the manifest changed.');
    return { path: recording.path, data: current.data()! };
  });
  const expected = snapshot.data.expectedArtifacts as Array<{ id: string; sha256: string; byteLength: number }>;
  for (const artifact of expected) {
    const objectPath = `organizations/${input.organizationId}/projects/${input.projectId}/recordings/${input.recordingId}/${artifact.id}`;
    const metadata = await artifactMetadata(objectPath);
    if (!metadata || metadata.byteLength !== artifact.byteLength || metadata.sha256 !== artifact.sha256 || metadata.organizationId !== input.organizationId || metadata.projectId !== input.projectId) throw new CommandError('failed-precondition', `Recording artifact ${artifact.id} is missing or failed integrity validation.`);
  }
  await db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const recording = db.doc(snapshot.path); const current = await tx.get(recording);
    if (!current.exists || current.data()?.manifestHash !== input.manifestHash) throw new CommandError('aborted', 'Recording share conflict: the manifest changed.');
    tx.update(recording, { status: 'shared', sharedAt: FieldValue.serverTimestamp(), sharedByUid: actor.uid });
  });
  return { recordingId: input.recordingId, status: 'shared' as const };
}

export async function saveTestDraft(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string; expectedRevision: number; intent: unknown; generation?: unknown }) {
  const intent = normalizedIntent(input.intent);
  const generation = input.generation === undefined ? undefined : normalizedGenerationDraft(input.generation);
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const test = testRef(db, input.organizationId, input.projectId, input.testId); const testSnapshot = await tx.get(test);
    const draft = test.collection('drafts').doc('current'); const snapshot = await tx.get(draft);
    if (!testSnapshot.exists || !snapshot.exists) throw new CommandError('not-found', 'Draft does not exist.');
    if (snapshot.data()?.revision !== input.expectedRevision) throw new CommandError('aborted', `Draft conflict: expected revision ${input.expectedRevision}, current revision is ${snapshot.data()?.revision}.`);
    const revision = input.expectedRevision + 1;
    tx.update(draft, { revision, intent, generation: generation ?? FieldValue.delete(), updatedByUid: actor.uid, updatedAt: FieldValue.serverTimestamp() });
    tx.update(test, { ...(generation ? { title: generation.title, normalizedTitle: generation.title.toLowerCase(), recordingId: generation.recordingId, status: 'draft' } : {}), updatedAt: FieldValue.serverTimestamp() });
    return { testId: input.testId, revision };
  });
}

export async function publishTestDraft(db: Firestore, actor: Actor, input: {
  organizationId: string; projectId: string; testId: string; expectedRevision: number;
  files?: Array<{ id: string; relativePath: string; text: string; sha256: string; mimeType: string }>;
}) {
  const files = input.files ?? [];
  if (files.length > 64) throw new CommandError('invalid-argument', 'Too many source files.');
  const normalizedFiles = files.map((file) => {
    validId(file.id, 'file.id');
    if (!file.relativePath || file.relativePath.startsWith('/') || file.relativePath.includes('..') || file.relativePath.includes('\\')) throw new CommandError('invalid-argument', 'Source path is unsafe.');
    const byteLength = Buffer.byteLength(file.text ?? '');
    if (byteLength > 128 * 1024) throw new CommandError('invalid-argument', 'Inline source exceeds 128 KiB.');
    const sha256 = createHash('sha256').update(file.text).digest('hex');
    if (sha256 !== file.sha256) throw new CommandError('invalid-argument', 'Source hash does not match content.');
    return { ...file, byteLength, storage: 'firestore' as const };
  });
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor, true);
    const test = testRef(db, input.organizationId, input.projectId, input.testId); const testSnapshot = await tx.get(test);
    const draft = test.collection('drafts').doc('current'); const draftSnapshot = await tx.get(draft);
    if (!testSnapshot.exists || !draftSnapshot.exists) throw new CommandError('not-found', 'Draft does not exist.');
    if (draftSnapshot.data()?.revision !== input.expectedRevision) throw new CommandError('aborted', `Draft conflict: expected revision ${input.expectedRevision}, current revision is ${draftSnapshot.data()?.revision}.`);
    const versionNumber = Number(testSnapshot.data()?.versionCount ?? 0) + 1;
    const versionId = `version_${versionNumber}`;
    const content = { intent: draftSnapshot.data()?.intent, files: normalizedFiles.map(({ text: _text, ...file }) => file) };
    const contentHash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    const version = test.collection('versions').doc(versionId);
    tx.create(version, { id: versionId, organizationId: input.organizationId, projectId: input.projectId, testId: input.testId, version: versionNumber, source: 'manual', intent: draftSnapshot.data()?.intent, runtime: normalizedFiles.length ? { framework: 'playwright', entrypoint: normalizedFiles[0].relativePath, files: normalizedFiles.map(({ text: _text, ...file }) => file) } : null, contentHash, publishedByUid: actor.uid, publishedAt: FieldValue.serverTimestamp() });
    normalizedFiles.forEach((file) => tx.create(version.collection('files').doc(file.id), { ...file, organizationId: input.organizationId, projectId: input.projectId, testId: input.testId, versionId }));
    tx.update(test, { currentVersionId: versionId, currentVersionHash: contentHash, versionCount: versionNumber, status: normalizedFiles.length ? 'published' : 'definition-only', updatedAt: FieldValue.serverTimestamp() });
    tx.update(draft, { publishedRevision: input.expectedRevision, publishedVersionId: versionId, updatedAt: FieldValue.serverTimestamp() });
    return { testId: input.testId, versionId, version: versionNumber, contentHash };
  });
}

function portableContentHash(bundle: { steps: unknown; files: unknown; runtime: unknown }) {
  return createHash('sha256').update(canonicalJson({ steps: bundle.steps, files: bundle.files, runtime: bundle.runtime })).digest('hex');
}

function exactPortableKeys(value: unknown, keys: readonly string[], label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new CommandError('invalid-argument', `${label} contains unsupported fields.`);
}

function validatedPortableBundle(value: unknown) {
  if (!value || typeof value !== 'object' || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new CommandError('invalid-argument', 'Portable bundle is invalid or too large.');
  const bundle = value as Record<string, any>;
  exactPortableKeys(bundle, ['schemaVersion', 'kind', 'exportedAt', 'original', 'title', 'steps', 'files', 'runtime', 'secretPlaceholders', 'provenance'], 'Portable bundle');
  exactPortableKeys(bundle.original, ['testId', 'versionId', 'contentHash', 'state'], 'Portable bundle origin');
  exactPortableKeys(bundle.runtime, ['framework', 'frameworkVersion', 'entrypoint', 'dependencies', 'requirements'], 'Portable runtime');
  exactPortableKeys(bundle.provenance, ['provider', 'cliVersion', 'inputRevisionHash', 'generatedAt'], 'Portable provenance');
  if (bundle.schemaVersion !== 1 || bundle.kind !== 'sayspec-playwright-bundle' || typeof bundle.title !== 'string' || !bundle.title.trim() || bundle.title.length > 160 || !bundle.original || !/^[a-f0-9]{64}$/.test(String(bundle.original.contentHash)) || !['generated', 'execution-validated', 'published'].includes(bundle.original.state)) throw new CommandError('invalid-argument', 'Portable bundle schema is unsupported.');
  const files = bundle.files;
  if (!Array.isArray(files) || !files.length || files.length > 16) throw new CommandError('invalid-argument', 'Portable bundle files are invalid.');
  let total = 0; const paths = new Set<string>();
  for (const file of files) {
    exactPortableKeys(file, ['id', 'relativePath', 'text', 'sha256', 'byteLength', 'mimeType'], 'Portable file');
    const relativePath = String(file?.relativePath ?? ''); const text = file?.text;
    const bytes = typeof text === 'string' ? Buffer.byteLength(text) : 0; total += bytes;
    if (!safeRelativePath(relativePath) || ['node_modules', 'test-results', 'result.json', 'playwright.config.cjs', 'runner.log'].includes(relativePath.split('/')[0]) || paths.has(relativePath) || !bytes || bytes > 128 * 1024 || total > 512 * 1024 || !ID.test(String(file.id)) || !['text/typescript', 'application/json', 'text/markdown'].includes(file.mimeType) || file.byteLength !== bytes || file.sha256 !== createHash('sha256').update(text).digest('hex')) throw new CommandError('invalid-argument', 'Portable bundle file path, size or hash is invalid.');
    paths.add(relativePath);
  }
  const runtime = bundle.runtime;
  if (runtime?.framework !== 'playwright' || runtime.frameworkVersion !== '1.63.0' || runtime.dependencies?.['@playwright/test'] !== '1.63.0' || Object.keys(runtime.dependencies).length !== 1 || !paths.has(runtime.entrypoint) || !String(runtime.entrypoint).endsWith('.spec.ts') || !Array.isArray(runtime.requirements) || !runtime.requirements.includes('Node.js >=22.12.0') || !runtime.requirements.includes('Playwright Chromium installed') || JSON.stringify(bundle.secretPlaceholders) !== JSON.stringify(['BASE_URL'])) throw new CommandError('invalid-argument', 'Portable bundle dependencies or runtime are incomplete.');
  if (!Array.isArray(bundle.steps) || !bundle.steps.length || bundle.steps.length > 200 || bundle.steps.some((step: Record<string, unknown>) => !String(step?.assertion ?? '').trim() || !String(step?.instruction ?? '').trim()) || portableContentHash(bundle as { steps: unknown; files: unknown; runtime: unknown }) !== bundle.original.contentHash) throw new CommandError('invalid-argument', 'Portable bundle intent or content hash is invalid.');
  for (const step of bundle.steps) exactPortableKeys(step, ['id', 'instruction', 'assertion', 'intentItemIds', 'transcriptSegmentIds', 'evidenceEventIds'], 'Portable step');
  if (!bundle.provenance || !['claude-code', 'codex'].includes(bundle.provenance.provider) || !/^[a-f0-9]{64}$/.test(String(bundle.provenance.inputRevisionHash))) throw new CommandError('invalid-argument', 'Portable bundle provenance is invalid.');
  return bundle;
}

export async function importPortableTest(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string; bundle: unknown }) {
  validId(input.testId, 'testId');
  if (!input.testId.startsWith('import_')) throw new CommandError('invalid-argument', 'Imported test ID is invalid.');
  const bundle = validatedPortableBundle(input.bundle);
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const test = testRef(db, input.organizationId, input.projectId, input.testId);
    if ((await tx.get(test)).exists) throw new CommandError('already-exists', 'Import cannot overwrite an existing test.');
    const title = String(bundle.title).trim();
    const authorLabel = (actor.displayName?.trim() || actor.email?.trim() || actor.uid).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120);
    tx.create(test, { id: input.testId, organizationId: input.organizationId, projectId: input.projectId, title, normalizedTitle: title.toLowerCase(), folder: 'Imported tests', tags: ['import'], ownerUid: actor.uid, authorLabel, status: 'draft', currentVersionId: null, versionCount: 0, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.create(test.collection('drafts').doc('current'), { organizationId: input.organizationId, projectId: input.projectId, testId: input.testId, revision: 0,
      intent: { prerequisites: bundle.runtime.requirements, steps: bundle.steps.map((step: Record<string, unknown>) => ({ action: step.instruction, target: '', expectedOutcome: step.assertion, evidenceIds: step.evidenceEventIds ?? [] })), unresolvedQuestions: [] },
      importedBundle: bundle, contentHash: bundle.original.contentHash, localValidation: 'not-replayed', updatedByUid: actor.uid, updatedAt: FieldValue.serverTimestamp() });
    return { testId: input.testId, contentHash: bundle.original.contentHash, clientReported: true };
  });
}

export async function recordLocalTestAttempt(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string; attempt: unknown }) {
  const attempt = input.attempt as Record<string, any>;
  exactPortableKeys(attempt, ['schemaVersion', 'id', 'versionId', 'testId', 'organizationId', 'projectId', 'testVersionHash', 'environmentHash', 'executionManifestHash', 'baseUrl', 'state', 'startedAt', 'finishedAt', 'summary', 'passed', 'failed', 'skipped', 'detail', 'tests', 'artifacts', 'exitCode', 'durationMs', 'runner', 'applicationPatch'], 'Local attempt');
  if (!attempt || attempt.schemaVersion !== 1 || typeof attempt.id !== 'string' || !/^attempt_[a-f0-9-]{36}$/.test(attempt.id) || attempt.organizationId !== input.organizationId || attempt.projectId !== input.projectId || attempt.testId !== input.testId || !/^[a-f0-9]{64}$/.test(String(attempt.testVersionHash)) || !/^[a-f0-9]{64}$/.test(String(attempt.environmentHash)) || !/^[a-f0-9]{64}$/.test(String(attempt.executionManifestHash)) || !['passed', 'failed', 'skipped', 'blocked', 'canceled', 'infrastructure-error'].includes(attempt.state) || attempt.runner !== 'desktop-local') throw new CommandError('invalid-argument', 'Client-reported local attempt is invalid.');
  if (!Array.isArray(attempt.tests) || attempt.tests.length > 200 || !Array.isArray(attempt.artifacts) || attempt.artifacts.length > 200 || typeof attempt.summary !== 'string' || attempt.summary.length > 2000 || typeof attempt.detail !== 'string' || attempt.detail.length > 32_000 || !Number.isSafeInteger(attempt.passed) || !Number.isSafeInteger(attempt.failed) || !Number.isSafeInteger(attempt.skipped)) throw new CommandError('invalid-argument', 'Client-reported local attempt exceeds its budget.');
  for (const item of attempt.tests) exactPortableKeys(item, ['id', 'title', 'outcome', 'durationMs', 'errors'], 'Local test outcome');
  for (const item of attempt.artifacts) exactPortableKeys(item, ['relativePath', 'sha256', 'byteLength', 'mimeType'], 'Local attempt artifact');
  if (attempt.baseUrl !== undefined && (typeof attempt.baseUrl !== 'string' || attempt.baseUrl.length > 2048 || !/^https?:\/\//.test(attempt.baseUrl))) throw new CommandError('invalid-argument', 'Local attempt URL is invalid.');
  if (attempt.applicationPatch !== undefined) {
    exactPortableKeys(attempt.applicationPatch, ['receiptId', 'proposalId', 'proposalHash', 'originatingAttemptId', 'sourceRootHash', 'runtimeKind', 'runtimeHash', 'buildArtifactHash'], 'Application patch link');
    const patch = attempt.applicationPatch;
    if (![patch.receiptId, patch.proposalId, patch.originatingAttemptId].every((id) => typeof id === 'string' && ID.test(id)) || ![patch.proposalHash, patch.sourceRootHash, patch.runtimeHash].every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) || patch.runtimeKind !== 'local-web-server') throw new CommandError('invalid-argument', 'Client-reported application patch link is invalid.');
  }
  if (attempt.state === 'passed' && (attempt.passed < 1 || attempt.failed !== 0 || attempt.skipped !== 0)) throw new CommandError('invalid-argument', 'A zero-result or mixed local attempt cannot pass.');
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const test = testRef(db, input.organizationId, input.projectId, input.testId);
    const draft = test.collection('drafts').doc('current');
    const snapshot = await tx.get(draft);
    const anchor = await tx.get(test.collection('versionAnchors').doc(String(attempt.versionId)));
    const source = snapshot.data()?.importedBundle ?? snapshot.data()?.generation;
    if (!anchor.exists && (!source || portableContentHash(source) !== attempt.testVersionHash) || anchor.exists && anchor.data()?.contentHash !== attempt.testVersionHash) throw new CommandError('failed-precondition', 'Local attempt does not match an authorized saved source hash.');
    const document = draft.collection('attempts').doc(attempt.id);
    if ((await tx.get(document)).exists) throw new CommandError('already-exists', 'A local attempt cannot be overwritten.');
    tx.create(document, { ...attempt, clientReported: true, attestedByServer: false, recordedByUid: actor.uid, recordedAt: FieldValue.serverTimestamp() });
    return { attemptId: attempt.id, clientReported: true, attestedByServer: false };
  });
}

type ManagedFixDecisionInput = { organizationId: string; projectId: string; testId: string; proposalId: string; attemptId: string; analysisId: string; baseVersionId: string; baseContentHash: string; proposalHash: string; kind: 'approve' | 'reject' };
function validateManagedFixDecision(input: ManagedFixDecisionInput) {
  for (const key of ['organizationId', 'projectId', 'testId', 'proposalId', 'attemptId', 'analysisId', 'baseVersionId'] as const) validId(input[key], key);
  if (!input.proposalId.startsWith('proposal_') || !input.attemptId.startsWith('attempt_') || !input.analysisId.startsWith('analysis_') || !/^[a-f0-9]{64}$/.test(input.baseContentHash) || !/^[a-f0-9]{64}$/.test(input.proposalHash) || !['approve', 'reject'].includes(input.kind)) throw new CommandError('invalid-argument', 'Managed fix decision is invalid.');
}
export async function decideManagedFix(db: Firestore, actor: Actor, input: ManagedFixDecisionInput) {
  validateManagedFixDecision(input);
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor, true);
    const test = testRef(db, input.organizationId, input.projectId, input.testId);
    const testSnapshot = await tx.get(test);
    const draft = await tx.get(test.collection('drafts').doc('current'));
    const source = draft.data()?.importedBundle ?? draft.data()?.generation;
    const currentHash = testSnapshot.data()?.currentVersionHash ?? (source ? portableContentHash(source) : null);
    if (!testSnapshot.exists || testSnapshot.data()?.status === 'archived' || currentHash !== input.baseContentHash) throw new CommandError('failed-precondition', 'The managed test base is missing or changed.');
    const attempt = await tx.get(test.collection('drafts').doc('current').collection('attempts').doc(input.attemptId));
    if (!attempt.exists || attempt.data()?.versionId !== input.baseVersionId || attempt.data()?.testVersionHash !== input.baseContentHash || !['failed', 'blocked', 'infrastructure-error'].includes(String(attempt.data()?.state))) throw new CommandError('failed-precondition', 'The failed local attempt is not synchronized with this test.');
    const proposal = test.collection('fixProposals').doc(input.proposalId);
    const oldDecision = await tx.get(proposal);
    if (oldDecision.exists) {
      const old = oldDecision.data();
      if (old?.actorUid === actor.uid && old?.kind === input.kind && old?.proposalHash === input.proposalHash && old?.baseContentHash === input.baseContentHash && old?.attemptId === input.attemptId && old?.analysisId === input.analysisId && old?.baseVersionId === input.baseVersionId) return { proposalId: input.proposalId, actorUid: actor.uid, kind: input.kind, proposalHash: input.proposalHash, baseContentHash: input.baseContentHash };
      throw new CommandError('already-exists', 'This proposal already has a different durable decision.');
    }
    tx.create(proposal, { ...input, actorUid: actor.uid, decidedAt: FieldValue.serverTimestamp(), clientReported: true });
    return { proposalId: input.proposalId, actorUid: actor.uid, kind: input.kind, proposalHash: input.proposalHash, baseContentHash: input.baseContentHash };
  });
}

export async function authorizeManagedFixApply(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string; proposalId: string; baseContentHash: string; proposalHash: string }) {
  for (const key of ['organizationId', 'projectId', 'testId', 'proposalId'] as const) validId(input[key], key);
  if (!/^[a-f0-9]{64}$/.test(input.baseContentHash) || !/^[a-f0-9]{64}$/.test(input.proposalHash)) throw new CommandError('invalid-argument', 'Managed fix authorization hashes are invalid.');
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor, true);
    const test = testRef(db, input.organizationId, input.projectId, input.testId);
    const testSnapshot = await tx.get(test); const draft = await tx.get(test.collection('drafts').doc('current'));
    const source = draft.data()?.importedBundle ?? draft.data()?.generation;
    const currentHash = testSnapshot.data()?.currentVersionHash ?? (source ? portableContentHash(source) : null);
    const decision = await tx.get(test.collection('fixProposals').doc(input.proposalId));
    if (!decision.exists || decision.data()?.kind !== 'approve' || decision.data()?.actorUid !== actor.uid || decision.data()?.proposalHash !== input.proposalHash || decision.data()?.baseContentHash !== input.baseContentHash) throw new CommandError('permission-denied', 'An exact authorized fix approval is required.');
    if (currentHash !== input.baseContentHash) throw new CommandError('aborted', 'The managed test changed after approval.');
    return { proposalId: input.proposalId, actorUid: actor.uid, proposalHash: input.proposalHash, baseContentHash: input.baseContentHash };
  });
}
export async function authorizeManagedFixRead(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string }) {
  return db.runTransaction(async (tx) => {
    await requireProjectCollaborator(tx, db, input.organizationId, input.projectId, actor);
    const test = await tx.get(testRef(db, input.organizationId, input.projectId, input.testId));
    if (!test.exists) throw new CommandError('not-found', 'Managed test was not found in this project.');
    return { actorUid: actor.uid };
  });
}
export async function authorizeApplicationFixRead(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; target: 'web' | 'flutter' }) {
  validId(input.organizationId, 'organizationId'); validId(input.projectId, 'projectId');
  if (input.target !== 'web' && input.target !== 'flutter') throw new CommandError('invalid-argument', 'Application target is invalid.');
  return db.runTransaction(async (tx) => {
    await requireProjectCollaborator(tx, db, input.organizationId, input.projectId, actor);
    const project = await tx.get(projectRef(db, input.organizationId, input.projectId));
    if (project.data()?.targetType !== input.target) throw new CommandError('failed-precondition', 'The selected application target differs from this project.');
    return { actorUid: actor.uid };
  });
}
type ApplicationFixDecisionInput = { organizationId: string; projectId: string; testId: string; proposalId: string; attemptId: string; analysisId: string; target: 'web' | 'flutter'; testVersionId: string; testVersionHash: string; sourceRootHash: string; proposalHash: string; kind: 'approve' | 'reject' };
function validateApplicationFixIdentity(input: { organizationId: string; projectId: string; testId: string; proposalId: string; target: 'web' | 'flutter'; sourceRootHash: string; proposalHash: string }) {
  for (const key of ['organizationId', 'projectId', 'testId', 'proposalId'] as const) validId(input[key], key);
  if (!input.proposalId.startsWith('app_proposal_') || !['web', 'flutter'].includes(input.target) || !/^[a-f0-9]{64}$/.test(input.sourceRootHash) || !/^[a-f0-9]{64}$/.test(input.proposalHash)) throw new CommandError('invalid-argument', 'Application fix identity is invalid.');
}
export async function decideApplicationFix(db: Firestore, actor: Actor, input: ApplicationFixDecisionInput) {
  validateApplicationFixIdentity(input);
  for (const key of ['attemptId', 'analysisId', 'testVersionId'] as const) validId(input[key], key);
  if (!/^[a-f0-9]{64}$/.test(input.testVersionHash) || !['approve', 'reject'].includes(input.kind)) throw new CommandError('invalid-argument', 'Application fix decision is invalid.');
  return db.runTransaction(async (tx) => {
    const project = await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor, true);
    if (project.data()?.targetType !== input.target) throw new CommandError('failed-precondition', 'Application target differs from this project.');
    const document = project.ref.collection('applicationFixDecisions').doc(input.proposalId);
    const previous = await tx.get(document);
    const snapshotHash = createHash('sha256').update(canonicalJson(input)).digest('hex');
    if (previous.exists) {
      if (previous.data()?.snapshotHash !== snapshotHash || previous.data()?.actorUid !== actor.uid) throw new CommandError('already-exists', 'This application proposal has a different decision.');
      return { proposalId: input.proposalId, actorUid: actor.uid, kind: input.kind, proposalHash: input.proposalHash, clientReported: true };
    }
    tx.create(document, { ...input, snapshotHash, actorUid: actor.uid, decidedAt: FieldValue.serverTimestamp(), clientReported: true });
    return { proposalId: input.proposalId, actorUid: actor.uid, kind: input.kind, proposalHash: input.proposalHash, clientReported: true };
  });
}
export async function authorizeApplicationFixApply(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string; proposalId: string; target: 'web' | 'flutter'; sourceRootHash: string; proposalHash: string }) {
  validateApplicationFixIdentity(input);
  return db.runTransaction(async (tx) => {
    const project = await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor, true);
    if (project.data()?.targetType !== input.target) throw new CommandError('failed-precondition', 'Application target differs from this project.');
    const decision = await tx.get(project.ref.collection('applicationFixDecisions').doc(input.proposalId));
    if (!decision.exists || decision.data()?.kind !== 'approve' || decision.data()?.actorUid !== actor.uid || decision.data()?.proposalHash !== input.proposalHash || decision.data()?.sourceRootHash !== input.sourceRootHash || decision.data()?.testId !== input.testId || decision.data()?.target !== input.target) throw new CommandError('permission-denied', 'An exact authorized application-fix approval is required.');
    return { actorUid: actor.uid, proposalId: input.proposalId, proposalHash: input.proposalHash, clientReported: true };
  });
}
export async function recordApplicationFixApplied(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string; proposalId: string; target: 'web' | 'flutter'; sourceRootHash: string; proposalHash: string; receiptId: string; appliedHashesHash: string }) {
  validateApplicationFixIdentity(input); validId(input.receiptId, 'receiptId');
  if (!/^[a-f0-9]{64}$/.test(input.appliedHashesHash)) throw new CommandError('invalid-argument', 'Application receipt hash is invalid.');
  return db.runTransaction(async (tx) => {
    const project = await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor, true);
    if (project.data()?.targetType !== input.target) throw new CommandError('failed-precondition', 'Application target differs from this project.');
    const decisionRef = project.ref.collection('applicationFixDecisions').doc(input.proposalId);
    const decision = await tx.get(decisionRef);
    if (!decision.exists || decision.data()?.kind !== 'approve' || decision.data()?.actorUid !== actor.uid || decision.data()?.proposalHash !== input.proposalHash || decision.data()?.sourceRootHash !== input.sourceRootHash || decision.data()?.testId !== input.testId) throw new CommandError('permission-denied', 'The application receipt differs from the approved patch.');
    if (decision.data()?.receiptId) {
      if (decision.data()?.receiptId !== input.receiptId || decision.data()?.appliedHashesHash !== input.appliedHashesHash) throw new CommandError('already-exists', 'A different application receipt is already recorded.');
      return { actorUid: actor.uid, receiptId: input.receiptId, clientReported: true };
    }
    tx.update(decisionRef, { receiptId: input.receiptId, appliedHashesHash: input.appliedHashesHash, appliedAt: FieldValue.serverTimestamp(), clientReported: true });
    return { actorUid: actor.uid, receiptId: input.receiptId, clientReported: true };
  });
}
export async function recordManagedFixApplied(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testId: string; proposalId: string; versionId: string; versionNumber: number; versionHash: string; baseContentHash: string; proposalHash: string }) {
  for (const key of ['organizationId', 'projectId', 'testId', 'proposalId', 'versionId'] as const) validId(input[key], key);
  if (!Number.isSafeInteger(input.versionNumber) || input.versionNumber < 2 || !/^[a-f0-9]{64}$/.test(input.versionHash) || !/^[a-f0-9]{64}$/.test(input.baseContentHash) || !/^[a-f0-9]{64}$/.test(input.proposalHash)) throw new CommandError('invalid-argument', 'Applied fix hashes or version are invalid.');
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor, true);
    const test = testRef(db, input.organizationId, input.projectId, input.testId);
    const testSnapshot = await tx.get(test); const draft = await tx.get(test.collection('drafts').doc('current'));
    const decisionRef = test.collection('fixProposals').doc(input.proposalId); const decision = await tx.get(decisionRef);
    if (!decision.exists || decision.data()?.kind !== 'approve' || decision.data()?.actorUid !== actor.uid || decision.data()?.baseContentHash !== input.baseContentHash || decision.data()?.proposalHash !== input.proposalHash) throw new CommandError('permission-denied', 'The applied fix does not match an authorized approval.');
    if (decision.data()?.appliedVersionId === input.versionId && decision.data()?.appliedVersionHash === input.versionHash) return { actorUid: actor.uid, versionId: input.versionId, contentHash: input.versionHash, clientReported: true };
    if (decision.data()?.appliedVersionId) throw new CommandError('already-exists', 'This proposal was applied to another version.');
    const source = draft.data()?.importedBundle ?? draft.data()?.generation;
    const currentHash = testSnapshot.data()?.currentVersionHash ?? (source ? portableContentHash(source) : null);
    if (!testSnapshot.exists || testSnapshot.data()?.status === 'archived' || currentHash !== input.baseContentHash) throw new CommandError('aborted', 'The managed test changed before its applied version was recorded.');
    const anchor = test.collection('versionAnchors').doc(input.versionId);
    if ((await tx.get(anchor)).exists) throw new CommandError('already-exists', 'The applied version ID already exists.');
    tx.create(anchor, { id: input.versionId, organizationId: input.organizationId, projectId: input.projectId, testId: input.testId, contentHash: input.versionHash, baseContentHash: input.baseContentHash, fixProposalId: input.proposalId, clientReported: true, createdAt: FieldValue.serverTimestamp() });
    tx.update(decisionRef, { appliedVersionId: input.versionId, appliedVersionHash: input.versionHash, appliedAt: FieldValue.serverTimestamp() });
    if (input.versionNumber < Number(testSnapshot.data()?.versionCount ?? 0) + 1 || input.versionNumber > Number(testSnapshot.data()?.versionCount ?? 0) + 2) throw new CommandError('aborted', 'Applied version number is stale.');
    tx.update(test, { currentVersionId: input.versionId, currentVersionHash: input.versionHash, versionCount: input.versionNumber, updatedAt: FieldValue.serverTimestamp() });
    return { actorUid: actor.uid, versionId: input.versionId, contentHash: input.versionHash, clientReported: true };
  });
}
export async function recordLocalRun(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; run: unknown }) {
  const run = input.run as Record<string, any>;
  if (!run || run.schemaVersion !== 1 || !/^run_[a-f0-9-]{36}$/.test(String(run.id)) || run.organizationId !== input.organizationId || run.projectId !== input.projectId || typeof run.name !== 'string' || !run.name.trim() || run.name.length > 120 || !/^[a-f0-9]{64}$/.test(String(run.environmentHash)) || !Array.isArray(run.items) || !run.items.length || run.items.length > 100) throw new CommandError('invalid-argument', 'Client-reported run metadata is invalid.');
  const ids = run.items.map((item: Record<string, unknown>) => String(item.testId));
  if (new Set(ids).size !== ids.length || run.items.some((item: Record<string, unknown>) => !ID.test(String(item.testId)) || !ID.test(String(item.versionId)) || !/^[a-f0-9]{64}$/.test(String(item.contentHash)))) throw new CommandError('invalid-argument', 'Run test references are invalid.');
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const project = projectRef(db, input.organizationId, input.projectId);
    const target = project.collection('runs').doc(run.id); const previous = await tx.get(target);
    if (previous.exists) {
      if (previous.data()?.snapshotHash !== createHash('sha256').update(canonicalJson({ name: run.name, environmentHash: run.environmentHash, items: run.items.map((item: Record<string, unknown>) => ({ testId: item.testId, versionId: item.versionId, contentHash: item.contentHash })) })).digest('hex')) throw new CommandError('already-exists', 'Run snapshot cannot be overwritten.');
      return { runId: run.id, clientReported: true, attestedByServer: false };
    }
    const tests = await Promise.all(ids.map((id) => tx.get(testRef(db, input.organizationId, input.projectId, id))));
    const drafts = await Promise.all(ids.map((id) => tx.get(testRef(db, input.organizationId, input.projectId, id).collection('drafts').doc('current'))));
    const anchors = await Promise.all(run.items.map((item: Record<string, unknown>) => tx.get(testRef(db, input.organizationId, input.projectId, String(item.testId)).collection('versionAnchors').doc(String(item.versionId)))));
    for (let index = 0; index < ids.length; index++) {
      const source = drafts[index].data()?.generation ?? drafts[index].data()?.importedBundle;
      if (!tests[index].exists || (anchors[index].exists ? anchors[index].data()?.contentHash !== run.items[index].contentHash : !source || tests[index].data()?.status === 'archived' || portableContentHash(source) !== run.items[index].contentHash)) throw new CommandError('failed-precondition', 'Run source must match an authorized saved version in this project.');
    }
    const snapshot = run.items.map((item: Record<string, unknown>) => ({ testId: item.testId, versionId: item.versionId, contentHash: item.contentHash, title: String(item.title ?? '').slice(0, 160) }));
    const snapshotHash = createHash('sha256').update(canonicalJson({ name: run.name, environmentHash: run.environmentHash, items: snapshot.map((item: { testId: unknown; versionId: unknown; contentHash: unknown }) => ({ testId: item.testId, versionId: item.versionId, contentHash: item.contentHash })) })).digest('hex');
    tx.create(target, { id: run.id, organizationId: input.organizationId, projectId: input.projectId, name: run.name.trim(), snapshot, snapshotHash, environmentHash: run.environmentHash, runner: 'desktop-local', clientReported: true, attestedByServer: false, recordedByUid: actor.uid, recordedAt: FieldValue.serverTimestamp() });
    tx.create(project.collection('activity').doc(), { kind: 'run-submitted', runId: run.id, actorUid: actor.uid, at: FieldValue.serverTimestamp() });
    return { runId: run.id, clientReported: true, attestedByServer: false };
  });
}
export async function authorizeLocalRun(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; items: Array<{ testId: string; versionId: string; contentHash: string }>; suiteId?: string; suiteRevision?: number }) {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100 || new Set(input.items.map((item) => item.testId)).size !== input.items.length || input.items.some((item) => !ID.test(String(item.testId)) || !ID.test(String(item.versionId)) || !/^[a-f0-9]{64}$/.test(String(item.contentHash)))) throw new CommandError('invalid-argument', 'Run selection is invalid.');
  return db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    if (input.suiteId) {
      validId(input.suiteId, 'suiteId');
      const suite = await tx.get(projectRef(db, input.organizationId, input.projectId).collection('suites').doc(input.suiteId));
      if (!suite.exists || suite.data()?.revision !== input.suiteRevision || JSON.stringify(suite.data()?.testIds) !== JSON.stringify(input.items.map((item) => item.testId))) throw new CommandError('aborted', 'Suite membership changed before submission. Reload the suite.');
    }
    const tests = await Promise.all(input.items.map((item) => tx.get(testRef(db, input.organizationId, input.projectId, item.testId))));
    const drafts = await Promise.all(input.items.map((item) => tx.get(testRef(db, input.organizationId, input.projectId, item.testId).collection('drafts').doc('current'))));
    const anchors = await Promise.all(input.items.map((item) => tx.get(testRef(db, input.organizationId, input.projectId, item.testId).collection('versionAnchors').doc(item.versionId))));
    for (let index = 0; index < input.items.length; index++) {
      const source = drafts[index].data()?.generation ?? drafts[index].data()?.importedBundle;
      if (!tests[index].exists || tests[index].data()?.status === 'archived' || (anchors[index].exists ? anchors[index].data()?.contentHash !== input.items[index].contentHash : !source || portableContentHash(source) !== input.items[index].contentHash)) throw new CommandError('failed-precondition', 'Selected test is archived, inaccessible, or differs from local saved source.');
    }
    input.items.forEach((item, index) => { if (!anchors[index].exists) tx.create(anchors[index].ref, { id: item.versionId, contentHash: item.contentHash, organizationId: input.organizationId, projectId: input.projectId, testId: item.testId, clientReported: true, createdAt: FieldValue.serverTimestamp() }); });
    return { authorized: true, clientReported: true };
  });
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/;
function validId(value: string, label: string) { if (typeof value !== 'string' || !ID.test(value)) throw new CommandError('invalid-argument', `${label} is invalid.`); }
export function orgRef(db: Firestore, orgId: string) { validId(orgId, 'organizationId'); return db.doc(`organizations/${orgId}`); }
export function memberRef(db: Firestore, orgId: string, uid: string) { validId(uid, 'uid'); return orgRef(db, orgId).collection('members').doc(uid); }
function projectRef(db: Firestore, orgId: string, projectId: string) { validId(projectId, 'projectId'); return orgRef(db, orgId).collection('projects').doc(projectId); }
export function organizationScopeRef(db: Firestore, uid: string, orgId: string) { return db.doc(`userScopes/${uid}/organizations/${orgId}`); }
export function projectScopeRef(db: Firestore, uid: string, orgId: string, projectId: string) { return organizationScopeRef(db, uid, orgId).collection('projects').doc(projectId); }

export async function requireManager(tx: Transaction, db: Firestore, orgId: string, actor: Actor) {
  const member = await tx.get(memberRef(db, orgId, actor.uid));
  const data = member.data();
  if (!member.exists || data?.status !== 'active' || !['owner', 'admin'].includes(data.role)) throw new CommandError('permission-denied', 'An active owner or admin is required.');
  return data as { role: Role };
}

export async function createOrganization(db: Firestore, actor: Actor, input: { organizationId: string; name: string }) {
  validId(input.organizationId, 'organizationId');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new CommandError('invalid-argument', 'Organization name is invalid.');
  return db.runTransaction(async (tx) => {
    const organization = orgRef(db, input.organizationId);
    if ((await tx.get(organization)).exists) throw new CommandError('already-exists', 'Organization already exists.');
    const limit = seatLimit();
    tx.create(organization, { id: input.organizationId, name: input.name.trim(), ownerUids: [actor.uid], createdByUid: actor.uid, createdAt: FieldValue.serverTimestamp(), ...seatFields(1, limit, defaultPlan()) });
    tx.create(memberRef(db, input.organizationId, actor.uid), { uid: actor.uid, organizationId: input.organizationId, role: 'owner', status: 'active', joinedAt: FieldValue.serverTimestamp(), joinedVia: 'owner', ...directoryFields(actor) });
    tx.create(organizationScopeRef(db, actor.uid, input.organizationId), { organizationId: input.organizationId, name: input.name.trim(), role: 'owner', status: 'active', updatedAt: FieldValue.serverTimestamp() });
    return { organizationId: input.organizationId };
  });
}

export async function createInvitation(db: Firestore, actor: Actor, input: { organizationId: string; invitationId: string; email: string; role: Exclude<Role, 'owner'>; tokenHash: string; expiresAt: Date }) {
  validId(input.invitationId, 'invitationId');
  if (!input.email.includes('@') || !/^[a-f0-9]{64}$/.test(input.tokenHash) || input.expiresAt.getTime() <= Date.now()) throw new CommandError('invalid-argument', 'Invitation payload is invalid.');
  return db.runTransaction(async (tx) => {
    const manager = await requireManager(tx, db, input.organizationId, actor);
    if (manager.role === 'admin' && input.role === 'admin') throw new CommandError('permission-denied', 'Only an owner can invite an admin.');
    const invitation = orgRef(db, input.organizationId).collection('invitations').doc(input.invitationId);
    if ((await tx.get(invitation)).exists) throw new CommandError('already-exists', 'Invitation already exists.');
    tx.create(invitation, { id: input.invitationId, organizationId: input.organizationId, email: input.email.toLowerCase(), role: input.role, tokenHash: input.tokenHash, expiresAt: Timestamp.fromDate(input.expiresAt), status: 'pending', createdByUid: actor.uid, createdAt: FieldValue.serverTimestamp() });
    return { invitationId: input.invitationId };
  });
}

export async function acceptInvitation(db: Firestore, actor: Actor, input: { organizationId: string; invitationId: string; tokenHash: string }) {
  validId(input.invitationId, 'invitationId');
  return db.runTransaction(async (tx) => {
    const invitation = orgRef(db, input.organizationId).collection('invitations').doc(input.invitationId);
    const snapshot = await tx.get(invitation); const data = snapshot.data();
    if (!snapshot.exists) throw new CommandError('not-found', 'Invitation does not exist.');
    if (data?.status !== 'pending') throw new CommandError('failed-precondition', 'Invitation was already used.');
    if (data?.tokenHash !== input.tokenHash || !actor.email || data.email !== actor.email.toLowerCase()) throw new CommandError('permission-denied', 'Invitation does not belong to this identity.');
    if (!(data.expiresAt instanceof Timestamp) || data.expiresAt.toMillis() <= Date.now()) throw new CommandError('failed-precondition', 'Invitation expired.');
    const member = memberRef(db, input.organizationId, actor.uid);
    if ((await tx.get(member)).exists) throw new CommandError('already-exists', 'Membership already exists.');
    // Invitations obey the same seat rule as company codes.
    const seats = await readSeats(tx, db, input.organizationId);
    requireSeat(seats, actor.uid);
    const projects = await readAuthorizedProjects(tx, db, input.organizationId, actor.uid);
    writeActiveMembership(tx, db, {
      orgId: input.organizationId, organizationName: String(seats.organization.data()?.name ?? input.organizationId), uid: actor.uid, role: data.role as Role, projects,
      member: { joinedAt: FieldValue.serverTimestamp(), invitationId: input.invitationId, joinedVia: 'invitation', ...directoryFields(actor) },
    });
    tx.update(seats.organization.ref, seatFields(seats.activeUids.size + 1, seats.limit, planKind(seats.organization.data())));
    tx.update(invitation, { status: 'accepted', acceptedByUid: actor.uid, acceptedAt: FieldValue.serverTimestamp() });
    return { organizationId: input.organizationId, role: data.role as Role };
  });
}

// Where a project's tests live. The storage folder path is personal to each
// machine and never stored here, only the choice.
export type TestStorage = 'local' | 'cloud' | 'folder';
const TEST_STORAGES: readonly TestStorage[] = ['local', 'cloud', 'folder'];

/** SaySpec Cloud storage is a Pro feature (the Beta plan). */
function requireAllowedTestStorage(storage: TestStorage, organization: DocumentData | undefined) {
  if (storage !== 'cloud') return;
  if (!isProPlan(planKind(organization))) throw new CommandError('failed-precondition', 'SaySpec Cloud storage requires the Pro plan.', { reason: 'plan-required' });
}

export async function createProject(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; name: string; targetType: 'web' | 'flutter'; baseUrl?: string; access: 'all-members' | 'restricted'; testStorage?: TestStorage }) {
  validId(input.projectId, 'projectId');
  if (!input.name.trim() || input.name.length > 120) throw new CommandError('invalid-argument', 'Project name is invalid.');
  if (!['web', 'flutter'].includes(input.targetType)) throw new CommandError('invalid-argument', 'Choose Web or Flutter.');
  if (input.testStorage !== undefined && !TEST_STORAGES.includes(input.testStorage)) throw new CommandError('invalid-argument', 'Test storage is invalid.');
  const baseUrl = input.targetType === 'web' ? normalizedBaseUrl(input.baseUrl) : undefined;
  return db.runTransaction(async (tx) => {
    await requireManager(tx, db, input.organizationId, actor);
    const organization = (await tx.get(orgRef(db, input.organizationId))).data();
    // Clients that predate the choice get the best storage the plan allows.
    const testStorage: TestStorage = input.testStorage ?? (isProPlan(planKind(organization)) ? 'cloud' : 'local');
    requireAllowedTestStorage(testStorage, organization);
    const project = projectRef(db, input.organizationId, input.projectId);
    if ((await tx.get(project)).exists) throw new CommandError('already-exists', 'Project already exists.');
    const members = input.access === 'all-members'
      ? await tx.get(orgRef(db, input.organizationId).collection('members').where('status', '==', 'active'))
      : undefined;
    const projectData = { id: input.projectId, organizationId: input.organizationId, name: input.name.trim(), targetType: input.targetType, access: input.access, testStorage, ...(baseUrl ? { baseUrl } : {}), createdByUid: actor.uid, createdAt: FieldValue.serverTimestamp() };
    tx.create(project, projectData);
    const projectScope = { organizationId: input.organizationId, projectId: input.projectId, name: input.name.trim(), targetType: input.targetType, access: input.access, testStorage, ...(baseUrl ? { baseUrl } : {}), updatedAt: FieldValue.serverTimestamp() };
    tx.set(projectScopeRef(db, actor.uid, input.organizationId, input.projectId), projectScope);
    members?.docs.forEach((member) => tx.set(projectScopeRef(db, member.id, input.organizationId, input.projectId), projectScope));
    return { projectId: input.projectId };
  });
}

/**
 * Switches where a project's tests live, for everyone in the project. The
 * desktop copies the tests into the new storage before switching; tests in the
 * previous storage are left in place.
 */
export async function setProjectTestStorage(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; testStorage: TestStorage }) {
  if (!TEST_STORAGES.includes(input.testStorage)) throw new CommandError('invalid-argument', 'Test storage is invalid.');
  return db.runTransaction(async (tx) => {
    await requireManager(tx, db, input.organizationId, actor);
    const organization = (await tx.get(orgRef(db, input.organizationId))).data();
    const project = projectRef(db, input.organizationId, input.projectId);
    const snapshot = await tx.get(project);
    if (!snapshot.exists) throw new CommandError('not-found', 'Project does not exist.');
    requireAllowedTestStorage(input.testStorage, organization);
    const members = await tx.get(orgRef(db, input.organizationId).collection('members'));
    const scopes = await Promise.all(members.docs.map((member) => tx.get(projectScopeRef(db, member.id, input.organizationId, input.projectId))));
    tx.update(project, { testStorage: input.testStorage, testStorageChangedAt: FieldValue.serverTimestamp(), testStorageChangedByUid: actor.uid });
    scopes.filter((scope) => scope.exists).forEach((scope) => tx.update(scope.ref, { testStorage: input.testStorage, updatedAt: FieldValue.serverTimestamp() }));
    tx.create(auditRef(db, input.organizationId), { type: 'project.test-storage-changed', actorUid: actor.uid, projectId: input.projectId, from: snapshot.data()?.testStorage ?? null, to: input.testStorage, at: FieldValue.serverTimestamp() });
    return { projectId: input.projectId, testStorage: input.testStorage };
  });
}

const MAX_TEST_INSTRUCTIONS_BYTES = 64 * 1024;

/** Saves the project's shared test instructions (its SAYSPEC.md) for SaySpec Cloud storage. Anyone who can author tests may edit them. */
export async function setProjectTestInstructions(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; text: string }) {
  if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > MAX_TEST_INSTRUCTIONS_BYTES) throw new CommandError('invalid-argument', 'Test instructions must be text of at most 64 KB.');
  return db.runTransaction(async (tx) => {
    const project = await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const instructions = project.ref.collection('config').doc('testInstructions');
    const current = await tx.get(instructions);
    if (current.exists && current.data()?.text === input.text) return { projectId: input.projectId, revision: Number(current.data()?.revision ?? 0) };
    const revision = Number(current.data()?.revision ?? 0) + 1;
    tx.set(instructions, { text: input.text, revision, updatedAt: FieldValue.serverTimestamp(), updatedByUid: actor.uid });
    return { projectId: input.projectId, revision };
  });
}

/** Removes the project for every member, then its whole subtree (tests, versions, runs, grants, environments). */
export async function deleteProject(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string }) {
  const project = projectRef(db, input.organizationId, input.projectId);
  await db.runTransaction(async (tx) => {
    await requireManager(tx, db, input.organizationId, actor);
    const snapshot = await tx.get(project);
    if (!snapshot.exists) throw new CommandError('not-found', 'Project does not exist.');
    const members = await tx.get(orgRef(db, input.organizationId).collection('members'));
    members.docs.forEach((member) => tx.delete(projectScopeRef(db, member.id, input.organizationId, input.projectId)));
    tx.delete(project);
    tx.create(auditRef(db, input.organizationId), { type: 'project.deleted', actorUid: actor.uid, projectId: input.projectId, name: snapshot.data()?.name ?? input.projectId, at: FieldValue.serverTimestamp() });
  });
  await db.recursiveDelete(project);
  return { projectId: input.projectId };
}

export async function setProjectGrant(db: Firestore, actor: Actor, input: { organizationId: string; projectId: string; uid: string; access: 'editor' | 'reviewer' | 'viewer' }) {
  return db.runTransaction(async (tx) => {
    await requireManager(tx, db, input.organizationId, actor);
    const project = projectRef(db, input.organizationId, input.projectId);
    const projectSnapshot = await tx.get(project);
    if (!projectSnapshot.exists) throw new CommandError('not-found', 'Project does not exist.');
    const member = await tx.get(memberRef(db, input.organizationId, input.uid));
    if (!member.exists || member.data()?.status !== 'active') throw new CommandError('failed-precondition', 'Project grants require an active organization member.');
    tx.set(project.collection('grants').doc(input.uid), { uid: input.uid, organizationId: input.organizationId, projectId: input.projectId, access: input.access, grantedByUid: actor.uid, grantedAt: FieldValue.serverTimestamp() });
    const projectData = projectSnapshot.data();
    tx.set(projectScopeRef(db, input.uid, input.organizationId, input.projectId), { organizationId: input.organizationId, projectId: input.projectId, name: projectData?.name ?? input.projectId, targetType: projectData?.targetType, access: input.access, ...(typeof projectData?.testStorage === 'string' ? { testStorage: projectData.testStorage } : {}), updatedAt: FieldValue.serverTimestamp() });
  });
}

/**
 * Sets a Web project's base URL, the default start URL for recording and runs.
 * Desktop builds up to v0.10.0 send `{ targetType, environment }` instead, and
 * for Flutter an app ID and flavor that entry points replaced: those saves are
 * accepted and change nothing.
 */
export async function configureProject(db: Firestore, actor: Actor, input: {
  organizationId: string; projectId: string; baseUrl?: string;
  targetType?: 'web' | 'flutter'; environment?: { baseUrl?: string };
}) {
  const baseUrl = input.targetType === 'flutter' ? undefined : normalizedBaseUrl(input.baseUrl ?? input.environment?.baseUrl);
  return db.runTransaction(async (tx) => {
    await requireManager(tx, db, input.organizationId, actor);
    const project = projectRef(db, input.organizationId, input.projectId);
    const snapshot = await tx.get(project);
    if (!snapshot.exists) throw new CommandError('not-found', 'Project does not exist.');
    if (!baseUrl) return { projectId: input.projectId };
    if (snapshot.data()?.targetType !== 'web') throw new CommandError('failed-precondition', 'Only Web projects have a base URL.');
    const members = await tx.get(orgRef(db, input.organizationId).collection('members').where('status', '==', 'active'));
    const grants = await tx.get(project.collection('grants'));
    tx.update(project, { baseUrl, configuredAt: FieldValue.serverTimestamp(), configuredByUid: actor.uid });
    const granted = new Set(grants.docs.map((grant) => grant.id));
    members.docs.filter((member) => snapshot.data()?.access === 'all-members' || ['owner', 'admin'].includes(member.data().role) || granted.has(member.id))
      .forEach((member) => tx.set(projectScopeRef(db, member.id, input.organizationId, input.projectId), { baseUrl, updatedAt: FieldValue.serverTimestamp() }, { merge: true }));
    return { projectId: input.projectId };
  });
}

const ROLES: readonly Role[] = ['owner', 'admin', 'editor', 'reviewer', 'viewer'];
export async function changeMemberRole(db: Firestore, actor: Actor, input: { organizationId: string; uid: string; role?: Role; status?: 'active' | 'revoked' }) {
  if (input.role !== undefined && !ROLES.includes(input.role)) throw new CommandError('invalid-argument', 'Role is invalid.');
  if (input.status !== undefined && input.status !== 'active' && input.status !== 'revoked') throw new CommandError('invalid-argument', 'Membership status is invalid.');
  if (input.role === undefined && input.status === undefined) throw new CommandError('invalid-argument', 'Choose a role or membership status.');
  return db.runTransaction(async (tx) => {
    const manager = await requireManager(tx, db, input.organizationId, actor);
    const organization = orgRef(db, input.organizationId);
    const target = memberRef(db, input.organizationId, input.uid);
    const member = await tx.get(target); const data = member.data();
    const scopedProjects = await tx.get(organizationScopeRef(db, input.uid, input.organizationId).collection('projects'));
    const seats = await readSeats(tx, db, input.organizationId);
    const org = seats.organization;
    if (!member.exists) throw new CommandError('not-found', 'Member does not exist.');
    const currentlyActive = data?.status === 'active';
    const nextStatus = input.status ?? data?.status;
    const nextRole = (input.role ?? data?.role) as Role;
    const activates = !currentlyActive && nextStatus === 'active';
    const revokes = currentlyActive && nextStatus === 'revoked';
    if (manager.role !== 'owner' && (data?.role === 'owner' || input.role === 'owner' || input.role === 'admin' || (activates && data?.role === 'admin'))) throw new CommandError('permission-denied', 'Only an owner can change elevated roles.');
    if (actor.uid === input.uid && input.role && input.role !== data?.role) throw new CommandError('permission-denied', 'Members cannot change their own role.');
    const owners = (org.data()?.ownerUids ?? []) as string[];
    const removesOwner = data?.role === 'owner' && currentlyActive && (nextRole !== 'owner' || nextStatus === 'revoked');
    if (removesOwner && owners.length <= 1) throw new CommandError('failed-precondition', 'The last owner cannot be removed.');
    // Reactivation takes a seat and must obey the current capacity rule.
    if (activates) requireSeat(seats, input.uid);
    const projects = activates ? await readAuthorizedProjects(tx, db, input.organizationId, input.uid) : [];
    const grants = revokes ? await Promise.all((await tx.get(organization.collection('projects'))).docs.map((project) => tx.get(project.ref.collection('grants').doc(input.uid)))) : [];
    const audit = { actorUid: actor.uid, targetUid: input.uid, at: FieldValue.serverTimestamp() };
    if (activates) {
      writeActiveMembership(tx, db, {
        orgId: input.organizationId, organizationName: String(org.data()?.name ?? input.organizationId), uid: input.uid, role: nextRole, projects,
        member: { ...data, changedByUid: actor.uid, changedAt: FieldValue.serverTimestamp(), reactivatedAt: FieldValue.serverTimestamp() },
      });
      tx.create(auditRef(db, input.organizationId), { ...audit, type: 'member.reactivated', role: nextRole });
    } else {
      const update: Record<string, unknown> = { changedByUid: actor.uid, changedAt: FieldValue.serverTimestamp() };
      if (input.role) update.role = input.role;
      if (input.status) update.status = input.status;
      tx.update(target, update);
      if (nextStatus === 'active') {
        tx.set(organizationScopeRef(db, input.uid, input.organizationId), { organizationId: input.organizationId, name: String(org.data()?.name ?? input.organizationId), role: nextRole, status: 'active', updatedAt: FieldValue.serverTimestamp() });
      } else {
        // Revoked (or still revoked): no scope documents and no stale project
        // grants, so a later rejoin starts from the join role alone.
        scopedProjects.docs.forEach((project) => tx.delete(project.ref));
        tx.delete(organizationScopeRef(db, input.uid, input.organizationId));
        grants.filter((grant) => grant.exists).forEach((grant) => tx.delete(grant.ref));
      }
      tx.create(auditRef(db, input.organizationId), { ...audit, type: revokes ? 'member.removed' : 'member.changed', ...(input.role ? { role: input.role } : {}) });
    }
    let nextOwners = owners;
    if (removesOwner) nextOwners = owners.filter((uid) => uid !== input.uid);
    if (nextStatus === 'active' && nextRole === 'owner' && !owners.includes(input.uid)) nextOwners = [...owners, input.uid];
    const activeCount = seats.activeUids.size + (activates ? 1 : 0) - (revokes ? 1 : 0);
    tx.update(organization, { ...seatFields(activeCount, seats.limit, planKind(seats.organization.data())), ...(nextOwners !== owners ? { ownerUids: nextOwners } : {}) });
  });
}
