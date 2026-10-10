import { CONTRACT_SCHEMA_VERSION, type TraceBundle } from './domain.ts';

const scope = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  organizationId: 'org_acme', projectId: 'project_storefront',
  createdByUid: 'user_tester', createdAt: '2026-09-20T10:00:00.000Z',
} as const;
const versionHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export const validTraceBundle: TraceBundle = {
  recording: {
    ...scope, kind: 'recording', id: 'recording_checkout', targetType: 'web',
    environmentSnapshotId: 'env_preview', captureAdapter: { name: 'web-capture', version: '1.0.0' },
    sessionId: 'session_checkout', timebase: 'monotonic-ms',
    segments: [{ id: 'segment_01', startMs: 0, endMs: 3_000, pausedAfter: false }],
    events: [{
      id: 'event_01', segmentId: 'segment_01', elapsedMs: 1_000, context: 'page:checkout',
      action: 'click', targetDescription: 'Place order', evidenceArtifactIds: ['artifact_screen'],
    }],
    artifacts: [{
      id: 'artifact_screen', relativePath: 'evidence/checkout.png',
      sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      byteLength: 4_096, mimeType: 'image/png', storage: 'cloud-storage',
    }], completenessWarnings: [],
  },
  version: {
    ...scope, kind: 'test-version', id: 'version_checkout_01', testId: 'test_checkout', version: 1,
    publishedAt: '2026-09-20T10:10:00.000Z', publishedByUid: 'user_reviewer', source: 'recording',
    recordingId: 'recording_checkout', contentHash: versionHash,
    intent: {
      prerequisites: ['A cart contains one item'], unresolvedQuestions: [],
      steps: [{ id: 'step_01', action: 'Click', target: 'Place order', expectedOutcome: 'Order confirmation is visible', evidenceIds: ['event_01'] }],
    },
    runtime: {
      schemaVersion: CONTRACT_SCHEMA_VERSION, id: 'runtime_checkout_01', framework: 'playwright',
      frameworkVersion: '1.55.0', adapterVersion: '1.0.0', entrypoint: 'tests/checkout.spec.ts',
      files: [{
        id: 'file_checkout', relativePath: 'tests/checkout.spec.ts',
        sha256: '2a928336a8f5d00e79a033b68cff7e631762e2bf0f65a703772d907c658a2127',
        byteLength: 49, mimeType: 'text/typescript', storage: 'firestore',
        text: "import { test, expect } from '@playwright/test';\n",
      }], dependencies: { '@playwright/test': '1.55.0' },
      requiredCapabilities: ['browser:chromium'], secretPlaceholders: ['TEST_USER_PASSWORD'],
    },
  },
  attempt: {
    ...scope, kind: 'attempt', id: 'attempt_checkout_01', runPlanId: 'run_checkout',
    testVersionId: 'version_checkout_01', testVersionHash: versionHash,
    environmentSnapshotId: 'env_preview', executionManifestHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    state: 'failed', startedAt: '2026-09-20T10:20:00.000Z', finishedAt: '2026-09-20T10:20:05.000Z',
    runner: { kind: 'desktop-local', version: '1.0.0', machineLabel: 'Synthetic macOS runner' },
  },
  result: {
    ...scope, kind: 'test-result', id: 'result_checkout_01', attemptId: 'attempt_checkout_01',
    testVersionId: 'version_checkout_01', testVersionHash: versionHash, outcome: 'failed',
    expected: 'Order confirmation is visible', actual: 'Payment service unavailable',
    artifactIds: ['artifact_trace'], completedAt: '2026-09-20T10:20:05.000Z',
  },
  analysis: {
    ...scope, kind: 'analysis', id: 'analysis_checkout_01', resultId: 'result_checkout_01',
    category: 'application', expected: 'Order confirmation is visible', actual: 'Payment service unavailable',
    evidenceArtifactIds: ['artifact_trace'], confidence: 'medium', limitations: ['No server log was provided'],
    recommendedAction: 'Inspect the payment service response.',
  },
  proposal: {
    ...scope, kind: 'proposal', id: 'proposal_checkout_01', analysisId: 'analysis_checkout_01', target: 'test',
    baseTestVersionId: 'version_checkout_01', baseContentHash: versionHash,
    patchArtifact: {
      id: 'artifact_patch', relativePath: 'patches/checkout.diff',
      sha256: '282a2db76b7b6a37366d552d1d46808d923519b79e25291603bb4556d8960e4e',
      byteLength: 22, mimeType: 'text/x-diff', storage: 'firestore', text: '@@ -1 +1 @@\n-old\n+new\n',
    },
    proposalHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    affectedPaths: ['tests/checkout.spec.ts'], assertionChanges: ['Expected confirmation wording changes'], approval: null,
  },
};

export const legacyRecordingV09 = {
  schemaVersion: '0.9.0', id: 'recording_legacy', orgId: 'org_acme', projectId: 'project_storefront',
  userId: 'user_tester', createdAt: '2026-09-20T09:00:00.000Z', target: 'web', sessionId: 'session_legacy',
} as const;

export const invalidTraversalBundle = structuredClone(validTraceBundle);
(invalidTraversalBundle.proposal.patchArtifact as { relativePath: string }).relativePath = '../outside.diff';

export const invalidCrossTenantBundle = structuredClone(validTraceBundle);
(invalidCrossTenantBundle.result as { organizationId: string }).organizationId = 'org_attacker';

export const invalidHashBundle = structuredClone(validTraceBundle);
(invalidHashBundle.version.runtime!.files[0] as { sha256: string }).sha256 = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export const invalidMissingAssetRecording = structuredClone(validTraceBundle.recording);
(invalidMissingAssetRecording.events[0] as unknown as { evidenceArtifactIds: string[] }).evidenceArtifactIds = ['artifact_missing'];
