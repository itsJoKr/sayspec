import type { FlutterCapture, PatrolAttempt, PatrolSavedTest } from '@sayspec/contracts';
import type { CloudBackend } from './cloud/backend';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
async function hash(bytes: Uint8Array | string) {
  const value = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const copy = new Uint8Array(value.byteLength); copy.set(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer))].map((item) => item.toString(16).padStart(2, '0')).join('');
}
export async function shareFlutterSlice(cloud: CloudBackend, input: { capture: FlutterCapture; version: PatrolSavedTest; attempt: PatrolAttempt; createdByUid: string; includeRawAudio: boolean; signal: AbortSignal; onProgress(value: number, label: string): void }) {
  const { capture, version, attempt } = input;
  if (cloud.auth.currentUser()?.uid !== input.createdByUid) throw new Error('The signed-in account changed. Reopen this Flutter recording in the correct workspace.');
  if (capture.summary.organizationId === 'local' || capture.summary.organizationId !== version.organizationId || capture.summary.projectId !== version.projectId) throw new Error('Flutter sharing requires the active Pro project.');
  if (version.recordingCaptureId !== capture.summary.id || version.state !== 'published' || attempt.testId !== version.id || attempt.versionId !== version.versionId || attempt.testContentHash !== version.contentHash) throw new Error('The selected Flutter recording, immutable version and attempt do not match.');
  const localArtifacts: Array<{ id: string; kind: 'screenshot' | 'narration' | 'attempt'; sha256: string; byteLength: number; mimeType: string; read(): Promise<Uint8Array> }> = [];
  for (const artifact of capture.artifacts.filter((item) => item.mimeType === 'image/png').slice(0, 100)) localArtifacts.push({ id: `capture_${artifact.id}`, kind: 'screenshot', sha256: artifact.sha256, byteLength: artifact.byteLength, mimeType: artifact.mimeType, async read() { return (await window.sayspec!.readFlutterCaptureScreenshot({ captureId: capture.summary.id, artifactId: artifact.id })).bytes; } });
  if (input.includeRawAudio && capture.narration?.sha256 && capture.narration.byteLength) localArtifacts.push({ id: 'raw_narration', kind: 'narration', sha256: capture.narration.sha256, byteLength: capture.narration.byteLength, mimeType: capture.narration.mimeType, async read() { return (await window.sayspec!.readFlutterCaptureNarration({ captureId: capture.summary.id })).bytes; } });
  for (const artifact of attempt.artifacts.filter((item) => item.byteLength <= 20 * 1024 * 1024 && !item.relativePath.endsWith('.apk')).slice(0, 99)) localArtifacts.push({ id: `attempt_${(await hash(artifact.relativePath)).slice(0, 20)}`, kind: 'attempt', sha256: artifact.sha256, byteLength: artifact.byteLength, mimeType: artifact.mimeType, async read() { return (await window.sayspec!.readPatrolArtifact({ organizationId: attempt.organizationId, projectId: attempt.projectId, testId: attempt.testId, attemptId: attempt.id, relativePath: artifact.relativePath })).bytes; } });
  const runtime = version.validatedRuntime ?? attempt.runtime;
  const manifest = {
    schemaVersion: 1, kind: 'flutter-slice', id: `flutter_share_${version.versionId.replace(/^patrol_version_/, '')}`, organizationId: version.organizationId, projectId: version.projectId, createdByUid: input.createdByUid, includeRawAudio: input.includeRawAudio,
    capture: { id: capture.summary.id, organizationId: capture.summary.organizationId, projectId: capture.summary.projectId, title: capture.summary.title, platform: capture.summary.platform, appId: capture.summary.appId, recorderSdkVersion: capture.summary.recorderSdkVersion, recorderSchemaVersion: capture.summary.recorderSchemaVersion, clock: capture.clock, events: capture.events, assertions: capture.assertions, transcript: capture.transcript },
    testVersion: { id: version.id, versionId: version.versionId, version: version.version, organizationId: version.organizationId, projectId: version.projectId, recordingCaptureId: version.recordingCaptureId, title: version.title, relativePath: version.relativePath, source: version.source, contentHash: version.contentHash, state: 'published', dependencies: version.dependencies, provider: version.provider, requirements: { platform: 'android', appId: capture.summary.appId, entrypoint: runtime.entrypoint, flutterVersion: runtime.flutterVersion, dartVersion: runtime.dartVersion, patrolCliVersion: runtime.patrolCliVersion, patrolPackageVersion: runtime.patrolPackageVersion, apiLevel: runtime.apiLevel } },
    attempt: { id: attempt.id, testId: attempt.testId, versionId: attempt.versionId, organizationId: attempt.organizationId, projectId: attempt.projectId, testContentHash: attempt.testContentHash, state: attempt.state, summary: attempt.summary, detail: attempt.detail, passed: attempt.passed, failed: attempt.failed, skipped: attempt.skipped, tests: attempt.tests, clientReported: true, runner: 'desktop-local-patrol' },
    artifacts: localArtifacts.map(({ read: _read, ...artifact }) => ({ ...artifact, storage: 'cloud-storage' as const })),
  };
  if (new TextEncoder().encode(JSON.stringify(manifest)).byteLength > 900 * 1024) throw new Error('This Flutter share package exceeds the safe metadata budget. Record a shorter focused flow.');
  const manifestHash = await hash(canonicalJson(manifest));
  await window.sayspec!.setFlutterCaptureShareState({ captureId: capture.summary.id, state: 'uploading' });
  try {
    await cloud.sharing.beginFlutterShare({ manifest, manifestHash });
    for (const [index, artifact] of localArtifacts.entries()) {
      if (input.signal.aborted) throw new DOMException('Sharing canceled.', 'AbortError');
      const bytes = await artifact.read();
      if (bytes.byteLength !== artifact.byteLength || await hash(bytes) !== artifact.sha256) throw new Error(`${artifact.id} no longer matches its saved Flutter evidence hash.`);
      await cloud.sharing.uploadFlutterArtifact({ organizationId: version.organizationId, projectId: version.projectId, shareId: manifest.id, artifactId: artifact.id, bytes, mimeType: artifact.mimeType, metadata: { organizationId: version.organizationId, projectId: version.projectId, sha256: artifact.sha256, manifestHash }, signal: input.signal, onProgress: (part) => input.onProgress((index + part) / Math.max(1, localArtifacts.length), `Uploading ${index + 1} of ${localArtifacts.length}`) });
    }
    await cloud.sharing.finalizeFlutterShare({ organizationId: version.organizationId, projectId: version.projectId, shareId: manifest.id, manifestHash });
    await window.sayspec!.setFlutterCaptureShareState({ captureId: capture.summary.id, state: 'shared' }); input.onProgress(1, 'Shared');
    return { shareId: manifest.id, manifestHash };
  } catch (error) { await window.sayspec!.setFlutterCaptureShareState({ captureId: capture.summary.id, state: 'failed' }).catch(() => undefined); throw error; }
}
