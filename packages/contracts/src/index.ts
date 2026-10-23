export * from './domain.ts';
export * from './validation.ts';
export * from './fixtures.ts';
export * from './entry-points.ts';
import type { RecordingManifest } from './domain.ts';
import type { ProjectEntryPoint, ProjectEntryPoints } from './entry-points.ts';

/** Only the foundation bridge exists today. Add capabilities individually. */
export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

export interface LocalSourceSelection { handle: string; label: string; }
export interface LocalProject { id: string; name: string; targetType: 'web' | 'flutter'; baseUrl?: string; sourceLabel?: string; createdAt: string; }
export interface LocalTest { id: string; projectId: string; recordingId?: string; title: string; folder: string; tags: string[]; status: 'published' | 'generating' | 'generated' | 'archived'; versionCount: number; createdAt: string; }
export interface TestSuite { id: string; projectId: string; name: string; testIds: string[]; revision: number; updatedAt: string; updatedByUid?: string; sourceRecordingId?: string; }
export interface SuiteChange { projectId: string; suiteId: string; expectedRevision: number; name: string; testIds: string[]; sourceRecordingId?: string; }
export interface MoveTestToSuiteInput { projectId: string; testId: string; targetSuiteId: string | null; }
export interface SavedWebTestVersion {
  schemaVersion: 1; id: string; testId: string; organizationId: string; projectId: string; recordingId?: string;
  version: number; title: string; createdAt: string; state: 'generated' | 'execution-validated' | 'published';
  contentHash: string; steps: readonly PlaywrightDraftStep[]; files: readonly PlaywrightDraftFile[];
  runtime: PlaywrightDraftRuntime; provenance: PlaywrightDraftProvenance;
}
export interface SavedWebTestAttempt {
  schemaVersion: 1; id: string; versionId: string; testId: string; organizationId: string; projectId: string;
  testVersionHash: string; environmentHash: string; executionManifestHash: string;
  baseUrl?: string;
  state: 'preparing' | 'running' | 'passed' | 'failed' | 'skipped' | 'blocked' | 'canceled' | 'infrastructure-error';
  startedAt: string; finishedAt?: string; summary: string; passed: number; failed: number; skipped: number;
  detail: string; tests: readonly { id: string; title: string; outcome: 'passed' | 'failed' | 'skipped' | 'not-run'; durationMs: number; errors: readonly string[] }[];
  artifacts: readonly { relativePath: string; sha256: string; byteLength: number; mimeType: string }[];
  exitCode?: number | null; durationMs?: number; runner: 'desktop-local';
  applicationPatch?: ApplicationPatchLink;
}
export interface FailureEvidence {
  id: string; kind: 'source' | 'assertions' | 'framework' | 'log' | 'artifact';
  label: string; text: string; sha256?: string;
}
export interface FailureAnalysis {
  schemaVersion: 1; id: string; organizationId: string; projectId: string; testId: string;
  attemptId: string; versionId: string; testVersionHash: string; inputHash: string;
  createdAt: string; status: 'complete' | 'inconclusive' | 'unavailable' | 'canceled' | 'timeout';
  provider: CodingAgentProviderId; cliVersion?: string;
  expected: string; actual: string; category: 'application' | 'test' | 'environment' | 'uncertain';
  explanation: string; limitations: string; nextStep: string; evidenceIds: string[];
  evidence: FailureEvidence[];
}
export interface ManagedTestFixProposal {
  schemaVersion: 1; id: string; organizationId: string; projectId: string; testId: string;
  attemptId: string; analysisId: string; baseVersionId: string; baseContentHash: string;
  scope: 'managed-web-test' | 'managed-patrol-test'; createdAt: string; proposalHash: string;
  rationale: string; assertionImpact: string[]; diff: string;
  fileChanges: { relativePath: string; baseSha256: string; proposedSha256: string; proposedText: string }[];
  status: 'proposed' | 'approved' | 'rejected' | 'applied' | 'stale';
  decision?: { actorUid: string; decidedAt: string; proposalHash: string; baseContentHash: string; kind: 'approve' | 'reject' };
  appliedVersionId?: string;
}
export interface ApplicationFixProposal {
  schemaVersion: 1;
  id: string; organizationId: string; projectId: string; testId: string; attemptId: string; analysisId: string;
  target: 'web' | 'flutter'; testVersionId: string; testVersionHash: string;
  sourceRootHash: string; sourceRevision?: string; createdAt: string; rationale: string; evidenceIds: string[];
  fileChanges: { relativePath: string; baseSha256: string; proposedSha256: string; baseText: string; proposedText: string }[];
  changedPaths: string[]; reviewFlags: string[]; diff: string; proposalHash: string;
  status: 'proposed' | 'approved' | 'rejected' | 'applying' | 'applied' | 'recovery-required';
  decision?: { actorUid: string; kind: 'approve' | 'reject'; proposalHash: string; sourceRootHash: string; decidedAt: string };
  receiptId?: string;
}
export interface ApplicationFixReceipt {
  schemaVersion: 1; id: string; proposalId: string; proposalHash: string; organizationId: string; projectId: string; testId: string;
  sourceRootHash: string; sourceRevision?: string; actorUid: string; appliedAt: string;
  changedPaths: string[]; baseHashes: Record<string, string>; appliedHashes: Record<string, string>;
  originatingAttemptId: string; originatingAnalysisId: string; testVersionId: string; testVersionHash: string;
  clientReported: true;
}
/**
 * What SaySpec can commit to Git. An applied application fix commits exactly
 * its changed files; `tests` commits test files in the project's storage
 * folder (all of them, or those of `testIds`); `source` only reports the
 * selected source folder's repository.
 */
export type GitTarget =
  | { kind: 'application-fix'; organizationId: string; projectId: string; testId: string; proposalId: string; sourceHandle: string }
  | { kind: 'tests'; organizationId: string; projectId: string; testIds?: string[] }
  | { kind: 'source'; sourceHandle: string };
export interface GitRepositoryStatus {
  repository: boolean;
  /** Why there is no repository to commit to, when that needs saying (Git missing, tests in SaySpec Cloud). */
  note?: string;
  /** The repository's folder name. */
  name?: string;
  branch?: string; detached?: boolean;
  /** The checked-out branch was created by SaySpec, so new commits can be added to it. */
  sayspecBranch?: { name: string; baseBranch: string };
  remote?: { name: string; url: string; webUrl?: string; host: 'github' | 'gitlab' | 'bitbucket' | 'other' };
  /** How a pull request is opened: created with the GitHub CLI, or in the browser. */
  pullRequests?: 'github-cli' | 'browser';
}
export interface GitChangedFile { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' }
/** `baseBranch` equals `branch` when SaySpec committed straight to the checked-out branch, which needs no pull request. */
export interface GitCommitRecord {
  id: string; targetKey: string; repositoryName: string; branch: string; baseBranch: string; commit: string; subject: string;
  paths: string[]; createdAt: string; createdBranch: boolean;
  remote?: string; pushedAt?: string; pullRequestUrl?: string; pullRequestOpenedAt?: string;
}
export interface GitTargetView {
  status: GitRepositoryStatus;
  /** Uncommitted changes SaySpec may commit for this target, as paths from the repository root. */
  changes: GitChangedFile[];
  /** Why the changes cannot be committed by SaySpec. */
  blocked?: string;
  suggestedBranch: string; suggestedMessage: string;
  /** SaySpec's commits for this target, newest first. */
  commits: GitCommitRecord[];
}
export interface ApplicationPatchLink {
  receiptId: string; proposalId: string; proposalHash: string; originatingAttemptId: string;
  sourceRootHash: string; runtimeKind: 'local-web-server' | 'android-build' | 'ios-simulator-build'; runtimeHash?: string; buildArtifactHash?: string;
}
export interface SavedWebRun {
  schemaVersion: 1; id: string; organizationId: string; projectId: string; name: string; suiteId?: string;
  state: 'queued' | 'preparing' | 'running' | 'completed' | 'canceled' | 'interrupted';
  createdAt: string; finishedAt?: string; baseUrl: string; environmentHash: string; runner: 'desktop-local';
  /** Web only. Defaults to false for runs persisted before this option existed. */
  showBrowser?: boolean;
  items: { testId: string; versionId: string; title: string; contentHash: string; version: SavedWebTestVersion; attemptIds: string[] }[];
}
export interface PortableWebTestBundle {
  schemaVersion: 1; kind: 'sayspec-playwright-bundle'; exportedAt: string;
  original: { testId: string; versionId: string; contentHash: string; state: SavedWebTestVersion['state'] };
  title: string; steps: readonly PlaywrightDraftStep[]; files: readonly PlaywrightDraftFile[];
  runtime: PlaywrightDraftRuntime; secretPlaceholders: readonly string[];
  provenance: { provider: CodingAgentProviderId; cliVersion: string; inputRevisionHash: string; generatedAt: string };
}
export interface LocalWorkspaceSnapshot { projects: LocalProject[]; tests: LocalTest[]; suites: TestSuite[]; }
/**
 * Where a project's tests live, chosen when the project is created:
 * `local` on this Mac, `cloud` in SaySpec Cloud (Firebase, shared with the
 * team; Pro plan, Web projects), or `folder`, a folder the user chose such as a
 * git repository.
 */
export type TestStorageMode = 'local' | 'cloud' | 'folder';
export const TEST_STORAGE_MODES: readonly TestStorageMode[] = ['local', 'cloud', 'folder'];
/** Workspace plans. Beta is unpaid and includes every Pro feature; Pro is the paid plan, not offered in the initial release. */
export type PlanKind = 'free' | 'beta' | 'pro';
/** Mirrors the server: 'free' and 'pro' are explicit; 'beta', the old 'free-beta' and workspaces that predate plans are Beta. */
export function planKind(organization: { plan?: { kind?: unknown } } | undefined): PlanKind { const kind = organization?.plan?.kind; return kind === 'free' || kind === 'pro' ? kind : 'beta'; }
/** Whether the plan includes Pro features (Beta and Pro). */
export const isProPlan = (kind: PlanKind | null | undefined) => kind === 'beta' || kind === 'pro';
/** A project's test storage on this machine. The folder's absolute path stays in the main process; the renderer only sees a display form. */
export interface TestStorageSettings { projectId: string; mode: TestStorageMode; folder?: { label: string; displayPath: string; available: boolean }; }
export interface TestLibraryScope { organizationId: string; projectId: string; }
/** The project's test instructions file (SAYSPEC.md), kept next to its tests, as this machine sees it. */
export interface TestInstructionsView {
  fileName: string;
  /** `missing-folder`: Folder storage whose folder this Mac does not know yet, so there is nowhere to keep the file. */
  state: 'ready' | 'missing-folder';
  /** Where the file is on this Mac, with the home folder shortened to ~. */
  displayPath?: string;
  /** True once the file holds more than SaySpec's starter text. */
  written: boolean;
  updatedAt?: string;
}
/** A test as the library lists it, whichever storage it came from. */
export interface LibraryTest {
  id: string; projectId: string; title: string; status: LocalTest['status']; createdAt: string;
  recordingId?: string; authorLabel?: string;
  /** Path inside the storage folder, for folder storage only. */
  relativePath?: string;
  /** Why SaySpec cannot run this test, e.g. a folder file that is not a Patrol test. */
  issue?: string;
}
export interface TestLibrarySnapshot { storage: TestStorageMode; tests: LibraryTest[]; suites: TestSuite[]; }
/** A test's source, portable between storages. A saved Web version and a cloud generation draft both fit. */
export type PortableWebSource = Pick<SavedWebTestVersion, 'title' | 'steps' | 'files' | 'runtime' | 'provenance'> & { recordingId?: string };
export type PortablePatrolSource = Pick<PatrolSavedTest, 'title' | 'relativePath' | 'source'> & Partial<Pick<PatrolSavedTest, 'recordingCaptureId' | 'dependencies' | 'provider' | 'appVersion'>>;
/** A Flutter test's current version as SaySpec Cloud stores it, pulled to this Mac to run locally. */
export interface CloudPatrolTestVersion {
  testId: string; title: string; relativePath: string; source: string; contentHash: string;
  appVersion?: string; dependencies?: Readonly<Record<string, string>>; recordingId?: string; provider?: CodingAgentProviderId;
}
/** One test being copied to another storage, with its suite by name. */
export interface PortableLibraryTest { id: string; title: string; suite: string | null; authorLabel?: string; createdAt?: string; recordingId?: string; web?: PortableWebSource; patrol?: PortablePatrolSource; }
export interface PortableLibrary { tests: PortableLibraryTest[]; suites: string[]; }
export interface TestStorageCopyResult { copied: number; failed: { title: string; reason: string }[]; }
export interface CreateLocalProjectInput { name: string; targetType: 'web' | 'flutter'; baseUrl?: string; sourceLabel?: string; }
export interface ReadinessRequest { targetType: 'web' | 'flutter'; task: 'configure' | 'record' | 'run'; sourceHandle?: string; }
export interface ReadinessItem { id: string; label: string; state: 'ready' | 'missing' | 'unsupported'; detail: string; recovery?: string; }
export interface ReadinessReport { ready: boolean; checkedAt: string; items: readonly ReadinessItem[]; }

/**
 * Settings → Machine setup. Everything here is machine-local: paths, versions,
 * install jobs and logs never leave the desktop unless a user shares a selected
 * project requirement.
 */
export type MachineSetupWorkflow = 'general' | 'web' | 'flutter-android' | 'flutter-ios';
export type MachineSetupState =
  | 'checking' | 'missing' | 'incompatible' | 'installing' | 'waiting-for-user'
  | 'failed' | 'canceled' | 'installed' | 'verified' | 'unsupported';
export type MachineSetupAction = 'install' | 'repair' | 'manual' | 'none';
export interface MachineSetupItem {
  id: string;
  group: MachineSetupWorkflow;
  label: string;
  purpose: string;
  state: MachineSetupState;
  /** Version, path or package the check actually observed. Never a guess. */
  detected?: string;
  detectedPath?: string;
  /** What this machine and project require, for example `JDK 17 or 21`. */
  requirement?: string;
  detail: string;
  recovery?: string;
  action: MachineSetupAction;
  /** True when the check can only be satisfied outside SaySpec. */
  manual: boolean;
  /** How the check resolved the tool, so GUI PATH differences stay honest. */
  resolution?: 'login-shell' | 'common-path' | 'project' | 'environment' | 'not-found';
  /** Approximate download or wait the user should expect before starting. */
  expectation?: string;
  /** Last install job that touched this item, when one ran in this session. */
  jobId?: string;
  checkedAt: string;
}
export interface MachineSetupGroup {
  workflow: MachineSetupWorkflow;
  title: string;
  summary: string;
  /** Steps that also appear in another group; installed once, shown in each. */
  sharedItemIds: readonly string[];
  items: readonly MachineSetupItem[];
  /** True only when every item in the group is installed or verified. */
  ready: boolean;
  /** Unknown or failed checks keep the summary honest. */
  unknown: boolean;
}
export interface MachineSetupReport {
  checkedAt: string;
  platform: string;
  groups: readonly MachineSetupGroup[];
  project?: {
    projectId: string;
    name: string;
    targetType: 'web' | 'flutter';
    sourceLabel?: string;
    /** `pubspec.yaml`-derived requirements when the project was inspected. */
    pinnedFlutterSdk?: string;
    pinnedPatrol?: string;
    applicationId?: string;
  };
  /** Machine tools, project build, device and recording readiness are separate. */
  stages: {
    machineTools: 'ready' | 'incomplete' | 'unknown';
    projectBuild: 'ready' | 'incomplete' | 'unknown';
    device: 'ready' | 'incomplete' | 'unknown' | 'not-required';
    recordingIntegration: 'ready' | 'incomplete' | 'unknown' | 'not-required';
  };
}
export interface MachineSetupRequest { workflow?: MachineSetupWorkflow; sourceHandle?: string; projectId?: string; targetType?: 'web' | 'flutter'; refresh?: boolean; }
export interface MachineSetupInstallStep {
  itemId: string;
  label: string;
  /** What will run, in the order it will run. Shown before the plan starts. */
  command: string;
  destination?: string;
  /** True when the step needs an interactive terminal or an OS prompt. */
  interactive: boolean;
  expectation?: string;
  alreadySatisfied: boolean;
}
export interface MachineSetupPlan {
  workflow: MachineSetupWorkflow;
  itemIds: readonly string[];
  steps: readonly MachineSetupInstallStep[];
  sharedItemIds: readonly string[];
  manualSteps: readonly string[];
  substantialDownloads: readonly string[];
}
export interface MachineSetupJob {
  id: string;
  workflow: MachineSetupWorkflow;
  itemIds: readonly string[];
  state: 'queued' | 'running' | 'waiting-for-user' | 'canceled' | 'failed' | 'completed';
  startedAt: string;
  finishedAt?: string;
  currentItemId?: string;
  steps: readonly { itemId: string; state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting-for-user'; detail: string }[];
  outcome: string;
}
export interface MachineSetupLogEvent {
  jobId: string;
  itemId?: string;
  kind: 'plan' | 'output' | 'state' | 'done';
  data?: string;
  state?: MachineSetupState;
  job?: MachineSetupJob;
}

export type LocalRecordingStatus = 'preparing' | 'recording' | 'paused' | 'ready' | 'interrupted' | 'failed';
export type RecordingSharingChoice = 'local-only' | 'share-after-review';
export interface LocalRecordingSummary {
  id: string;
  projectId: string;
  title: string;
  status: LocalRecordingStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  eventCount: number;
  completenessWarnings: readonly string[];
  sharingChoice: RecordingSharingChoice;
  shareState: 'local' | 'uploading' | 'shared' | 'failed';
}
export type LocalModelInstallState = 'not-installed' | 'downloading' | 'installed' | 'failed';
export interface LocalWhisperRuntime {
  state: 'ready' | 'missing' | 'unsupported';
  name: 'whisper.cpp';
  requiredVersion: string;
  detectedVersion?: string;
  executablePath?: string;
  converterPath?: string;
  detail: string;
}
export interface LocalWhisperModel {
  id: string;
  displayName: string;
  family: 'whisper';
  variant: string;
  quantization: string;
  multilingual: boolean;
  supportedLanguages: 'multilingual';
  byteLength: number;
  sha256: string;
  license: string;
  sourceUrl: string;
  state: LocalModelInstallState;
  downloadedBytes: number;
  error?: string;
}
export interface LocalTranscriptionSetup { runtime: LocalWhisperRuntime; model: LocalWhisperModel; }
/**
 * Sends narration to the workspace's cloud backend for Gemini transcription
 * (Beta and Pro plans). The backend rechecks membership, plan and allowance.
 */
export interface CloudTranscriptionScope { idToken: string; organizationId: string; projectId: string; }
/** Longest narration (one recording segment, or one Flutter capture) cloud transcription accepts. */
export const CLOUD_TRANSCRIPTION_MAX_MS = 25 * 60_000;
export interface TranscriptRevision { id: string; text: string; editedAt: string; source: 'whisper' | 'gemini' | 'user'; }
export interface LocalTranscriptSegment {
  id: string;
  recordingSegmentId: string;
  startMs: number;
  endMs: number;
  timingUncertaintyMs: number;
  originalText: string;
  text: string;
  revisions: readonly TranscriptRevision[];
  evidenceEventIds: readonly string[];
}
export interface LocalTranscript {
  schemaVersion: 1;
  recordingId: string;
  status: 'running' | 'ready' | 'failed' | 'canceled';
  language?: string;
  provider:
    | { kind: 'local'; runtime: 'whisper.cpp'; runtimeVersion: string; modelId: string; modelSha256: string; translated: false }
    /** Pro: narration uploaded to the workspace's SaySpec Cloud and transcribed by Gemini there. */
    | { kind: 'cloud'; service: 'gemini'; model: string; translated: false };
  segments: readonly LocalTranscriptSegment[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  warnings: readonly string[];
}
export type RecordingIntentKind = 'exact-choice' | 'allowed-variation' | 'relational-assertion' | 'correction' | 'expectation';
export interface RecordingIntentItem {
  id: string;
  kind: RecordingIntentKind;
  statement: string;
  transcriptSegmentIds: readonly string[];
  evidenceEventIds: readonly string[];
}
export interface RecordingIntentReview {
  schemaVersion: 1;
  recordingId: string;
  readiness: 'draft' | 'ready';
  items: readonly RecordingIntentItem[];
  unresolvedQuestions: readonly string[];
  updatedAt: string;
}
export type CodingAgentProviderId = 'claude-code' | 'codex';
export type CodingAgentReadinessState = 'ready' | 'missing' | 'unauthenticated' | 'unsupported';
export interface CodingAgentProviderReadiness {
  id: CodingAgentProviderId;
  displayName: string;
  state: CodingAgentReadinessState;
  executable?: string;
  version?: string;
  qualification?: 'tested' | 'untested-version';
  testedVersion?: string;
  detail: string;
  isolation: {
    writeAccess: 'none';
    enforcement: 'claude-restricted-read-tools' | 'codex-os-read-only-sandbox';
    verified: boolean;
  };
}
export interface CodingAgentReadinessReport {
  checkedAt: string;
  providers: readonly CodingAgentProviderReadiness[];
  disclosure: string;
}
export interface CodingAgentPreference {
  schemaVersion: 1;
  provider?: CodingAgentProviderId;
  updatedAt?: string;
}
export interface CodingAgentSelectionResult {
  preference: CodingAgentPreference;
  readiness: CodingAgentProviderReadiness;
  saved: boolean;
  installPageOpened: boolean;
  installUrl?: string;
}
export interface PlaywrightDraftStep {
  id: string;
  instruction: string;
  assertion: string;
  intentItemIds: readonly string[];
  transcriptSegmentIds: readonly string[];
  evidenceEventIds: readonly string[];
}
export interface PlaywrightDraftFile {
  id: string;
  relativePath: string;
  text: string;
  sha256: string;
  byteLength: number;
  mimeType: 'text/typescript' | 'application/json' | 'text/markdown';
}
export interface PlaywrightDraftRuntime {
  framework: 'playwright';
  frameworkVersion: '1.63.0';
  entrypoint: string;
  dependencies: Readonly<Record<string, string>>;
  requirements: readonly string[];
}
export interface PlaywrightDraftProvenance {
  provider: CodingAgentProviderId;
  cliVersion: string;
  generatedAt: string;
  inputRevisionHash: string;
  recordingId: string;
  intentUpdatedAt?: string;
  selectedEvidenceEventIds: readonly string[];
  executionValidated: boolean;
  published: false;
}
export interface PlaywrightGenerationDraft {
  schemaVersion: 1;
  id: string;
  organizationId: string;
  projectId: string;
  recordingId: string;
  state: 'generating' | 'draft' | 'stale' | 'failed' | 'canceled';
  title: string;
  steps: readonly PlaywrightDraftStep[];
  files: readonly PlaywrightDraftFile[];
  runtime: PlaywrightDraftRuntime;
  unresolvedQuestions: readonly string[];
  provenance: PlaywrightDraftProvenance;
  warnings: readonly string[];
  validation?: { status: 'passed' | 'failed' | 'skipped' | 'blocked' | 'canceled' | 'infrastructure-error'; attempts: number; passed: number; failed: number; skipped?: number; summary: string; detail?: string; validatedAt: string };
  validationHistory?: readonly { candidateSha256: string; status: 'passed' | 'failed' | 'skipped' | 'blocked' | 'canceled' | 'infrastructure-error'; passed: number; failed: number; skipped: number; summary: string; detail: string; at: string }[];
  error?: string;
}
export interface PlaywrightGenerationLifecycleEvent {
  recordingId: string;
  state: PlaywrightGenerationDraft['state'];
  progress: number;
  message: string;
}
export interface ClaudeTerminalEvent {
  recordingId: string;
  kind: 'started' | 'data' | 'exit';
  data?: string;
  exitCode?: number;
}
export interface PatrolGenerationTerminalEvent {
  /** The recording session the terminal generates tests for. */
  sessionId: string;
  kind: 'started' | 'data' | 'exit' | 'validation' | 'saved';
  data?: string;
  exitCode?: number;
  /** The recording a validation or saved test belongs to. */
  captureId?: string;
  attempt?: PatrolAttempt;
  testId?: string;
}
export interface MachineSetupAgentTerminalEvent {
  projectId: string;
  kind: 'started' | 'data' | 'exit';
  data?: string;
  exitCode?: number;
}
export interface ManagedFixTerminalEvent { attemptId: string; kind: 'started' | 'data' | 'exit' | 'proposal' | 'error'; data?: string; proposal?: ManagedTestFixProposal; exitCode?: number; }
export interface ApplicationFixTerminalEvent { attemptId: string; kind: 'started' | 'data' | 'exit' | 'proposal' | 'error'; data?: string; proposal?: ApplicationFixProposal; exitCode?: number; }
export interface LocalRecordingReview extends LocalRecordingSummary {
  startUrl: string;
  manifest: RecordingManifest;
  transcript?: LocalTranscript;
  intent?: RecordingIntentReview;
  generationDraft?: PlaywrightGenerationDraft;
}
export interface WebRecordingStartInput {
  projectId: string;
  projectName: string;
  startUrl: string;
  organizationId?: string;
  createdByUid?: string;
  sharingChoice: RecordingSharingChoice;
}
export interface RecordingControlSnapshot {
  recording: LocalRecordingSummary;
  activeSegmentId?: string;
}
export interface RecordingStopResult {
  review: LocalRecordingReview;
  next?: RecordingControlSnapshot;
}
export interface MicrophonePermissionReport { state: 'granted' | 'denied' | 'unavailable'; detail: string; }
export interface RecordingAsset { artifactId: string; mimeType: string; bytes: Uint8Array; }
export interface RecordingLifecycleEvent {
  recordingId: string;
  state: LocalRecordingStatus | 'browser-closed' | 'start-requested' | 'stop-requested';
  message?: string;
}

/**
 * Flutter recording evidence. Produced by the instrumented app through the
 * `sayspec_flutter_recorder` SDK and stored by the desktop host.
 */
export type FlutterRecordingStatus = 'preparing' | 'recording' | 'paused' | 'ready' | 'interrupted' | 'failed';
export type FlutterRecorderSdkState = 'ready' | 'missing' | 'incompatible';
export interface FlutterRecorderSdkCompatibility {
  state: FlutterRecorderSdkState;
  requiredSchema: number;
  detectedSchema?: number;
  detail: string;
}
export interface FlutterDeviceSummary {
  id: string;
  name: string;
  kind: 'emulator' | 'device';
  platform: 'android' | 'ios';
  /** `stopped` is an installed AVD or simulator that is not running; `startFlutterDevice` boots it. */
  state: 'ready' | 'offline' | 'unauthorized' | 'booting' | 'stopped';
  apiLevel?: string;
  /** Simulator OS runtime, for example `iOS 26.5`. */
  runtime?: string;
  detail: string;
}
export interface FlutterWidgetCandidate { kind: 'key' | 'semantics' | 'text' | 'type'; value: string; confidence: 'high' | 'medium' | 'low'; }
export interface FlutterWidgetIdentity {
  widgetType: string;
  key?: string;
  keyKind?: string;
  semanticLabel?: string;
  text?: string;
  ancestors: readonly string[];
  candidates: readonly FlutterWidgetCandidate[];
  bounds?: { x: number; y: number; width: number; height: number };
}
export interface FlutterEvidenceEvent {
  id: string;
  seq: number;
  kind: 'action' | 'navigation' | 'lifecycle' | 'marker';
  /** Device monotonic milliseconds; ordering never depends on wall clock. */
  monotonicMs: number;
  /** Host-aligned milliseconds, derived from the calibrated offset. */
  hostAlignedMs: number;
  route?: string;
  previousRoute?: string;
  widget?: FlutterWidgetIdentity;
  payload: Readonly<Record<string, unknown>>;
  screenshotArtifactId?: string;
}
export interface FlutterCaptureSummary {
  schemaVersion: 1;
  id: string;
  organizationId: string;
  projectId: string;
  title: string;
  /**
   * The recording session (one app launch) this recording belongs to. Tests
   * are generated per session. Recordings saved before sessions existed have
   * none and form a session of their own; see `flutterSessionIdOf`.
   */
  sessionId?: string;
  sessionTitle?: string;
  status: FlutterRecordingStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  eventCount: number;
  deviceId: string;
  deviceName: string;
  platform: 'android' | 'ios';
  appId: string;
  /** The entry point the app was launched with, when one was chosen. */
  entryPoint?: { name: string; command: string };
  /** The app's pubspec.yaml version when it was recorded, for example 2.4.0+57. */
  appVersion?: string;
  recorderSdkVersion: string;
  recorderSchemaVersion: number;
  completenessWarnings: readonly string[];
  shareState?: 'local' | 'uploading' | 'shared' | 'failed';
  error?: string;
}
/** The session a Flutter recording is grouped under. */
export function flutterSessionIdOf(summary: Pick<FlutterCaptureSummary, 'id' | 'sessionId'>) {
  return summary.sessionId ?? summary.id;
}
export interface FlutterCapture {
  summary: FlutterCaptureSummary;
  clock: { offsetMs: number; roundTripMs: number; samples: number; uncertaintyMs: number };
  events: readonly FlutterEvidenceEvent[];
  artifacts: readonly { id: string; relativePath: string; sha256: string; byteLength: number; mimeType: string }[];
  narration?: {
    artifactId: string;
    captureId: string;
    mimeType: string;
    startedAtHostMonotonicMs: number;
    finishedAtHostMonotonicMs: number;
    durationMs: number;
    sha256: string;
    byteLength: number;
  };
  transcript?: LocalTranscript;
  /** Finder suggestions derived from recorded identity, never final assertions. */
  assertions: readonly { eventId: string; suggestion: string; confidence: 'high' | 'medium' | 'low'; rationale: string }[];
}
export interface FlutterCaptureStartInput {
  organizationId: string;
  projectId: string;
  projectName: string;
  deviceId: string;
  /** Overrides the entry point's application ID; otherwise it is resolved from the entry point or Gradle. */
  appId?: string;
  flavor?: string;
  /** The Settings entry point to launch; the main process re-validates its command. */
  entryPoint?: ProjectEntryPoint;
  /** Validated directory handle; the main process resolves the real path. */
  sourceHandle: string;
  title?: string;
}
export interface FlutterCaptureLifecycleEvent {
  captureId: string;
  /**
   * `waiting-for-user`: the app shows the SaySpec overlay, idle until Record.
   * `stop-requested`: Stop was pressed on the device; the view finishes narration and calls stop.
   * `restarting`: the saved test's app process is being restarted for the next test.
   */
  state: FlutterRecordingStatus | 'starting' | 'device-booting' | 'app-launching' | 'waiting-for-user' | 'stop-requested' | 'restarting';
  message: string;
  progress?: number;
}

/** Readable output of `flutter run` while the app for a recording session builds and launches. */
export interface FlutterCaptureLaunchLogEvent {
  projectId: string;
  lines: string[];
}

/** Launch configuration preview the user must apply before recording starts. */
export interface FlutterIntegrationPreview {
  sourcePath: string;
  files: readonly { relativePath: string; baseSha256?: string; proposedText: string; description: string }[];
  requiresApplication: boolean;
  notes: readonly string[];
}

/** Runtime manifest recorded with a Patrol attempt so a result is reproducible. */
export interface PatrolRuntimeManifest {
  flutterVersion?: string;
  dartVersion?: string;
  patrolCliVersion?: string;
  patrolPackageVersion?: string;
  deviceId: string;
  deviceName: string;
  platform: 'android' | 'ios';
  apiLevel?: string;
  /** Simulator OS runtime, for example `iOS 26.5`. */
  osVersion?: string;
  appId?: string;
  entrypoint: string;
  testFileHashes: Readonly<Record<string, string>>;
  environmentHash: string;
}
export interface PatrolTestOutcome {
  id: string;
  title: string;
  outcome: 'passed' | 'failed' | 'skipped' | 'not-run';
  durationMs: number;
  errors: readonly string[];
}
export interface PatrolSavedTest {
  schemaVersion: 1;
  /** Stable logical test id. */
  id: string;
  /** Immutable version id and monotonically increasing project-local version. */
  versionId: string;
  version: number;
  projectId: string;
  organizationId: string;
  title: string;
  /** Path relative to the Flutter project root, for example integration_test/cart_test.dart. */
  relativePath: string;
  source: string;
  contentHash: string;
  createdAt: string;
  recordingCaptureId?: string;
  /** Exact dependency manifest submitted with the generated source. */
  dependencies?: Readonly<Record<string, string>>;
  /** The app's pubspec.yaml version when the test was recorded, for example 2.4.0+57. */
  appVersion?: string;
  /** Passing attempt whose testContentHash equals contentHash. */
  validationAttemptId?: string;
  provider?: CodingAgentProviderId;
  validatedRuntime?: PatrolRuntimeManifest;
  state: 'generated' | 'execution-validated' | 'published';
}
export interface PatrolGenerationSubmission {
  /** The session recording this test is generated from. */
  captureId: string;
  title: string;
  framework: 'patrol';
  relativePath: string;
  source: string;
  dependencies: Readonly<Record<string, string>>;
  transcriptSegmentIds: readonly string[];
  evidenceEventIds: readonly string[];
}
export interface PatrolAttempt {
  schemaVersion: 1;
  id: string;
  testId: string;
  versionId: string;
  projectId: string;
  organizationId: string;
  testContentHash: string;
  runtime: PatrolRuntimeManifest;
  state: 'queued' | 'preparing' | 'building' | 'running' | 'passed' | 'failed' | 'blocked' | 'infrastructure-error' | 'canceled';
  deviceId: string;
  leaseId: string;
  startedAt: string;
  finishedAt?: string;
  summary: string;
  detail: string;
  passed: number;
  failed: number;
  skipped: number;
  tests: readonly PatrolTestOutcome[];
  artifacts: readonly { relativePath: string; sha256: string; byteLength: number; mimeType: string }[];
  exitCode?: number | null;
  runner: 'desktop-local-patrol';
  applicationPatch?: ApplicationPatchLink;
  /** The test run this attempt belongs to, when it ran as part of one. */
  runId?: string;
}
/**
 * A named batch of saved Patrol tests, built once and run together on one device.
 *
 * Membership and versions are frozen when the run is created; later edits to
 * the tests never rewrite it. Per-test results are the attempts carrying this
 * run's id.
 */
export interface PatrolRun {
  schemaVersion: 1;
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  /** Device of the latest start; a run can be started again on another device. */
  deviceId?: string;
  deviceName?: string;
  /** `queued` until first started; `canceled` when stopped; `interrupted` when the app quit mid-run. */
  state: 'queued' | 'running' | 'finished' | 'canceled' | 'interrupted';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Test currently executing, while the run is running. */
  activeTestId?: string;
  items: readonly { testId: string; versionId: string; version: number; title: string; relativePath: string; contentHash: string }[];
  /** Run-level evidence of the latest start: the combined Patrol log and device reports. */
  artifacts?: readonly { relativePath: string; sha256: string; byteLength: number; mimeType: string }[];
  /** Coding-agent analysis started automatically when the latest start had a failure. */
  analysis?: PatrolRunAnalysis;
}
/**
 * Interactive coding-agent analysis of a finished run.
 *
 * `ready` means the agent wrote its HTML report; the session may still be open
 * for follow-up questions. `failed` means it ended without a report.
 */
export interface PatrolRunAnalysis {
  state: 'running' | 'ready' | 'failed';
  provider: CodingAgentProviderId;
  startedAt: string;
  finishedAt?: string;
  detail?: string;
  /** The report's issues, read from the agent's analysis.json once the report is written. */
  issues?: PatrolRunIssue[];
}
export type PatrolRunIssueVerdict = 'app-bug' | 'bad-test' | 'environment' | 'flaky' | 'unclear';
/** Tests of a run that fail for one reason, with the agent's verdict on it. */
export interface PatrolRunIssue {
  id: string;
  verdict: PatrolRunIssueVerdict;
  summary: string;
  nextStep: string;
  /** Run items the issue names; empty when the agent named none of them. */
  testIds: string[];
  /** What the test expected and what happened, when the agent said. */
  expected?: string;
  actual?: string;
  /** Log lines the agent relied on. */
  evidence: string[];
}
export interface PatrolRunAnalysisEvent { runId: string; kind: 'data' | 'exit' | 'report'; seq: number; data?: string; exitCode?: number; }
/** New readable lines of a run's console; `startedAt` names the start they belong to. */
export interface PatrolRunConsoleEvent { runId: string; startedAt: string; seq: number; text: string; }
export interface PatrolDeviceLease {
  id: string;
  deviceId: string;
  attemptId: string;
  acquiredAt: string;
  releasedAt?: string;
}
export interface PatrolRunInput {
  organizationId: string;
  projectId: string;
  testId: string;
  /** Omit only for legacy callers; the main UI always freezes the selected latest version. */
  versionId?: string;
  deviceId: string;
  /** Validated directory handle; the main process resolves the real path. */
  sourceHandle: string;
}
export interface LocalTranscriptionLifecycleEvent {
  kind: 'model' | 'transcription';
  state: LocalModelInstallState | LocalTranscript['status'];
  progress: number;
  message: string;
  recordingId?: string;
}

export interface DesktopBridge {
  getAppInfo(): Promise<AppInfo>;
  /** Opens the account portal in the system browser. Only the origin fixed at build time (VITE_SAYSPEC_ACCOUNT_PORTAL_ORIGIN); the renderer cannot supply a URL. */
  openAccountPortal(input: { page: 'portal' | 'sign-up' | 'billing' }): Promise<void>;
  getLocalWorkspace(): Promise<LocalWorkspaceSnapshot>;
  createLocalProject(input: CreateLocalProjectInput): Promise<LocalProject>;
  /** Removes the local project with its tests and suites. */
  deleteLocalProject(input: { projectId: string }): Promise<void>;
  renameLocalTest(input: { projectId: string; testId: string; title: string }): Promise<LocalTest>;
  deleteLocalTest(input: { projectId: string; testId: string }): Promise<void>;
  saveLocalSuite(input: SuiteChange): Promise<TestSuite>;
  moveLocalTestToSuite(input: MoveTestToSuiteInput): Promise<void>;
  getTestStorage(input: TestLibraryScope): Promise<TestStorageSettings>;
  /** Opens a folder picker for a test storage folder. The path stays in the main process. */
  chooseTestStorageFolder(): Promise<LocalSourceSelection | null>;
  /**
   * Tells this machine where the project's tests live: when a project is created, when a
   * project's shared choice is read from SaySpec Cloud, and after switching storage.
   * A folder handle is needed the first time a project uses folder storage on this machine.
   */
  configureTestStorage(input: TestLibraryScope & { targetType: 'web' | 'flutter'; mode: TestStorageMode; folderHandle?: string }): Promise<TestStorageSettings>;
  revealTestStorageFolder(input: { projectId: string }): Promise<void>;
  getTestInstructions(input: TestLibraryScope): Promise<TestInstructionsView>;
  /** Shows SAYSPEC.md in Finder, creating it with starter text when it does not exist yet. */
  revealTestInstructions(input: TestLibraryScope & { targetType: 'web' | 'flutter' }): Promise<void>;
  /**
   * Reconciles this Mac's copy of a SaySpec Cloud project's instructions with the shared one
   * (`cloudText`, null when there is none yet). Returns text the renderer must upload.
   */
  syncCloudTestInstructions(input: TestLibraryScope & { cloudText: string | null }): Promise<{ upload?: string }>;
  /** Reads every test and suite from the project's current storage on this machine (not SaySpec Cloud). */
  exportTestLibrary(input: TestLibraryScope): Promise<PortableLibrary>;
  /** Flutter tests saved on this Mac that SaySpec Cloud does not have yet: each one's latest version. */
  listPendingCloudPatrolTests(input: TestLibraryScope): Promise<PatrolSavedTest[]>;
  /** Records that SaySpec Cloud now holds this version, so it is no longer pending. */
  markCloudPatrolTestUploaded(input: TestLibraryScope & { testId: string; versionId: string }): Promise<void>;
  /** Saves SaySpec Cloud's current Flutter test versions on this Mac, where runs read them. Tests with pending uploads are skipped. */
  pullCloudPatrolTests(input: TestLibraryScope & { versions: CloudPatrolTestVersion[] }): Promise<void>;
  /** Copies tests into on-device storage (Local or a folder) without switching to it. */
  importTestLibrary(input: TestLibraryScope & { targetType: 'web' | 'flutter'; mode: Exclude<TestStorageMode, 'cloud'>; folderHandle?: string; library: PortableLibrary }): Promise<TestStorageCopyResult>;
  /** The signed-in person written as the author of tests saved to a folder; null falls back to the folder's git identity. */
  setTestAuthor(input: { name?: string; email?: string } | null): Promise<void>;
  /** Lists tests and suites from this machine's storage for the project: a storage folder, or the guest workspace. */
  getTestLibrary(input: TestLibraryScope): Promise<TestLibrarySnapshot>;
  renameLibraryTest(input: TestLibraryScope & { testId: string; title: string }): Promise<void>;
  deleteLibraryTest(input: TestLibraryScope & { testId: string }): Promise<void>;
  saveLibrarySuite(input: TestLibraryScope & SuiteChange): Promise<TestSuite>;
  /** Deletes a suite that holds no tests. */
  deleteLibrarySuite(input: TestLibraryScope & { suiteId: string }): Promise<void>;
  moveLibraryTest(input: TestLibraryScope & MoveTestToSuiteInput): Promise<void>;
  chooseSourceDirectory(): Promise<LocalSourceSelection | null>;
  /** Remembers the folder behind a selection for a project so it is restored after restart. The path stays in the main process. */
  rememberSourceDirectory(input: { projectId: string; handle: string }): Promise<void>;
  /** Restores the remembered folder for a project as a fresh handle, or null when none is remembered or it no longer exists. */
  getRememberedSourceDirectory(input: { projectId: string }): Promise<LocalSourceSelection | null>;
  checkReadiness(input: ReadinessRequest): Promise<ReadinessReport>;
  getMachineSetup(input?: MachineSetupRequest): Promise<MachineSetupReport>;
  checkMachineSetup(input: MachineSetupRequest): Promise<MachineSetupReport>;
  planMachineSetupInstall(input: { workflow: MachineSetupWorkflow; itemIds?: string[] }): Promise<MachineSetupPlan>;
  startMachineSetupInstall(input: { workflow: MachineSetupWorkflow; itemIds?: string[] }): Promise<MachineSetupJob>;
  cancelMachineSetupInstall(input: { jobId: string }): Promise<MachineSetupJob>;
  getMachineSetupJob(input: { jobId: string }): Promise<MachineSetupJob>;
  onMachineSetupEvent(listener: (event: MachineSetupLogEvent) => void): () => void;
  /** `test-instructions` needs `organizationId`; its `sourceHandle` is optional. */
  startMachineSetupAgent(input: { projectId: string; organizationId?: string; targetType: 'web' | 'flutter'; sourceHandle?: string; scope?: 'setup' | 'entry-points' | 'test-instructions'; cols: number; rows: number }): Promise<{ state: 'running' }>;
  writeMachineSetupAgent(input: { projectId: string; data: string }): Promise<void>;
  resizeMachineSetupAgent(input: { projectId: string; cols: number; rows: number }): Promise<void>;
  closeMachineSetupAgent(input: { projectId: string }): Promise<void>;
  onMachineSetupAgentEvent(listener: (event: MachineSetupAgentTerminalEvent) => void): () => void;
  /** Entry points are stored on this machine per project; the setup agent can write them too. */
  getProjectEntryPoints(input: { projectId: string; targetType: 'web' | 'flutter' }): Promise<ProjectEntryPoints>;
  saveProjectEntryPoints(input: { projectId: string; targetType: 'web' | 'flutter'; entryPoints: ProjectEntryPoint[] }): Promise<ProjectEntryPoints>;
  onProjectEntryPointsChanged(listener: (value: ProjectEntryPoints) => void): () => void;
  requestMicrophoneAccess(): Promise<MicrophonePermissionReport>;
  startWebRecording(input: WebRecordingStartInput): Promise<RecordingControlSnapshot>;
  beginRecordingSegment(input: { recordingId: string }): Promise<RecordingControlSnapshot>;
  appendRecordingAudio(input: { recordingId: string; segmentId: string; mimeType: string; bytes: Uint8Array }): Promise<void>;
  pauseRecording(input: { recordingId: string }): Promise<RecordingControlSnapshot>;
  resumeRecording(input: { recordingId: string }): Promise<RecordingControlSnapshot>;
  stopRecording(input: { recordingId: string }): Promise<RecordingStopResult>;
  interruptRecording(input: { recordingId: string; reason: string }): Promise<LocalRecordingReview>;
  cancelRecording(input: { recordingId: string }): Promise<void>;
  listLocalRecordings(input: { projectId: string }): Promise<LocalRecordingSummary[]>;
  getLocalRecording(input: { projectId: string; recordingId: string }): Promise<LocalRecordingReview>;
  readRecordingAsset(input: { recordingId: string; artifactId: string }): Promise<RecordingAsset>;
  setRecordingShareState(input: { recordingId: string; state: LocalRecordingSummary['shareState'] }): Promise<LocalRecordingSummary>;
  onRecordingLifecycle(listener: (event: RecordingLifecycleEvent) => void): () => void;
  getLocalTranscriptionSetup(): Promise<LocalTranscriptionSetup>;
  installLocalTranscriptionModel(input: { modelId: string }): Promise<LocalTranscriptionSetup>;
  cancelLocalTranscriptionModelInstall(): Promise<LocalTranscriptionSetup>;
  removeLocalTranscriptionModel(input: { modelId: string }): Promise<LocalTranscriptionSetup>;
  /** Transcribes on this device, or with Gemini in the workspace's cloud when `cloud` is given. */
  transcribeRecording(input: { recordingId: string; cloud?: CloudTranscriptionScope }): Promise<LocalTranscript>;
  cancelRecordingTranscription(input: { recordingId: string }): Promise<LocalTranscript>;
  saveTranscriptEdits(input: { recordingId: string; edits: readonly { segmentId: string; text: string }[] }): Promise<LocalRecordingReview>;
  saveRecordingIntent(input: { recordingId: string; intent: Omit<RecordingIntentReview, 'schemaVersion' | 'recordingId' | 'updatedAt'> }): Promise<LocalRecordingReview>;
  onLocalTranscriptionLifecycle(listener: (event: LocalTranscriptionLifecycleEvent) => void): () => void;
  checkCodingAgentReadiness(): Promise<CodingAgentReadinessReport>;
  getCodingAgentPreference(): Promise<CodingAgentPreference>;
  selectCodingAgentProvider(input: { provider: CodingAgentProviderId }): Promise<CodingAgentSelectionResult>;
  generatePlaywrightDraft(input: { recordingId: string; provider: CodingAgentProviderId }): Promise<PlaywrightGenerationDraft>;
  cancelPlaywrightGeneration(input: { recordingId: string }): Promise<PlaywrightGenerationDraft>;
  runSavedWebTest(input: { organizationId: string; projectId: string; testId: string; versionId: string; baseUrl: string }): Promise<SavedWebTestAttempt>;
  createSavedWebRun(input: { organizationId: string; projectId: string; name: string; baseUrl: string; testIds: string[]; suiteId?: string }): Promise<SavedWebRun>;
  startSavedWebRun(input: { organizationId: string; projectId: string; runId: string; showBrowser?: boolean }): Promise<SavedWebRun>;
  listSavedWebRuns(input: { organizationId: string; projectId: string }): Promise<SavedWebRun[]>;
  retrySavedWebRunItem(input: { organizationId: string; projectId: string; runId: string; testId: string }): Promise<SavedWebTestAttempt>;
  cancelSavedWebRun(input: { organizationId: string; projectId: string; runId: string }): Promise<void>;
  listSavedWebTestVersions(input: { organizationId: string; projectId: string; recordingId: string }): Promise<SavedWebTestVersion[]>;
  listProjectWebTestVersions(input: { organizationId: string; projectId: string }): Promise<SavedWebTestVersion[]>;
  cancelSavedWebTest(input: { attemptId: string }): Promise<void>;
  analyzeSavedWebFailure(input: { organizationId: string; projectId: string; testId: string; attemptId: string; provider: CodingAgentProviderId; platform?: 'patrol' }): Promise<FailureAnalysis>;
  listFailureAnalyses(input: { organizationId: string; projectId: string; testId: string; attemptId: string; platform?: 'patrol' }): Promise<FailureAnalysis[]>;
  cancelFailureAnalysis(input: { attemptId: string }): Promise<void>;
  listManagedFixProposals(input: { organizationId: string; projectId: string; testId: string; idToken?: string }): Promise<ManagedTestFixProposal[]>;
  startManagedFixSession(input: { organizationId: string; projectId: string; testId: string; attemptId: string; analysisId: string; cols: number; rows: number; idToken?: string }): Promise<{ state: 'running'; sessionToken: string }>;
  writeManagedFixSession(input: { attemptId: string; sessionToken: string; data: string }): Promise<void>;
  resizeManagedFixSession(input: { attemptId: string; sessionToken: string; cols: number; rows: number }): Promise<void>;
  closeManagedFixSession(input: { attemptId: string; sessionToken: string }): Promise<void>;
  onManagedFixTerminalEvent(listener: (event: ManagedFixTerminalEvent) => void): () => void;
  decideManagedFix(input: { organizationId: string; projectId: string; testId: string; proposalId: string; kind: 'approve' | 'reject'; idToken?: string }): Promise<ManagedTestFixProposal>;
  applyManagedFix(input: { organizationId: string; projectId: string; testId: string; proposalId: string; idToken?: string }): Promise<SavedWebTestVersion>;
  listApplicationFixProposals(input: { organizationId: string; projectId: string; target: 'web' | 'flutter'; testId?: string; idToken?: string }): Promise<ApplicationFixProposal[]>;
  startApplicationFixSession(input: { organizationId: string; projectId: string; testId: string; attemptId: string; analysisId: string; target: 'web' | 'flutter'; sourceHandle: string; cols: number; rows: number; idToken?: string }): Promise<{ state: 'running'; sessionToken: string }>;
  writeApplicationFixSession(input: { attemptId: string; sessionToken: string; data: string }): Promise<void>;
  resizeApplicationFixSession(input: { attemptId: string; sessionToken: string; cols: number; rows: number }): Promise<void>;
  closeApplicationFixSession(input: { attemptId: string; sessionToken: string }): Promise<void>;
  onApplicationFixTerminalEvent(listener: (event: ApplicationFixTerminalEvent) => void): () => void;
  decideApplicationFix(input: { organizationId: string; projectId: string; testId: string; proposalId: string; target: 'web' | 'flutter'; sourceHandle: string; kind: 'approve' | 'reject'; idToken?: string }): Promise<ApplicationFixProposal>;
  applyApplicationFix(input: { organizationId: string; projectId: string; testId: string; proposalId: string; target: 'web' | 'flutter'; sourceHandle: string; idToken?: string }): Promise<ApplicationFixReceipt>;
  readApplicationFixReceipt(input: { organizationId: string; projectId: string; testId: string; proposalId: string; target: 'web' | 'flutter'; idToken?: string }): Promise<ApplicationFixReceipt | null>;
  rerunApplicationFix(input: { organizationId: string; projectId: string; testId: string; proposalId: string; target: 'web' | 'flutter'; sourceHandle: string; deviceId?: string; idToken?: string }): Promise<SavedWebTestAttempt | PatrolAttempt>;
  listSavedWebTestAttempts(input: { organizationId: string; projectId: string; testId: string }): Promise<SavedWebTestAttempt[]>;
  readSavedWebTestArtifact(input: { organizationId: string; projectId: string; testId: string; attemptId: string; relativePath: string }): Promise<{ bytes: Uint8Array; mimeType: string }>;
  exportSavedWebTest(input: { organizationId: string; projectId: string; testId: string; versionId: string }): Promise<PortableWebTestBundle>;
  previewWebTestImport(input: { bundle: PortableWebTestBundle }): Promise<{ title: string; fileCount: number; contentHash: string; requirements: readonly string[] }>;
  importWebTest(input: { organizationId: string; projectId: string; testId?: string; bundle: PortableWebTestBundle }): Promise<SavedWebTestVersion>;
  onPlaywrightGenerationLifecycle(listener: (event: PlaywrightGenerationLifecycleEvent) => void): () => void;
  startClaudeTerminal(input: { recordingId: string; cols: number; rows: number; mode: 'inspect' | 'generate' }): Promise<{ state: 'running' }>;
  writeClaudeTerminal(input: { recordingId: string; data: string }): Promise<void>;
  resizeClaudeTerminal(input: { recordingId: string; cols: number; rows: number }): Promise<void>;
  closeClaudeTerminal(input: { recordingId: string }): Promise<void>;
  onClaudeTerminalEvent(listener: (event: ClaudeTerminalEvent) => void): () => void;
  /** One terminal per recording session; the agent writes one test per recording. */
  startPatrolGeneration(input: { projectId: string; sessionId: string; sourceHandle: string; deviceId: string; appId: string; flavor?: string; cols: number; rows: number }): Promise<{ state: 'running' }>;
  writePatrolGeneration(input: { sessionId: string; data: string }): Promise<void>;
  resizePatrolGeneration(input: { sessionId: string; cols: number; rows: number }): Promise<void>;
  closePatrolGeneration(input: { sessionId: string }): Promise<void>;
  onPatrolGenerationEvent(listener: (event: PatrolGenerationTerminalEvent) => void): () => void;
  listFlutterDevices(): Promise<FlutterDeviceSummary[]>;
  /** Boots a `stopped` emulator or simulator and resolves with it once it is ready. */
  startFlutterDevice(input: { deviceId: string }): Promise<FlutterDeviceSummary>;
  checkFlutterRecorderSdk(input: { sourceHandle?: string }): Promise<FlutterRecorderSdkCompatibility>;
  previewFlutterIntegration(input: { sourceHandle: string; appId: string }): Promise<FlutterIntegrationPreview>;
  applyFlutterIntegration(input: { sourceHandle: string; appId: string; relativePaths: string[] }): Promise<FlutterIntegrationPreview>;
  startFlutterCapture(input: FlutterCaptureStartInput): Promise<FlutterCaptureSummary>;
  pauseFlutterCapture(input: { captureId: string }): Promise<FlutterCaptureSummary>;
  resumeFlutterCapture(input: { captureId: string }): Promise<FlutterCaptureSummary>;
  stopFlutterCapture(input: { captureId: string }): Promise<FlutterCapture>;
  /** The current capture of the project's running recording session, if any. */
  getActiveFlutterCapture(input: { projectId: string }): Promise<FlutterCaptureSummary | null>;
  cancelFlutterCapture(input: { captureId: string }): Promise<void>;
  beginFlutterNarration(input: { captureId: string; mimeType: string }): Promise<{ startedAtHostMonotonicMs: number }>;
  appendFlutterNarration(input: { captureId: string; mimeType: string; bytes: Uint8Array }): Promise<void>;
  finishFlutterNarration(input: { captureId: string }): Promise<FlutterCapture['narration']>;
  transcribeFlutterCapture(input: { projectId: string; captureId: string; cloud?: CloudTranscriptionScope }): Promise<LocalTranscript>;
  readFlutterCaptureNarration(input: { captureId: string }): Promise<RecordingAsset>;
  setFlutterCaptureShareState(input: { captureId: string; state: NonNullable<FlutterCaptureSummary['shareState']> }): Promise<FlutterCaptureSummary>;
  listFlutterCaptures(input: { projectId: string }): Promise<FlutterCaptureSummary[]>;
  getFlutterCapture(input: { projectId: string; captureId: string }): Promise<FlutterCapture>;
  readFlutterCaptureScreenshot(input: { captureId: string; artifactId: string }): Promise<RecordingAsset>;
  onFlutterCaptureLifecycle(listener: (event: FlutterCaptureLifecycleEvent) => void): () => void;
  onFlutterCaptureLaunchLog(listener: (event: FlutterCaptureLaunchLogEvent) => void): () => void;
  listPatrolTests(input: { projectId: string; organizationId: string }): Promise<PatrolSavedTest[]>;
  listPatrolTestVersions(input: { projectId: string; organizationId: string; testId: string }): Promise<PatrolSavedTest[]>;
  runPatrolTest(input: PatrolRunInput): Promise<PatrolAttempt>;
  cancelPatrolRun(input: { organizationId: string; projectId: string; testId: string; attemptId: string }): Promise<PatrolAttempt>;
  listPatrolAttempts(input: { projectId: string; organizationId: string; testId: string }): Promise<PatrolAttempt[]>;
  /** Freezes the tests at their latest saved versions; the run is not started. */
  createPatrolRun(input: { organizationId: string; projectId: string; testIds: readonly string[]; name: string }): Promise<PatrolRun>;
  /** Runs every test of the run from one Patrol build on the device, in the background. */
  startPatrolRun(input: { organizationId: string; projectId: string; runId: string; deviceId: string; sourceHandle: string }): Promise<PatrolRun>;
  listPatrolRuns(input: { organizationId: string; projectId: string }): Promise<{ runs: PatrolRun[]; attempts: PatrolAttempt[] }>;
  /** Stops the run: the executing test is canceled and the rest are not started. */
  stopPatrolRun(input: { organizationId: string; projectId: string; runId: string }): Promise<PatrolRun>;
  /** Removes a run that is not running. Its attempts and artifacts are kept. */
  deletePatrolRun(input: { organizationId: string; projectId: string; runId: string }): Promise<void>;
  readPatrolArtifact(input: { organizationId: string; projectId: string; testId: string; attemptId: string; relativePath: string }): Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** Plain-text log of one test of a run, or of the whole run when attemptId is omitted. */
  readPatrolRunLog(input: { organizationId: string; projectId: string; runId: string; attemptId?: string }): Promise<string>;
  /**
   * The run's console so far: Patrol's output of its latest start and why it
   * could not run. Without that start's output in memory (SaySpec restarted),
   * the stored run log or the recorded reasons.
   */
  attachPatrolRunConsole(input: { organizationId: string; projectId: string; runId: string }): Promise<{ text: string; seq: number }>;
  onPatrolRunConsole(listener: (event: PatrolRunConsoleEvent) => void): () => void;
  /** Output so far of the run's analysis terminal; the session token is present while the agent is live. */
  attachPatrolRunAnalysis(input: { organizationId: string; projectId: string; runId: string }): Promise<{ output: string; seq: number; sessionToken?: string }>;
  writePatrolRunAnalysis(input: { runId: string; sessionToken: string; data: string }): Promise<void>;
  resizePatrolRunAnalysis(input: { runId: string; sessionToken: string; cols: number; rows: number }): Promise<void>;
  /** Starts the analysis again for a finished run with a failure. */
  restartPatrolRunAnalysis(input: { organizationId: string; projectId: string; runId: string; sourceHandle: string }): Promise<PatrolRun>;
  /** Opens the analysis HTML report in the default browser. */
  openPatrolRunReport(input: { organizationId: string; projectId: string; runId: string }): Promise<void>;
  onPatrolRunAnalysisEvent(listener: (event: PatrolRunAnalysisEvent) => void): () => void;
  /**
   * Turns one app-bug or bad-test issue of a run's analysis into what a fix
   * session takes: the test's failed attempt in the run and a failure analysis
   * of it built from the issue. Asking again for the same issue returns the same analysis.
   */
  preparePatrolIssueFix(input: { organizationId: string; projectId: string; runId: string; issueId: string; testId: string }): Promise<{ attempt: PatrolAttempt; analysis: FailureAnalysis }>;
  /** Test-fix proposals for the project's saved Patrol tests. */
  listPatrolTestFixProposals(input: { organizationId: string; projectId: string; idToken?: string }): Promise<ManagedTestFixProposal[]>;
  /** Starts a test-fix session; its terminal is driven through the managed-fix write/resize/close calls and events. */
  startPatrolTestFixSession(input: { organizationId: string; projectId: string; testId: string; attemptId: string; analysisId: string; sourceHandle?: string; cols: number; rows: number; idToken?: string }): Promise<{ state: 'running'; sessionToken: string }>;
  decidePatrolTestFix(input: { organizationId: string; projectId: string; testId: string; proposalId: string; kind: 'approve' | 'reject'; idToken?: string }): Promise<ManagedTestFixProposal>;
  /** Saves the approved proposal as the test's next version, unvalidated until it passes on a device. */
  applyPatrolTestFix(input: { organizationId: string; projectId: string; testId: string; proposalId: string; idToken?: string }): Promise<PatrolSavedTest>;
  listPatrolLeases(): Promise<PatrolDeviceLease[]>;
  /** The target's repository, its committable changes and SaySpec's earlier commits for it. */
  getGitView(input: { target: GitTarget }): Promise<GitTargetView>;
  /** Commits `paths` to a new SaySpec branch, or to the checked-out branch when SaySpec created it. */
  commitGitChanges(input: { target: GitTarget; paths: string[]; message: string; branch: { kind: 'new'; name: string } | { kind: 'current' } }): Promise<GitCommitRecord>;
  pushGitCommit(input: { target: GitTarget; commitId: string }): Promise<GitCommitRecord>;
  /** Creates the pull request with the GitHub CLI when it is signed in, otherwise opens the host's new-pull-request page. */
  openGitPullRequest(input: { target: GitTarget; commitId: string }): Promise<GitCommitRecord>;
}
