import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTRACT_BUDGETS, ContractValidationError, canTransitionJob,
  invalidCrossTenantBundle, invalidHashBundle, invalidMissingAssetRecording,
  invalidTraversalBundle, legacyRecordingV09, migrateRecordingV09,
  validTraceBundle, validateRecordingManifest, validateTestVersion,
  validateJobRecord, validateTraceBundle, validateTraceBundleIntegrity,
  isProPlan, planKind,
} from './index.ts';

test('traces one recording through immutable version, result, analysis, and proposal', async () => {
  const bundle = await validateTraceBundleIntegrity(validTraceBundle);
  assert.equal(bundle.version.recordingId, bundle.recording.id);
  assert.equal(bundle.result.testVersionId, bundle.version.id);
  assert.equal(bundle.proposal.analysisId, bundle.analysis.id);
  assert.equal(bundle.proposal.approval, null);
});

test('rejects traversal, cross-tenant references, and missing evidence', () => {
  assert.throws(() => validateTraceBundle(invalidTraversalBundle), /relativePath is unsafe/);
  assert.throws(() => validateTraceBundle(invalidCrossTenantBundle), /crosses the recording tenant scope/);
  assert.throws(() => validateRecordingManifest(invalidMissingAssetRecording), /missing artifact/);
});

test('reports malformed bundles as validation errors rather than throwing incidental type errors', () => {
  assert.throws(() => validateTraceBundle({}), ContractValidationError);
});

test('rejects mismatched inline content hashes', async () => {
  await assert.rejects(validateTraceBundleIntegrity(invalidHashBundle), /hash mismatch/);
});

test('rejects mutable historical fields and oversized inline sources', () => {
  const mutable = structuredClone(validTraceBundle.version) as typeof validTraceBundle.version & { updatedAt: string };
  mutable.updatedAt = '2026-09-20T11:00:00.000Z';
  assert.throws(() => validateTestVersion(mutable), /updatedAt is not allowed/);

  const oversized = structuredClone(validTraceBundle.version);
  const file = oversized.runtime!.files[0] as { text?: string; byteLength: number };
  file.text = 'x'.repeat(CONTRACT_BUDGETS.firestoreTextArtifactBytes + 1);
  file.byteLength = file.text.length;
  assert.throws(() => validateTestVersion(oversized), /exceeds the Firestore text budget/);
});

test('rejects old schema until an explicit idempotent migration is applied', () => {
  assert.throws(() => validateRecordingManifest(legacyRecordingV09), ContractValidationError);
  const migrated = migrateRecordingV09(legacyRecordingV09);
  assert.deepEqual(migrateRecordingV09(legacyRecordingV09), migrated);
  assert.equal(validateRecordingManifest(migrated).schemaVersion, '1.0.0');
});

test('accepts local recording artifacts and validates segment audio references', () => {
  const recording = structuredClone(validTraceBundle.recording) as unknown as {
    artifacts: Array<(typeof validTraceBundle.recording.artifacts)[number]>;
    segments: Array<(typeof validTraceBundle.recording.segments)[number]>;
  } & Omit<typeof validTraceBundle.recording, 'artifacts' | 'segments'>;
  recording.artifacts.push({
    id: 'audio_segment_1', relativePath: 'audio/segment_1.webm',
    sha256: 'b'.repeat(64), byteLength: 128, mimeType: 'audio/webm', storage: 'local-file',
  });
  recording.segments[0] = { ...recording.segments[0], audioArtifactId: 'audio_segment_1' };
  assert.equal(validateRecordingManifest(recording).artifacts.at(-1)?.storage, 'local-file');
  recording.segments[0] = { ...recording.segments[0], audioArtifactId: 'missing_audio' };
  assert.throws(() => validateRecordingManifest(recording), /missing audio artifact/);
});

test('job state machine prevents terminal replay and supports cancellation', () => {
  assert.equal(canTransitionJob('queued', 'preparing'), true);
  assert.equal(canTransitionJob('running', 'cancel-requested'), true);
  assert.equal(canTransitionJob('succeeded', 'running'), false);
  assert.equal(canTransitionJob('failed', 'succeeded'), false);
  assert.throws(() => validateJobRecord({
    schemaVersion: '1.0.0', kind: 'job', id: 'job_test', organizationId: 'org_acme',
    projectId: 'project_storefront', createdByUid: 'user_tester', createdAt: '2026-09-20T10:00:00.000Z',
    jobType: 'generation', idempotencyKey: 'generation-version_checkout_01',
    inputHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    state: 'succeeded', progress: [],
  }), /terminal payload must match terminal state/);
});

test('plans: Pro features come with Beta and Pro, not Free', () => {
  assert.deepEqual(['free', 'beta', 'pro', 'free-beta', undefined].map((kind) => planKind({ plan: { kind } })), ['free', 'beta', 'pro', 'beta', 'beta']);
  assert.equal(planKind(undefined), 'beta');
  assert.deepEqual((['free', 'beta', 'pro'] as const).map(isProPlan), [false, true, true]);
  assert.equal(isProPlan(null), false);
});
