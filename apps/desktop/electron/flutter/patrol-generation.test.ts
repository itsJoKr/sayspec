import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlutterCapture } from '@sayspec/contracts';
import { validatePatrolGenerationSubmission } from './patrol-generation.ts';

const source = `// SAYSPEC_GENERATED
import 'package:flutter_test/flutter_test.dart';
import 'package:patrol/patrol.dart';
void main() { patrolTest('receipt total', ($) async { expect($('Total: \\$12'), findsOneWidget); }); }
`;
const capture: FlutterCapture = {
  summary: { schemaVersion: 1, id: 'flutter_capture_00000000-0000-0000-0000-000000000001', organizationId: 'local', projectId: 'project_one', title: 'Receipt', status: 'ready', startedAt: new Date().toISOString(), durationMs: 1000, eventCount: 1, deviceId: 'emulator-5554', deviceName: 'Slim', platform: 'android', appId: 'dev.sayspec.fixture', recorderSdkVersion: '0.9.0', recorderSchemaVersion: 1, completenessWarnings: [] },
  clock: { offsetMs: 1, roundTripMs: 10, samples: 3, uncertaintyMs: 5 },
  events: [{ id: 'event_receipt_total', seq: 1, kind: 'action', monotonicMs: 500, hostAlignedMs: 501, widget: { widgetType: 'Text', key: 'receiptTotal', ancestors: [], candidates: [{ kind: 'key', value: 'receiptTotal', confidence: 'high' }] }, payload: { action: 'observe' } }],
  artifacts: [], narration: { artifactId: 'artifact_audio', captureId: 'flutter_capture_00000000-0000-0000-0000-000000000001', mimeType: 'audio/webm', startedAtHostMonotonicMs: 0, finishedAtHostMonotonicMs: 1000, durationMs: 1000, sha256: 'a'.repeat(64), byteLength: 100 },
  transcript: { schemaVersion: 1, recordingId: 'flutter_capture_00000000-0000-0000-0000-000000000001', status: 'ready', provider: { kind: 'local', runtime: 'whisper.cpp', runtimeVersion: 'fixture', modelId: 'small', modelSha256: 'b'.repeat(64), translated: false }, segments: [{ id: 'transcript_one', recordingSegmentId: 'narration', startMs: 0, endMs: 1000, timingUncertaintyMs: 5, originalText: 'The receipt total should be twelve dollars.', text: 'The receipt total should be twelve dollars.', revisions: [], evidenceEventIds: ['event_receipt_total'] }], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), warnings: [] },
  assertions: [{ eventId: 'event_receipt_total', suggestion: "find.byKey(const ValueKey<String>('receiptTotal'))", confidence: 'high', rationale: 'Recorded key.' }],
};

const submission = { captureId: capture.summary.id, title: 'Receipt total', framework: 'patrol', relativePath: 'patrol_test/receipt_total_test.dart', source, dependencies: { patrol: '^4.10.0' }, transcriptSegmentIds: ['transcript_one'], evidenceEventIds: ['event_receipt_total'] };

test('Patrol generation binds exact source, dependency pins, narration and evidence', () => {
  const result = validatePatrolGenerationSubmission(submission, [capture], { patrol: '^4.10.0' });
  assert.equal(result.submission.source, source);
  assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
  assert.throws(() => validatePatrolGenerationSubmission({ ...submission, framework: 'flutter_driver' }, [capture], { patrol: '^4.10.0' }), /Unsupported framework/);
  assert.throws(() => validatePatrolGenerationSubmission({ ...submission, dependencies: { patrol: '^4.9.0' } }, [capture], { patrol: '^4.10.0' }), /differs/);
  assert.throws(() => validatePatrolGenerationSubmission({ ...submission, source: source.replace(/expect\([^;]+;/, '') }, [capture], { patrol: '^4.10.0' }), /no explicit assertion/);
  assert.throws(() => validatePatrolGenerationSubmission({ ...submission, evidenceEventIds: ['event_missing'] }, [capture], { patrol: '^4.10.0' }), /outside its recording/);
});

test('Patrol generation binds each test to one recording of the session', () => {
  const other: FlutterCapture = { ...capture, summary: { ...capture.summary, id: 'flutter_capture_00000000-0000-0000-0000-000000000002', title: 'Recording 2' }, events: [{ ...capture.events[0], id: 'event_other' }] };
  assert.equal(validatePatrolGenerationSubmission(submission, [other, capture], { patrol: '^4.10.0' }).capture.summary.id, capture.summary.id);
  assert.throws(() => validatePatrolGenerationSubmission({ ...submission, captureId: 'flutter_capture_elsewhere' }, [other, capture], { patrol: '^4.10.0' }), /one recording of this session/);
  assert.throws(() => validatePatrolGenerationSubmission({ ...submission, evidenceEventIds: ['event_other'] }, [other, capture], { patrol: '^4.10.0' }), /outside its recording/);
});

test('Patrol generation refuses missing narration and cited actions without identity', () => {
  assert.throws(() => validatePatrolGenerationSubmission(submission, [{ ...capture, narration: undefined }], { patrol: '^4.10.0' }), /no verified microphone narration/);
  assert.throws(() => validatePatrolGenerationSubmission(submission, [{ ...capture, events: [{ ...capture.events[0], widget: undefined }] }], { patrol: '^4.10.0' }), /no widget identity/);
});

test('Patrol generation refuses stale, empty and ambiguous capture inputs', () => {
  assert.throws(() => validatePatrolGenerationSubmission({ ...submission, evidenceEventIds: [] }, [capture], { patrol: '^4.10.0' }), /at least one valid evidence event ID/);
  assert.throws(() => validatePatrolGenerationSubmission(submission, [{ ...capture, summary: { ...capture.summary, status: 'interrupted' } }], { patrol: '^4.10.0' }), /only a completed capture/);
  // An iOS simulator recording generates like an Android one.
  assert.equal(validatePatrolGenerationSubmission(submission, [{ ...capture, summary: { ...capture.summary, platform: 'ios', deviceId: 'ios:EB53E3BE-AB3C-4C14-B5A3-4A489A5AB4CE' } }], { patrol: '^4.10.0' }).submission.captureId, capture.summary.id);
  assert.throws(() => validatePatrolGenerationSubmission(submission, [{ ...capture, assertions: [{ ...capture.assertions[0], confidence: 'low' }] }], { patrol: '^4.10.0' }), /only ambiguous type-based finders/);
});
