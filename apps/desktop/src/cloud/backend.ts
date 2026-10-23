import type { CloudPatrolTestVersion, PlanKind, PlaywrightGenerationDraft, PortableWebTestBundle, PortableWebSource, RecordingManifest, SavedWebTestAttempt, TestStorageMode, TestSuite } from '@sayspec/contracts';
import type { JoinFailure } from '../join-code';

/**
 * The optional cloud backend: accounts, team workspaces, shared test storage,
 * reviews and evidence sharing.
 *
 * SaySpec is fully usable without one: recording, transcription, generation,
 * runs and fixes all work against this Mac (Local storage) or a folder. A
 * build includes a backend only when it is configured (see `load.ts`), and the
 * app reaches it only through this interface, so a backend can be replaced or
 * removed without touching the screens that use it. `firebase/` is the
 * implementation behind SaySpec Cloud.
 *
 * Subscriptions call `next` with the current value right away (or as soon as
 * it is known) and again after every change, until the returned function is
 * called. Writes are authorized by the backend; the desktop only mirrors the
 * rules to explain them.
 */
export interface CloudBackend {
  /** Stable identifier, for example "firebase". */
  readonly id: string;
  /** A local development backend (emulators): the sign-in form is prefilled with the seeded test account. */
  readonly development: boolean;
  readonly auth: CloudAuth;
  readonly workspaces: CloudWorkspaces;
  readonly projects: CloudProjects;
  readonly tests: CloudTests;
  readonly runs: CloudRuns;
  readonly reviews: CloudReviews;
  readonly sharing: CloudSharing;
}

export type Unsubscribe = () => void;
export type CloudUser = { uid: string; email: string | null; displayName: string | null };
export type ProjectRef = { organizationId: string; projectId: string };

/** A workspace (organization) the signed-in person belongs to, with their role in it. */
export type OrganizationScope = { id: string; name: string; role: string };
/** `testStorage` is the project's shared storage choice; projects created before the choice existed keep their tests in SaySpec Cloud. */
export type ProjectScope = { id: string; name: string; targetType: 'web' | 'flutter'; baseUrl?: string; access: string; testStorage?: TestStorageMode };
export type JoinResult = { organizationId: string; name: string; role: string; joined: boolean };
export type AuthFailure = { status: 'offline' | 'signed-out' | 'revoked'; message: string };

export interface CloudAuth {
  /** The signed-in person, or null; called again after sign-in, sign-out and profile changes. */
  onUserChanged(next: (user: CloudUser | null) => void, failed: (error: unknown) => void): Unsubscribe;
  currentUser(): CloudUser | null;
  signIn(email: string, password: string): Promise<CloudUser>;
  /** Creates the person's own account. No workspace is created; joining happens with a company code. */
  signUp(input: { email: string; password: string; displayName: string }): Promise<CloudUser>;
  /** Neutral: resolves for known and unknown accounts alike. */
  sendPasswordReset(email: string): Promise<void>;
  signOut(): Promise<void>;
  /** Re-validates the session with the server; rejects when it was revoked or the server is unreachable. */
  refreshSession(): Promise<CloudUser | null>;
  /**
   * A short-lived bearer token for the signed-in person. The main process
   * forwards it to the backend for fix decisions (see `electron/cloud-fix-authority.ts`).
   */
  idToken(): Promise<string | undefined>;
  /** Maps a failed auth call to what the person sees. */
  describeError(error: unknown): AuthFailure;
}

export interface CloudWorkspaces {
  subscribeOrganizations(uid: string, next: (organizations: OrganizationScope[]) => void, failed: () => void): Unsubscribe;
  subscribeProjects(uid: string, organizationId: string, next: (projects: ProjectScope[]) => void, failed: () => void): Unsubscribe;
  /** The workspace's plan; null while unknown. */
  subscribePlan(organizationId: string, next: (plan: PlanKind | null) => void): Unsubscribe;
  /** Joins a workspace with its company code, as Editor. Idempotent for existing members. */
  redeemJoinCode(code: string): Promise<JoinResult>;
  describeJoinError(error: unknown): JoinFailure;
}

export interface CloudProjects {
  create(input: ProjectRef & { name: string; targetType: 'web' | 'flutter'; baseUrl?: string; access: 'restricted' | 'all-members'; testStorage: TestStorageMode }): Promise<void>;
  /** Changes a Web project's base URL for the whole team. */
  setBaseUrl(input: ProjectRef & { baseUrl: string }): Promise<void>;
  /** Deletes the project for everyone, with its tests, versions, runs and shared recordings. */
  remove(input: ProjectRef): Promise<void>;
  /** Records the project's storage choice for the whole team. */
  setTestStorage(input: ProjectRef & { testStorage: TestStorageMode }): Promise<void>;
  /** The team's shared SAYSPEC.md text, or null when none is stored. */
  subscribeTestInstructions(input: ProjectRef, next: (text: string | null) => void): Unsubscribe;
  setTestInstructions(input: ProjectRef & { text: string }): Promise<void>;
}

/** A test kept in cloud storage, plus the review fields only cloud storage has. */
export type CloudTest = {
  id: string; title: string; createdAt: string; authorLabel?: string; recordingId?: string;
  ownerUid?: string; reviewerUid?: string | null; reviewerRevision?: number;
  /** A Flutter test's current version, which every Mac pulls and runs locally. */
  currentVersionId?: string; currentVersionHash?: string;
};
export type CloudSuite = { id: string; name: string; revision: number; testIds: string[]; sourceRecordingId?: string };
/** Where the next page starts. Opaque to callers. */
export type CloudPageCursor = { readonly kind: 'cloud-page-cursor' };
export type SuiteChange = ProjectRef & { suiteId: string; expectedRevision: number; name: string; testIds: string[]; sourceRecordingId?: string };
export type TestIntent = { prerequisites: readonly string[]; steps: Array<{ action: string; target: string; expectedOutcome: string; evidenceIds: readonly string[] }>; unresolvedQuestions: readonly string[] };

export interface CloudTests {
  subscribeSuites(input: ProjectRef, next: (suites: TestSuite[]) => void, failed: () => void): Unsubscribe;
  /** One page of active tests ordered by title, starting after `after` (null for the first page). */
  subscribePage(input: ProjectRef & { after: CloudPageCursor | null; size: number }, next: (page: { tests: CloudTest[]; last: CloudPageCursor | null }) => void, failed: () => void): Unsubscribe;
  /** Every active test, for copying the library to another storage. */
  list(input: ProjectRef): Promise<CloudTest[]>;
  count(input: ProjectRef): Promise<number>;
  listSuites(input: ProjectRef): Promise<CloudSuite[]>;
  readSuite(input: ProjectRef & { suiteId: string }): Promise<CloudSuite | null>;
  /** The source of a test's current draft, when one has been generated. */
  readDraftSource(input: ProjectRef & { testId: string }): Promise<(PortableWebSource & { recordingId?: string }) | undefined>;
  /** Creates the test's draft when it does not exist yet, then saves `generation` as its current revision. */
  saveDraft(input: ProjectRef & { testId: string; title: string; folder: string; tags: string[]; intent: TestIntent; generation: PlaywrightGenerationDraft | Record<string, unknown> }): Promise<void>;
  rename(input: ProjectRef & { testId: string; title: string }): Promise<void>;
  archive(input: ProjectRef & { testId: string }): Promise<void>;
  saveSuite(input: SuiteChange): Promise<void>;
  /** Deletes an empty suite; `expectedRevision` guards against a teammate's change meanwhile. */
  deleteSuite(input: ProjectRef & { suiteId: string; expectedRevision: number }): Promise<void>;
  moveTest(input: ProjectRef & { testId: string; targetSuiteId: string | null }): Promise<void>;
  /** Stores an imported portable bundle as a new test. */
  importPortable(input: ProjectRef & { testId: string; bundle: PortableWebTestBundle }): Promise<void>;
  /** A Flutter test's stored version, or undefined when it does not exist. */
  readPatrolVersion(input: ProjectRef & { testId: string; versionId: string }): Promise<CloudPatrolTestVersion | undefined>;
  /** Saves a Flutter test's source as its new current version (creating the test); the current source again is a no-op. */
  savePatrolVersion(input: ProjectRef & CloudPatrolTestVersion): Promise<{ versionId: string; created: boolean }>;
}

export type CloudRunSnapshot = { schemaVersion: 1; id: string; organizationId: string; projectId: string; name: string; environmentHash: string; items: Array<{ testId: string; versionId: string; contentHash: string; title: string }> };

/** Runs execute on this Mac; the backend keeps a client-reported record of them for the team. */
export interface CloudRuns {
  /** Confirms the person may run these exact versions before the run starts. */
  authorize(input: ProjectRef & { items: Array<{ testId: string; versionId: string; contentHash: string }> }): Promise<void>;
  recordRun(input: ProjectRef & { run: CloudRunSnapshot }): Promise<void>;
  recordAttempt(input: ProjectRef & { testId: string; attempt: SavedWebTestAttempt }): Promise<void>;
}

export type CloudTestVersion = { id: string; version: number; contentHash: string };
export type CloudComment = { id: string; body: string; authorUid: string };
export type CloudActivity = { id: string; kind: string; actorUid: string };

export interface CloudReviews {
  /** Versions published to the cloud for a test. */
  subscribeVersions(input: ProjectRef & { testId: string }, next: (versions: CloudTestVersion[]) => void, failed: () => void): Unsubscribe;
  /** Comments on a published version, or on a version saved on someone's Mac (`local`). */
  subscribeComments(input: ProjectRef & { testId: string; versionId: string; local: boolean }, next: (comments: CloudComment[]) => void, failed: () => void): Unsubscribe;
  /** Active members who can review (owners, admins, reviewers). */
  subscribeReviewers(organizationId: string, next: (members: Array<{ uid: string; role: string }>) => void): Unsubscribe;
  subscribeActivity(input: ProjectRef, next: (items: CloudActivity[]) => void): Unsubscribe;
  comment(input: ProjectRef & { testId: string; versionId: string; versionHash: string; commentId: string; body: string }): Promise<void>;
  assignReviewer(input: ProjectRef & { testId: string; reviewerUid: string | null; expectedRevision: number }): Promise<void>;
}

/** One evidence file to upload. Progress is reported as a fraction from 0 to 1. */
export type ShareUpload = { artifactId: string; bytes: Uint8Array; mimeType: string; metadata: Record<string, string>; signal: AbortSignal; onProgress(fraction: number): void };

/**
 * Opt-in sharing of reviewed evidence. A share is begun with its manifest,
 * every artifact is uploaded, then it is finalized; the backend checks the
 * uploads against the manifest hash.
 */
export interface CloudSharing {
  beginRecordingShare(input: { manifest: RecordingManifest; manifestHash: string }): Promise<void>;
  uploadRecordingArtifact(input: ProjectRef & { recordingId: string } & ShareUpload): Promise<void>;
  finalizeRecordingShare(input: ProjectRef & { recordingId: string; manifestHash: string }): Promise<void>;
  beginFlutterShare(input: { manifest: Record<string, unknown>; manifestHash: string }): Promise<void>;
  uploadFlutterArtifact(input: ProjectRef & { shareId: string } & ShareUpload): Promise<void>;
  finalizeFlutterShare(input: ProjectRef & { shareId: string; manifestHash: string }): Promise<void>;
}
