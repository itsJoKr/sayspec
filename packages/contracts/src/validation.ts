import {
  CONTRACT_SCHEMA_VERSION, JOB_TRANSITIONS,
  type ArtifactRef, type FixProposal, type JobState, type RecordingManifest,
  type JobRecord, type RunAttempt, type TestResult, type TestVersion, type TraceBundle,
} from './domain.ts';

export const CONTRACT_BUDGETS = Object.freeze({
  firestoreTextArtifactBytes: 128 * 1024,
  artifactCount: 512,
  pathBytes: 512,
  progressEvents: 2_000,
  progressMessageBytes: 4 * 1024,
  portableBundleBytes: 512 * 1024 * 1024,
});

export class ContractValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Contract validation failed: ${issues.join('; ')}`);
    this.name = 'ContractValidationError';
    this.issues = issues;
  }
}

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function issue(condition: unknown, message: string, issues: string[]): asserts condition {
  if (!condition) issues.push(message);
}
function object(value: unknown, label: string, issues: string[]): Record<string, unknown> {
  issue(typeof value === 'object' && value !== null && !Array.isArray(value), `${label} must be an object`, issues);
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown, label: string, issues: string[]) {
  issue(typeof value === 'string' && value.length > 0, `${label} must be a non-empty string`, issues);
  return typeof value === 'string' ? value : '';
}
function identity(value: Record<string, unknown>, label: string, issues: string[]) {
  issue(value.schemaVersion === CONTRACT_SCHEMA_VERSION, `${label}.schemaVersion must be ${CONTRACT_SCHEMA_VERSION}`, issues);
  for (const key of ['id', 'organizationId', 'projectId', 'createdByUid'] as const) {
    const current = string(value[key], `${label}.${key}`, issues);
    issue(ID.test(current), `${label}.${key} has an invalid format`, issues);
  }
  const createdAt = string(value.createdAt, `${label}.createdAt`, issues);
  issue(ISO.test(createdAt), `${label}.createdAt must be an ISO UTC timestamp`, issues);
}

export function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || new TextEncoder().encode(relativePath).byteLength > CONTRACT_BUDGETS.pathBytes) return false;
  if (relativePath.includes('\\') || relativePath.includes('\0') || relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath)) return false;
  return relativePath.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function artifact(value: unknown, label: string, issues: string[]): ArtifactRef {
  const item = object(value, label, issues);
  const id = string(item.id, `${label}.id`, issues);
  issue(ID.test(id), `${label}.id has an invalid format`, issues);
  const relativePath = string(item.relativePath, `${label}.relativePath`, issues);
  issue(isSafeRelativePath(relativePath), `${label}.relativePath is unsafe`, issues);
  const sha256 = string(item.sha256, `${label}.sha256`, issues);
  issue(SHA256.test(sha256), `${label}.sha256 must be lowercase SHA-256`, issues);
  issue(Number.isSafeInteger(item.byteLength) && Number(item.byteLength) >= 0, `${label}.byteLength is invalid`, issues);
  issue(item.storage === 'firestore' || item.storage === 'cloud-storage' || item.storage === 'local-file', `${label}.storage is invalid`, issues);
  string(item.mimeType, `${label}.mimeType`, issues);
  if (item.storage === 'firestore') {
    issue(typeof item.text === 'string', `${label}.text is required for Firestore artifacts`, issues);
    const bytes = typeof item.text === 'string' ? new TextEncoder().encode(item.text).byteLength : 0;
    issue(bytes === item.byteLength, `${label}.byteLength does not match text bytes`, issues);
    issue(bytes <= CONTRACT_BUDGETS.firestoreTextArtifactBytes, `${label} exceeds the Firestore text budget`, issues);
  } else issue(item.text === undefined, `${label}.text must not be embedded for binary artifacts`, issues);
  return item as unknown as ArtifactRef;
}

function assertNoMutableHistoryFields(value: Record<string, unknown>, label: string, issues: string[]) {
  for (const key of ['updatedAt', 'lastModifiedAt', 'revision', 'currentVersionId']) {
    issue(!(key in value), `${label}.${key} is not allowed on immutable history`, issues);
  }
}

export function validateRecordingManifest(input: unknown): RecordingManifest {
  const issues: string[] = [];
  const value = object(input, 'recording', issues);
  identity(value, 'recording', issues);
  assertNoMutableHistoryFields(value, 'recording', issues);
  issue(value.kind === 'recording', 'recording.kind must be recording', issues);
  issue(value.targetType === 'web' || value.targetType === 'flutter', 'recording.targetType is invalid', issues);
  issue(value.timebase === 'monotonic-ms', 'recording.timebase must be monotonic-ms', issues);
  string(value.environmentSnapshotId, 'recording.environmentSnapshotId', issues);
  string(value.sessionId, 'recording.sessionId', issues);
  const segments = Array.isArray(value.segments) ? value.segments : [];
  issue(Array.isArray(value.segments), 'recording.segments must be an array', issues);
  let previousEnd = -1;
  for (const [index, segmentInput] of segments.entries()) {
    const segment = object(segmentInput, `recording.segments[${index}]`, issues);
    issue(Number.isSafeInteger(segment.startMs) && Number(segment.startMs) >= 0, `recording.segments[${index}].startMs is invalid`, issues);
    issue(Number.isSafeInteger(segment.endMs) && Number(segment.endMs) > Number(segment.startMs), `recording.segments[${index}].endMs is invalid`, issues);
    issue(Number(segment.startMs) >= previousEnd, `recording.segments[${index}] overlaps the previous segment`, issues);
    previousEnd = Number(segment.endMs);
  }
  const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
  issue(artifacts.length <= CONTRACT_BUDGETS.artifactCount, 'recording has too many artifacts', issues);
  artifacts.forEach((entry, index) => artifact(entry, `recording.artifacts[${index}]`, issues));
  const artifactIds = new Set(artifacts.map((entry) => object(entry, 'recording artifact', issues).id));
  const segmentIds = new Set(segments.map((entry) => object(entry, 'recording segment', issues).id));
  for (const [index, segmentInput] of segments.entries()) {
    const segment = object(segmentInput, `recording.segments[${index}]`, issues);
    if (segment.audioArtifactId !== undefined) issue(artifactIds.has(segment.audioArtifactId), `recording.segments[${index}] references missing audio artifact`, issues);
  }
  const events = Array.isArray(value.events) ? value.events : [];
  issue(Array.isArray(value.events), 'recording.events must be an array', issues);
  for (const [index, eventInput] of events.entries()) {
    const event = object(eventInput, `recording.events[${index}]`, issues);
    issue(segmentIds.has(event.segmentId), `recording.events[${index}] references a missing segment`, issues);
    issue(Number.isSafeInteger(event.elapsedMs) && Number(event.elapsedMs) >= 0, `recording.events[${index}].elapsedMs is invalid`, issues);
    issue(['click', 'input', 'navigation', 'key', 'device-action', 'observation'].includes(String(event.action)), `recording.events[${index}].action is invalid`, issues);
    string(event.targetDescription, `recording.events[${index}].targetDescription`, issues);
    const evidence = Array.isArray(event.evidenceArtifactIds) ? event.evidenceArtifactIds : [];
    issue(Array.isArray(event.evidenceArtifactIds), `recording.events[${index}].evidenceArtifactIds must be an array`, issues);
    evidence.forEach((id) => issue(artifactIds.has(id), `recording.events[${index}] references missing artifact ${String(id)}`, issues));
  }
  if (issues.length) throw new ContractValidationError(issues);
  return input as RecordingManifest;
}

export function validateTestVersion(input: unknown): TestVersion {
  const issues: string[] = [];
  const value = object(input, 'version', issues);
  identity(value, 'version', issues);
  assertNoMutableHistoryFields(value, 'version', issues);
  issue(value.kind === 'test-version', 'version.kind must be test-version', issues);
  issue(Number.isSafeInteger(value.version) && Number(value.version) > 0, 'version.version must be positive', issues);
  issue(ISO.test(String(value.publishedAt)), 'version.publishedAt must be an ISO UTC timestamp', issues);
  issue(SHA256.test(String(value.contentHash)), 'version.contentHash must be lowercase SHA-256', issues);
  const runtime = value.runtime;
  if (runtime !== null) {
    const manifest = object(runtime, 'version.runtime', issues);
    issue(manifest.schemaVersion === CONTRACT_SCHEMA_VERSION, `version.runtime.schemaVersion must be ${CONTRACT_SCHEMA_VERSION}`, issues);
    issue(manifest.framework === 'playwright' || manifest.framework === 'patrol', 'version.runtime.framework is invalid', issues);
    const entrypoint = string(manifest.entrypoint, 'version.runtime.entrypoint', issues);
    issue(isSafeRelativePath(entrypoint), 'version.runtime.entrypoint is unsafe', issues);
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    issue(files.length <= CONTRACT_BUDGETS.artifactCount, 'version.runtime has too many files', issues);
    const paths = new Set<string>();
    files.forEach((entry, index) => {
      const file = artifact(entry, `version.runtime.files[${index}]`, issues);
      issue(!paths.has(file.relativePath), `version.runtime has duplicate path ${file.relativePath}`, issues);
      paths.add(file.relativePath);
    });
    issue(paths.has(entrypoint), 'version.runtime.entrypoint must reference a declared file', issues);
  }
  if (issues.length) throw new ContractValidationError(issues);
  return input as TestVersion;
}

export function validateTraceBundle(input: unknown): TraceBundle {
  const issues: string[] = [];
  const bundle = object(input, 'bundle', issues);
  let recording: RecordingManifest | undefined;
  let version: TestVersion | undefined;
  try { recording = validateRecordingManifest(bundle.recording); } catch (error) {
    if (error instanceof ContractValidationError) issues.push(...error.issues);
  }
  try { version = validateTestVersion(bundle.version); } catch (error) {
    if (error instanceof ContractValidationError) issues.push(...error.issues);
  }
  const attempt = object(bundle.attempt, 'attempt', issues) as unknown as RunAttempt;
  const result = object(bundle.result, 'result', issues) as unknown as TestResult;
  const analysis = object(bundle.analysis, 'analysis', issues);
  const proposal = object(bundle.proposal, 'proposal', issues) as unknown as FixProposal;
  for (const [label, entity] of [['attempt', attempt], ['result', result], ['analysis', analysis], ['proposal', proposal]] as const) {
    identity(entity as unknown as Record<string, unknown>, label, issues);
    assertNoMutableHistoryFields(entity as unknown as Record<string, unknown>, label, issues);
  }
  issue(attempt.kind === 'attempt', 'attempt.kind must be attempt', issues);
  issue(result.kind === 'test-result', 'result.kind must be test-result', issues);
  issue(analysis.kind === 'analysis', 'analysis.kind must be analysis', issues);
  issue(proposal.kind === 'proposal', 'proposal.kind must be proposal', issues);
  issue(SHA256.test(String(attempt.testVersionHash)), 'attempt.testVersionHash must be lowercase SHA-256', issues);
  issue(SHA256.test(String(result.testVersionHash)), 'result.testVersionHash must be lowercase SHA-256', issues);
  issue(SHA256.test(String(proposal.proposalHash)), 'proposal.proposalHash must be lowercase SHA-256', issues);
  if (recording && version) {
    const scope = `${recording.organizationId}/${recording.projectId}`;
    for (const [label, entity] of [['version', version], ['attempt', attempt], ['result', result], ['analysis', analysis], ['proposal', proposal]] as const) {
      issue(`${entity.organizationId}/${entity.projectId}` === scope, `${label} crosses the recording tenant scope`, issues);
    }
    issue(version.recordingId === recording.id, 'version does not reference the recording', issues);
    issue(attempt.testVersionId === version.id, 'attempt does not reference the version', issues);
    issue(attempt.testVersionHash === version.contentHash, 'attempt version hash mismatch', issues);
    issue(result.attemptId === attempt.id, 'result does not reference the attempt', issues);
    issue(result.testVersionId === version.id && result.testVersionHash === version.contentHash, 'result version identity/hash mismatch', issues);
    issue(analysis.resultId === result.id, 'analysis does not reference the result', issues);
    issue(proposal.analysisId === analysis.id, 'proposal does not reference the analysis', issues);
    issue(proposal.baseTestVersionId === version.id && proposal.baseContentHash === version.contentHash, 'proposal base identity/hash mismatch', issues);
    artifact(proposal.patchArtifact, 'proposal.patchArtifact', issues);
    const affectedPaths = Array.isArray(proposal.affectedPaths) ? proposal.affectedPaths : [];
    issue(Array.isArray(proposal.affectedPaths), 'proposal.affectedPaths must be an array', issues);
    affectedPaths.forEach((path, index) => issue(typeof path === 'string' && isSafeRelativePath(path), `proposal.affectedPaths[${index}] is unsafe`, issues));
    if (proposal.approval) {
      issue(proposal.approval.proposalHash === proposal.proposalHash, 'approval proposal hash mismatch', issues);
      issue(proposal.approval.baseContentHash === proposal.baseContentHash, 'approval base hash mismatch', issues);
    }
  }
  if (issues.length) throw new ContractValidationError(issues);
  return input as TraceBundle;
}

export function canTransitionJob(from: JobState, to: JobState): boolean { return JOB_TRANSITIONS[from].includes(to); }

export function validateJobRecord(input: unknown): JobRecord {
  const issues: string[] = [];
  const value = object(input, 'job', issues);
  identity(value, 'job', issues);
  issue(value.kind === 'job', 'job.kind must be job', issues);
  const states = Object.keys(JOB_TRANSITIONS);
  issue(states.includes(String(value.state)), 'job.state is invalid', issues);
  string(value.jobType, 'job.jobType', issues);
  string(value.idempotencyKey, 'job.idempotencyKey', issues);
  issue(SHA256.test(String(value.inputHash)), 'job.inputHash must be lowercase SHA-256', issues);
  const progress = Array.isArray(value.progress) ? value.progress : [];
  issue(Array.isArray(value.progress), 'job.progress must be an array', issues);
  issue(progress.length <= CONTRACT_BUDGETS.progressEvents, 'job has too many progress events', issues);
  let previousSequence = -1;
  progress.forEach((entry, index) => {
    const event = object(entry, `job.progress[${index}]`, issues);
    issue(Number.isSafeInteger(event.sequence) && Number(event.sequence) > previousSequence, `job.progress[${index}].sequence must increase`, issues);
    previousSequence = Number(event.sequence);
    const message = string(event.message, `job.progress[${index}].message`, issues);
    issue(new TextEncoder().encode(message).byteLength <= CONTRACT_BUDGETS.progressMessageBytes, `job.progress[${index}].message is too large`, issues);
  });
  const terminalStates = ['succeeded', 'failed', 'canceled', 'interrupted'];
  issue(terminalStates.includes(String(value.state)) === (value.terminal !== undefined), 'job terminal payload must match terminal state', issues);
  if (issues.length) throw new ContractValidationError(issues);
  return input as JobRecord;
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
export async function verifyInlineArtifactHash(ref: ArtifactRef): Promise<boolean> {
  if (ref.storage !== 'firestore' || ref.text === undefined) return true;
  return ref.sha256 === await sha256Hex(new TextEncoder().encode(ref.text));
}

export async function validateTraceBundleIntegrity(input: unknown): Promise<TraceBundle> {
  const bundle = validateTraceBundle(input);
  const refs = [
    ...bundle.recording.artifacts,
    ...(bundle.version.runtime?.files ?? []),
    bundle.proposal.patchArtifact,
  ];
  const mismatches: string[] = [];
  for (const ref of refs) if (!await verifyInlineArtifactHash(ref)) mismatches.push(`artifact ${ref.id} hash mismatch`);
  if (mismatches.length) throw new ContractValidationError(mismatches);
  return bundle;
}

export interface LegacyRecordingV09 {
  schemaVersion: '0.9.0'; id: string; orgId: string; projectId: string;
  userId: string; createdAt: string; target: 'web' | 'flutter'; sessionId: string;
}
/** Pure, idempotent example migration. The caller persists the new record separately. */
export function migrateRecordingV09(input: LegacyRecordingV09): RecordingManifest {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION, kind: 'recording', id: input.id,
    organizationId: input.orgId, projectId: input.projectId, createdByUid: input.userId,
    createdAt: input.createdAt, targetType: input.target, environmentSnapshotId: 'env_unknown',
    captureAdapter: { name: 'legacy-import', version: '0.9.0' }, sessionId: input.sessionId,
    timebase: 'monotonic-ms', segments: [], events: [], artifacts: [],
    completenessWarnings: ['Migrated legacy recording has no environment snapshot or timeline.'],
  };
}
