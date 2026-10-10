export const CONTRACT_SCHEMA_VERSION = '1.0.0' as const;
export type ContractSchemaVersion = typeof CONTRACT_SCHEMA_VERSION;

export type TargetType = 'web' | 'flutter';
export type Framework = 'playwright' | 'patrol';
export type IsoTimestamp = string;
export type Sha256 = string;

export interface TenantScope { organizationId: string; projectId: string; }

export interface ImmutableIdentity extends TenantScope {
  schemaVersion: ContractSchemaVersion;
  id: string;
  createdAt: IsoTimestamp;
  createdByUid: string;
}

export interface ArtifactRef {
  id: string;
  relativePath: string;
  sha256: Sha256;
  byteLength: number;
  mimeType: string;
  storage: 'firestore' | 'cloud-storage' | 'local-file';
  /** Present only for bounded Firestore text artifacts. */
  text?: string;
}

export interface RecordingSegment {
  id: string;
  startMs: number;
  endMs: number;
  pausedAfter: boolean;
  audioArtifactId?: string;
}
export interface RecordingEvent {
  id: string;
  segmentId: string;
  elapsedMs: number;
  context: string;
  action: 'click' | 'input' | 'navigation' | 'key' | 'device-action' | 'observation';
  targetDescription: string;
  /** Captured only for non-sensitive inputs. */
  value?: string;
  pageId?: string;
  frameUrl?: string;
  locatorCandidates?: readonly string[];
  evidenceArtifactIds: readonly string[];
}

export interface RecordingManifest extends ImmutableIdentity {
  kind: 'recording';
  targetType: TargetType;
  environmentSnapshotId: string;
  captureAdapter: { name: string; version: string };
  sessionId: string;
  timebase: 'monotonic-ms';
  segments: readonly RecordingSegment[];
  events: readonly RecordingEvent[];
  artifacts: readonly ArtifactRef[];
  completenessWarnings: readonly string[];
}

export interface IntentStep {
  id: string;
  action: string;
  target: string;
  value?: string;
  allowedVariation?: string;
  expectedOutcome?: string;
  evidenceIds: readonly string[];
}
export interface IntentDefinition {
  prerequisites: readonly string[];
  steps: readonly IntentStep[];
  unresolvedQuestions: readonly string[];
}

export interface RuntimeManifest {
  schemaVersion: ContractSchemaVersion;
  id: string;
  framework: Framework;
  frameworkVersion: string;
  adapterVersion: string;
  entrypoint: string;
  files: readonly ArtifactRef[];
  dependencies: Readonly<Record<string, string>>;
  requiredCapabilities: readonly string[];
  secretPlaceholders: readonly string[];
}

export interface TestVersion extends ImmutableIdentity {
  kind: 'test-version';
  testId: string;
  version: number;
  publishedAt: IsoTimestamp;
  publishedByUid: string;
  source: 'manual' | 'recording' | 'approved-proposal' | 'import';
  recordingId?: string;
  parentVersionId?: string;
  intent: IntentDefinition;
  runtime: RuntimeManifest | null;
  contentHash: Sha256;
}

export type AttemptState = 'queued' | 'preparing' | 'running' | 'finalizing'
  | 'passed' | 'failed' | 'blocked' | 'canceled' | 'infrastructure-error';
export interface RunAttempt extends ImmutableIdentity {
  kind: 'attempt';
  runPlanId: string;
  testVersionId: string;
  testVersionHash: Sha256;
  environmentSnapshotId: string;
  executionManifestHash: Sha256;
  state: AttemptState;
  startedAt?: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  runner: { kind: 'desktop-local' | 'customer-runner'; version: string; machineLabel?: string };
}

export type ResultOutcome = 'passed' | 'failed' | 'blocked' | 'canceled'
  | 'infrastructure-error' | 'skipped' | 'not-run';
export interface TestResult extends ImmutableIdentity {
  kind: 'test-result';
  attemptId: string;
  testVersionId: string;
  testVersionHash: Sha256;
  outcome: ResultOutcome;
  expected: string;
  actual: string;
  artifactIds: readonly string[];
  completedAt: IsoTimestamp;
}

export interface FailureAnalysis extends ImmutableIdentity {
  kind: 'analysis';
  resultId: string;
  category: 'application' | 'test' | 'environment' | 'uncertain';
  expected: string;
  actual: string;
  evidenceArtifactIds: readonly string[];
  confidence: 'low' | 'medium' | 'high';
  limitations: readonly string[];
  recommendedAction: string;
}

export interface FixProposal extends ImmutableIdentity {
  kind: 'proposal';
  analysisId: string;
  target: 'test' | 'application';
  baseTestVersionId: string;
  baseContentHash: Sha256;
  patchArtifact: ArtifactRef;
  proposalHash: Sha256;
  affectedPaths: readonly string[];
  assertionChanges: readonly string[];
  approval: null | {
    approvedByUid: string;
    approvedAt: IsoTimestamp;
    proposalHash: Sha256;
    baseContentHash: Sha256;
  };
}

export type JobState = 'queued' | 'preparing' | 'running' | 'cancel-requested'
  | 'finalizing' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
export type JobErrorCode = 'invalid-input' | 'unauthenticated' | 'forbidden'
  | 'not-found' | 'conflict' | 'offline' | 'missing-capability' | 'resource-busy'
  | 'disk-full' | 'timeout' | 'provider-error' | 'process-crash' | 'integrity-error'
  | 'unsupported-schema' | 'canceled' | 'unknown';
export interface JobProgressEvent {
  sequence: number;
  at: IsoTimestamp;
  phase: string;
  message: string;
  completedUnits?: number;
  totalUnits?: number;
}
export interface JobRecord extends ImmutableIdentity {
  kind: 'job';
  jobType: string;
  idempotencyKey: string;
  inputHash: Sha256;
  state: JobState;
  progress: readonly JobProgressEvent[];
  cancellationRequestedAt?: IsoTimestamp;
  terminal?: {
    at: IsoTimestamp;
    outcome: 'succeeded' | 'failed' | 'canceled' | 'interrupted';
    resultId?: string;
    error?: { code: JobErrorCode; message: string; retryable: boolean };
  };
}

export interface TraceBundle {
  recording: RecordingManifest;
  version: TestVersion;
  attempt: RunAttempt;
  result: TestResult;
  analysis: FailureAnalysis;
  proposal: FixProposal;
}

export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['preparing', 'cancel-requested', 'canceled'],
  preparing: ['running', 'cancel-requested', 'failed', 'canceled', 'interrupted'],
  running: ['cancel-requested', 'finalizing', 'failed', 'canceled', 'interrupted'],
  'cancel-requested': ['finalizing', 'failed', 'canceled', 'interrupted'],
  finalizing: ['succeeded', 'failed', 'canceled', 'interrupted'],
  succeeded: [], failed: [], canceled: [], interrupted: [],
};
