import type { LocalRecordingReview, RecordingManifest } from '@sayspec/contracts';
import type { CloudBackend } from './cloud/backend';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

export async function shareRecording(cloud: CloudBackend, review: LocalRecordingReview, scope: { organizationId: string; projectId: string; createdByUid: string }, signal: AbortSignal, onProgress: (value: number, label: string) => void) {
  if (review.sharingChoice !== 'share-after-review') throw new Error('Choose cloud sharing before starting the recording.');
  if (cloud.auth.currentUser()?.uid !== scope.createdByUid) throw new Error('The signed-in account changed. Reopen the recording in the correct workspace.');
  if (review.projectId !== scope.projectId || review.manifest.organizationId !== scope.organizationId) throw new Error('The active workspace changed. Reopen the recording before sharing.');
  const manifest: RecordingManifest = {
    ...review.manifest,
    artifacts: review.manifest.artifacts.map((artifact) => ({ ...artifact, storage: 'cloud-storage' as const })),
  };
  const manifestHash = await sha256(canonicalJson(manifest));
  await window.sayspec!.setRecordingShareState({ recordingId: review.id, state: 'uploading' });
  try {
    await cloud.sharing.beginRecordingShare({ manifest, manifestHash });
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (signal.aborted) throw new DOMException('Sharing canceled.', 'AbortError');
      const local = await window.sayspec!.readRecordingAsset({ recordingId: review.id, artifactId: artifact.id });
      await cloud.sharing.uploadRecordingArtifact({
        organizationId: scope.organizationId, projectId: scope.projectId, recordingId: review.id, artifactId: artifact.id,
        bytes: local.bytes, mimeType: artifact.mimeType, signal,
        metadata: { organizationId: scope.organizationId, projectId: scope.projectId, sha256: artifact.sha256, manifestHash },
        onProgress: (part) => onProgress((index + part) / Math.max(1, manifest.artifacts.length), `Uploading ${index + 1} of ${manifest.artifacts.length}`),
      });
    }
    await cloud.sharing.finalizeRecordingShare({ organizationId: scope.organizationId, projectId: scope.projectId, recordingId: review.id, manifestHash });
    await window.sayspec!.setRecordingShareState({ recordingId: review.id, state: 'shared' });
    onProgress(1, 'Shared');
  } catch (error) {
    await window.sayspec!.setRecordingShareState({ recordingId: review.id, state: 'failed' }).catch(() => undefined);
    throw error;
  }
}
