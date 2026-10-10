import { createHash, randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CONTRACT_SCHEMA_VERSION, isSafeRelativePath, validateRecordingManifest,
  type ArtifactRef, type LocalRecordingReview, type LocalRecordingStatus, type LocalTranscript,
  type LocalRecordingSummary, type RecordingEvent, type RecordingManifest,
  type RecordingIntentItem, type RecordingIntentReview, type RecordingSharingChoice, type RecordingSegment,
  type PlaywrightGenerationDraft,
} from '@sayspec/contracts';

const RECORDING_ID = /^recording_[a-f0-9-]{36}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/;
const AUDIO_CHUNK_BYTES = 2 * 1024 * 1024;
const MINIMUM_FREE_BYTES = 128 * 1024 * 1024;
const MAX_RECORDING_BYTES = 1024 * 1024 * 1024;

type DraftSegment = {
  id: string;
  startMs: number;
  endMs?: number;
  pausedAfter?: boolean;
  audioRelativePath: string;
  audioMimeType?: string;
};

type DraftRecording = {
  schemaVersion: 1;
  id: string;
  organizationId: string;
  projectId: string;
  createdByUid: string;
  projectName: string;
  title: string;
  startUrl: string;
  status: LocalRecordingStatus;
  startedAt: string;
  finishedAt?: string;
  lastElapsedMs: number;
  sharingChoice: RecordingSharingChoice;
  shareState: LocalRecordingSummary['shareState'];
  segments: DraftSegment[];
  events: RecordingEvent[];
  artifacts: ArtifactRef[];
  completenessWarnings: string[];
};

type RecordingIndex = { schemaVersion: 1; recordings: LocalRecordingSummary[] };
type Clock = { now(): number };

function cleanId(value: unknown, label: string) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function cleanText(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${label} is invalid.`);
  return value.trim();
}

function safeStartUrl(value: unknown) {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new Error('Enter a complete Web URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Web URL must use HTTP(S) and cannot contain credentials.');
  for (const key of [...url.searchParams.keys()]) {
    if (/(?:token|secret|password|authorization|api[-_]?key)/i.test(key)) url.searchParams.set(key, '<redacted>');
  }
  return url.href;
}

async function sha256(filePath: string) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

export class RecordingStore {
  readonly #root: string;
  readonly #indexPath: string;
  readonly #clock: Clock;
  readonly #minimumFreeBytes: number;
  readonly #activeOrigins = new Map<string, number>();
  readonly #drafts = new Map<string, DraftRecording>();
  #index: RecordingIndex = { schemaVersion: 1, recordings: [] };
  #write = Promise.resolve();

  constructor(root: string, options: { clock?: Clock; minimumFreeBytes?: number } = {}) {
    this.#root = path.resolve(root);
    this.#indexPath = path.join(this.#root, 'index.json');
    this.#clock = options.clock ?? { now: () => performance.now() };
    this.#minimumFreeBytes = options.minimumFreeBytes ?? MINIMUM_FREE_BYTES;
  }

  async initialize() {
    await mkdir(this.#root, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.#indexPath, 'utf8')) as RecordingIndex;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.recordings)) throw new Error('Unsupported recording index.');
      this.#index = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.#persistIndex();
    }
    for (const summary of [...this.#index.recordings]) {
      if (!['preparing', 'recording', 'paused'].includes(summary.status)) continue;
      const draft = await this.#readDraft(summary.id);
      draft.completenessWarnings.push('Recording recovered after SaySpec stopped before finalization.');
      await this.#finalize(draft, 'interrupted');
    }
    for (const summary of this.#index.recordings) {
      const transcript = await this.#readOptionalJson<LocalTranscript>(path.join(this.#root, summary.id, 'transcript.json'));
      if (transcript?.status === 'running') await this.writeTranscript(summary.id, {
        ...transcript, status: 'failed', finishedAt: new Date().toISOString(),
        error: 'Local transcription was interrupted when SaySpec closed. Retry to transcribe the unchanged audio.',
      });
      const generation = await this.#readOptionalJson<PlaywrightGenerationDraft>(path.join(this.#root, summary.id, 'generation-draft.json'));
      if (generation?.state === 'generating') await this.writeGenerationDraft(summary.id, {
        ...generation, state: 'failed',
        error: 'Test generation was interrupted when SaySpec closed. The reviewed recording remains unchanged; retry explicitly.',
        warnings: [...new Set([...generation.warnings, 'Interrupted generation was not resumed automatically.'])],
      });
    }
  }

  async create(input: {
    projectId: string; projectName: string; startUrl: string; organizationId?: string;
    createdByUid?: string; sharingChoice: RecordingSharingChoice;
  }) {
    cleanId(input.projectId, 'projectId');
    const projectName = cleanText(input.projectName, 'Project name', 120);
    if (!['local-only', 'share-after-review'].includes(input.sharingChoice)) throw new Error('Recording sharing choice is invalid.');
    const id = `recording_${randomUUID()}`;
    const draft: DraftRecording = {
      schemaVersion: 1, id,
      organizationId: input.organizationId ? cleanId(input.organizationId, 'organizationId') : 'local',
      projectId: input.projectId,
      createdByUid: input.createdByUid ? cleanId(input.createdByUid, 'createdByUid') : 'local_user',
      projectName, title: `${projectName} walkthrough`, startUrl: safeStartUrl(input.startUrl),
      status: 'preparing', startedAt: new Date().toISOString(), lastElapsedMs: 0,
      sharingChoice: input.sharingChoice, shareState: 'local', segments: [], events: [], artifacts: [], completenessWarnings: [],
    };
    await mkdir(path.join(this.#root, id, 'audio'), { recursive: true });
    await mkdir(path.join(this.#root, id, 'screenshots'), { recursive: true });
    this.#drafts.set(id, draft);
    this.#activeOrigins.set(id, this.#clock.now());
    await this.#persistDraft(draft);
    await this.#upsertSummary(draft);
    return this.controlSnapshot(draft);
  }

  async beginSegment(recordingId: string) {
    const draft = await this.#draft(recordingId);
    if (!['preparing', 'paused'].includes(draft.status)) throw new Error('Recording is not ready to resume.');
    if (draft.segments.length === 0) { draft.lastElapsedMs = 0; this.#activeOrigins.set(recordingId, this.#clock.now()); }
    const startMs = draft.segments.length ? this.#elapsed(draft) : 0;
    const id = `segment_${draft.segments.length + 1}`;
    draft.segments.push({ id, startMs, audioRelativePath: `audio/${id}.webm` });
    draft.status = 'recording';
    await this.#persistDraft(draft); await this.#upsertSummary(draft);
    return this.controlSnapshot(draft);
  }

  async appendAudio(input: { recordingId: string; segmentId: string; mimeType: string; bytes: Uint8Array }) {
    const draft = await this.#draft(input.recordingId);
    const segment = draft.segments.find((item) => item.id === input.segmentId);
    if (!segment) throw new Error('Audio segment was not found.');
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > AUDIO_CHUNK_BYTES) throw new Error('Audio chunk exceeds the capture budget.');
    const currentBytes = (await this.#recordingBytes(draft.id));
    if (currentBytes + input.bytes.byteLength > MAX_RECORDING_BYTES) throw new Error('Recording exceeds the 1 GiB local evidence budget.');
    const free = await statfs(this.#root);
    if (Number(free.bavail) * Number(free.bsize) < this.#minimumFreeBytes + input.bytes.byteLength) throw new Error('Recording stopped because this Mac is low on free disk space.');
    segment.audioMimeType = cleanText(input.mimeType, 'Audio MIME type', 120);
    await appendFile(path.join(this.#root, draft.id, segment.audioRelativePath), input.bytes, { mode: 0o600 });
  }

  async pause(recordingId: string) {
    const draft = await this.#draft(recordingId);
    if (draft.status !== 'recording') throw new Error('Recording is not active.');
    this.#closeSegment(draft, true);
    draft.status = 'paused';
    await this.#persistDraft(draft); await this.#upsertSummary(draft);
    return this.controlSnapshot(draft);
  }

  async addEvent(recordingId: string, input: Omit<RecordingEvent, 'id' | 'segmentId' | 'elapsedMs' | 'evidenceArtifactIds'> & { screenshot?: Uint8Array; observedAtMonotonicMs?: number }) {
    const draft = await this.#draft(recordingId);
    if (draft.status !== 'recording') return undefined;
    const segment = draft.segments.at(-1);
    if (!segment || segment.endMs !== undefined) return undefined;
    const eventId = `event_${draft.events.length + 1}`;
    const evidenceArtifactIds: string[] = [];
    if (input.screenshot?.byteLength) {
      const artifactId = `screenshot_${draft.artifacts.length + 1}`;
      const relativePath = `screenshots/${eventId}.png`;
      const destination = path.join(this.#root, draft.id, relativePath);
      await writeFile(destination, input.screenshot, { mode: 0o600 });
      draft.artifacts.push({ id: artifactId, relativePath, sha256: await sha256(destination), byteLength: input.screenshot.byteLength, mimeType: 'image/png', storage: 'local-file' });
      evidenceArtifactIds.push(artifactId);
    }
    // The action occurs before screenshot encoding and disk I/O. Keep its
    // arrival timestamp instead of silently shifting it to the end of capture.
    const observed = input.observedAtMonotonicMs;
    const origin = this.#activeOrigins.get(recordingId);
    const elapsedMs = origin !== undefined && Number.isFinite(observed)
      ? Math.max(segment.startMs, Math.min(this.#elapsed(draft), Math.round(observed! - origin)))
      : this.#elapsed(draft);
    const event: RecordingEvent = {
      ...input, id: eventId, segmentId: segment.id, elapsedMs, evidenceArtifactIds,
    };
    delete (event as RecordingEvent & { screenshot?: Uint8Array }).screenshot;
    delete (event as RecordingEvent & { observedAtMonotonicMs?: number }).observedAtMonotonicMs;
    draft.events.push(event);
    await this.#persistDraft(draft); await this.#upsertSummary(draft);
    return structuredClone(event);
  }

  async warning(recordingId: string, message: string) {
    const draft = await this.#draft(recordingId);
    const value = cleanText(message, 'Completeness warning', 500);
    if (!draft.completenessWarnings.includes(value)) draft.completenessWarnings.push(value);
    await this.#persistDraft(draft); await this.#upsertSummary(draft);
  }

  async stop(recordingId: string) {
    const draft = await this.#draft(recordingId);
    if (draft.status === 'recording') this.#closeSegment(draft, false);
    if (!['recording', 'paused', 'preparing'].includes(draft.status)) throw new Error('Recording is already finalized.');
    return this.#finalize(draft, 'ready');
  }

  async interrupt(recordingId: string, reason: string) {
    const draft = await this.#draft(recordingId);
    if (draft.status === 'recording') this.#closeSegment(draft, false);
    const message = cleanText(reason, 'Interruption reason', 500);
    if (!draft.completenessWarnings.includes(message)) draft.completenessWarnings.push(message);
    return this.#finalize(draft, 'interrupted');
  }

  async cancel(recordingId: string) {
    const draft = await this.#draft(recordingId);
    await rm(path.join(this.#root, draft.id), { recursive: true, force: true });
    this.#drafts.delete(draft.id); this.#activeOrigins.delete(draft.id);
    this.#index.recordings = this.#index.recordings.filter((item) => item.id !== draft.id);
    await this.#persistIndex();
  }

  list(projectId: string) {
    cleanId(projectId, 'projectId');
    return structuredClone(this.#index.recordings.filter((item) => item.projectId === projectId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  }

  listByRecording(recordingId: string) {
    this.#validRecordingId(recordingId);
    const summary = this.#index.recordings.find((item) => item.id === recordingId);
    if (!summary) throw new Error('Recording was not found.');
    return structuredClone(summary);
  }

  async startUrl(recordingId: string) {
    this.#validRecordingId(recordingId);
    return (await this.#readDraft(recordingId)).startUrl;
  }

  async get(projectId: string, recordingId: string): Promise<LocalRecordingReview> {
    cleanId(projectId, 'projectId'); this.#validRecordingId(recordingId);
    const summary = this.#index.recordings.find((item) => item.id === recordingId && item.projectId === projectId);
    if (!summary || !['ready', 'interrupted', 'failed'].includes(summary.status)) throw new Error('Saved recording was not found.');
    const manifest = validateRecordingManifest(JSON.parse(await readFile(path.join(this.#root, recordingId, 'manifest.json'), 'utf8')));
    const transcript = await this.#readOptionalJson<LocalTranscript>(path.join(this.#root, recordingId, 'transcript.json'));
    const intent = await this.#readOptionalJson<RecordingIntentReview>(path.join(this.#root, recordingId, 'intent.json'));
    const generationDraft = await this.#readOptionalJson<PlaywrightGenerationDraft>(path.join(this.#root, recordingId, 'generation-draft.json'));
    const draft = await this.#readDraft(recordingId);
    return structuredClone({ ...summary, startUrl: draft.startUrl, manifest, ...(transcript ? { transcript } : {}), ...(intent ? { intent } : {}), ...(generationDraft ? { generationDraft } : {}) });
  }

  async readAsset(recordingId: string, artifactId: string) {
    this.#validRecordingId(recordingId); cleanId(artifactId, 'artifactId');
    const review = await this.#reviewByRecording(recordingId);
    const artifact = review.manifest.artifacts.find((item) => item.id === artifactId);
    if (!artifact || artifact.storage !== 'local-file') throw new Error('Recording asset was not found.');
    const bytes = await readFile(path.join(this.#root, recordingId, artifact.relativePath));
    if (bytes.byteLength > MAX_RECORDING_BYTES) throw new Error('Recording asset exceeds the read budget.');
    return { artifactId, mimeType: artifact.mimeType, bytes: new Uint8Array(bytes) };
  }

  async setShareState(recordingId: string, state: LocalRecordingSummary['shareState']) {
    this.#validRecordingId(recordingId);
    if (!['local', 'uploading', 'shared', 'failed'].includes(state)) throw new Error('Share state is invalid.');
    const summary = this.#index.recordings.find((item) => item.id === recordingId);
    if (!summary) throw new Error('Recording was not found.');
    summary.shareState = state; await this.#persistIndex(); return structuredClone(summary);
  }

  async assetPath(recordingId: string, artifactId: string) {
    this.#validRecordingId(recordingId); cleanId(artifactId, 'artifactId');
    const review = await this.#reviewByRecording(recordingId);
    const artifact = review.manifest.artifacts.find((item) => item.id === artifactId);
    if (!artifact || artifact.storage !== 'local-file') throw new Error('Recording asset was not found.');
    const resolved = path.resolve(this.#root, recordingId, artifact.relativePath);
    const recordingRoot = `${path.resolve(this.#root, recordingId)}${path.sep}`;
    if (!resolved.startsWith(recordingRoot)) throw new Error('Recording asset path is unsafe.');
    await access(resolved); return resolved;
  }

  async writeTranscript(recordingId: string, transcript: LocalTranscript) {
    this.#validRecordingId(recordingId);
    if (transcript.schemaVersion !== 1 || transcript.recordingId !== recordingId || !['running', 'ready', 'failed', 'canceled'].includes(transcript.status) || !Array.isArray(transcript.segments)) throw new Error('Transcript is invalid.');
    const review = await this.#reviewByRecording(recordingId);
    const recordingSegments = new Map(review.manifest.segments.map((item) => [item.id, item]));
    let previousEnd = -1;
    for (const segment of transcript.segments) {
      const recordingSegment = recordingSegments.get(segment.recordingSegmentId);
      if (!recordingSegment || !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs) || segment.startMs < recordingSegment.startMs || segment.endMs > recordingSegment.endMs + Math.max(250, segment.timingUncertaintyMs) || segment.endMs <= segment.startMs || segment.startMs < previousEnd) throw new Error('Transcript timing is outside the recording segment bounds.');
      if (!segment.originalText.trim() || !segment.text.trim() || segment.originalText.length > 10_000 || segment.text.length > 10_000) throw new Error('Transcript text is invalid.');
      previousEnd = segment.endMs;
    }
    await this.#atomicWrite(path.join(this.#root, recordingId, 'transcript.json'), JSON.stringify(transcript, null, 2));
    return structuredClone(transcript);
  }

  async saveTranscriptEdits(recordingId: string, edits: readonly { segmentId: string; text: string }[]) {
    this.#validRecordingId(recordingId);
    const transcriptPath = path.join(this.#root, recordingId, 'transcript.json');
    const transcript = await this.#readOptionalJson<LocalTranscript>(transcriptPath);
    if (!transcript || transcript.status !== 'ready') throw new Error('A ready transcript is required before editing.');
    if (!Array.isArray(edits) || edits.length > transcript.segments.length) throw new Error('Transcript edits are invalid.');
    const editMap = new Map(edits.map((edit) => [cleanId(edit.segmentId, 'segmentId'), cleanText(edit.text, 'Transcript text', 10_000)]));
    const now = new Date().toISOString(); let changed = false;
    const segments = transcript.segments.map((segment) => {
      const text = editMap.get(segment.id); if (text === undefined || text === segment.text) return segment;
      changed = true;
      return { ...segment, text, revisions: [...segment.revisions, { id: `revision_${randomUUID()}`, text, editedAt: now, source: 'user' as const }] };
    });
    if (editMap.size && !changed) return this.#reviewByRecording(recordingId);
    await this.writeTranscript(recordingId, { ...transcript, segments });
    const intent = await this.#readOptionalJson<RecordingIntentReview>(path.join(this.#root, recordingId, 'intent.json'));
    if (changed && intent?.readiness === 'ready') await this.saveIntent(recordingId, {
      readiness: 'draft', items: intent.items,
      unresolvedQuestions: [...new Set([...intent.unresolvedQuestions, 'The transcript changed after intent approval. Reconfirm the intent before generation.'])],
    });
    return this.#reviewByRecording(recordingId);
  }

  async saveIntent(recordingId: string, input: Pick<RecordingIntentReview, 'readiness' | 'items' | 'unresolvedQuestions'>) {
    this.#validRecordingId(recordingId);
    const review = await this.#reviewByRecording(recordingId);
    if (!review.transcript || review.transcript.status !== 'ready') throw new Error('Review a ready transcript before preparing intent.');
    if (!['draft', 'ready'].includes(input.readiness) || !Array.isArray(input.items) || !Array.isArray(input.unresolvedQuestions) || input.items.length > 500 || input.unresolvedQuestions.length > 100) throw new Error('Intent review is invalid.');
    const transcriptIds = new Set(review.transcript.segments.map((item) => item.id));
    const eventIds = new Set(review.manifest.events.map((item) => item.id));
    const ids = new Set<string>();
    const items: RecordingIntentItem[] = (input.items as readonly RecordingIntentItem[]).map((item) => {
      const id = cleanId(item.id, 'Intent item id');
      if (ids.has(id) || !['exact-choice', 'allowed-variation', 'relational-assertion', 'correction', 'expectation'].includes(item.kind)) throw new Error('Intent item is invalid.');
      ids.add(id);
      const statement = cleanText(item.statement, 'Intent statement', 2_000);
      const transcriptSegmentIds: string[] = [...new Set<string>((Array.isArray(item.transcriptSegmentIds) ? item.transcriptSegmentIds : []).map((value: unknown) => cleanId(value, 'Transcript segment id')))];
      const evidenceEventIds: string[] = [...new Set<string>((Array.isArray(item.evidenceEventIds) ? item.evidenceEventIds : []).map((value: unknown) => cleanId(value, 'Evidence event id')))];
      if (!transcriptSegmentIds.every((value) => transcriptIds.has(value)) || !evidenceEventIds.every((value) => eventIds.has(value))) throw new Error('Intent evidence link is invalid.');
      return { id, kind: item.kind, statement, transcriptSegmentIds, evidenceEventIds };
    });
    const unresolvedQuestions = input.unresolvedQuestions.map((value) => cleanText(value, 'Unresolved question', 2_000));
    if (input.readiness === 'ready' && (!items.length || unresolvedQuestions.length)) throw new Error('Resolve every open question and add at least one intent item before marking intent ready.');
    const intent: RecordingIntentReview = { schemaVersion: 1, recordingId, readiness: input.readiness, items, unresolvedQuestions, updatedAt: new Date().toISOString() };
    await this.#atomicWrite(path.join(this.#root, recordingId, 'intent.json'), JSON.stringify(intent, null, 2));
    return structuredClone(intent);
  }

  async writeGenerationDraft(recordingId: string, draft: PlaywrightGenerationDraft) {
    this.#validRecordingId(recordingId);
    const review = await this.#reviewByRecording(recordingId);
    if (draft.schemaVersion !== 1 || draft.recordingId !== recordingId || draft.organizationId !== review.manifest.organizationId || draft.projectId !== review.projectId || !['generating', 'draft', 'stale', 'failed', 'canceled'].includes(draft.state)) throw new Error('Playwright generation draft is invalid.');
    if (!/^[a-f0-9]{64}$/.test(draft.provenance.inputRevisionHash) || draft.provenance.recordingId !== recordingId || typeof draft.provenance.executionValidated !== 'boolean' || draft.provenance.published !== false || (draft.provenance.executionValidated && (draft.validation?.status !== 'passed' || draft.validation.passed < 1))) throw new Error('Playwright generation provenance is invalid.');
    if (draft.validationHistory && (draft.validationHistory.length > 3 || draft.validationHistory.some((item) => !/^[a-f0-9]{64}$/.test(item.candidateSha256) || !['passed', 'failed', 'skipped', 'blocked', 'canceled', 'infrastructure-error'].includes(item.status) || item.detail.length > 14_000))) throw new Error('Playwright validation history is invalid.');
    if (draft.files.some((file) => !isSafeRelativePath(file.relativePath) || file.byteLength !== Buffer.byteLength(file.text, 'utf8') || createHash('sha256').update(file.text).digest('hex') !== file.sha256)) throw new Error('Playwright generation file integrity is invalid.');
    await this.#atomicWrite(path.join(this.#root, recordingId, 'generation-draft.json'), JSON.stringify(draft, null, 2));
    return structuredClone(draft);
  }

  controlSnapshot(draft: DraftRecording) {
    return { recording: this.#summary(draft), activeSegmentId: draft.status === 'recording' ? draft.segments.at(-1)?.id : undefined };
  }

  async #finalize(draft: DraftRecording, status: 'ready' | 'interrupted' | 'failed'): Promise<LocalRecordingReview> {
    if (draft.segments.length === 0) {
      draft.segments.push({ id: 'segment_1', startMs: 0, endMs: Math.max(1, draft.lastElapsedMs), pausedAfter: false, audioRelativePath: 'audio/segment_1.webm' });
      draft.completenessWarnings.push('No microphone segment was started.');
    }
    if (draft.segments.at(-1)?.endMs === undefined) this.#closeSegment(draft, false);
    const recordingDirectory = path.join(this.#root, draft.id);
    const audioArtifacts: ArtifactRef[] = [];
    const segments: RecordingSegment[] = [];
    for (const segment of draft.segments) {
      const audioPath = path.join(recordingDirectory, segment.audioRelativePath);
      let audioArtifactId: string | undefined;
      try {
        const file = await stat(audioPath);
        if (file.size > 0) {
          audioArtifactId = `audio_${segment.id}`;
          audioArtifacts.push({ id: audioArtifactId, relativePath: segment.audioRelativePath, sha256: await sha256(audioPath), byteLength: file.size, mimeType: segment.audioMimeType ?? 'audio/webm', storage: 'local-file' });
        } else draft.completenessWarnings.push(`Microphone ${segment.id} contained no audio bytes.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        draft.completenessWarnings.push(`Microphone audio is missing for ${segment.id}.`);
      }
      segments.push({ id: segment.id, startMs: segment.startMs, endMs: Math.max(segment.startMs + 1, segment.endMs ?? draft.lastElapsedMs), pausedAfter: Boolean(segment.pausedAfter), ...(audioArtifactId ? { audioArtifactId } : {}) });
    }
    draft.status = status; draft.finishedAt = new Date().toISOString();
    const manifest: RecordingManifest = {
      schemaVersion: CONTRACT_SCHEMA_VERSION, kind: 'recording', id: draft.id,
      organizationId: draft.organizationId, projectId: draft.projectId,
      createdByUid: draft.createdByUid, createdAt: draft.startedAt, targetType: 'web',
      environmentSnapshotId: `environment_${createHash('sha256').update(draft.startUrl).digest('hex').slice(0, 16)}`,
      captureAdapter: { name: 'sayspec-playwright-chromium', version: '1.0.0' },
      sessionId: draft.id.replace('recording_', 'session_'), timebase: 'monotonic-ms',
      segments, events: draft.events, artifacts: [...draft.artifacts, ...audioArtifacts],
      completenessWarnings: [...new Set(draft.completenessWarnings)],
    };
    validateRecordingManifest(manifest);
    await this.#atomicWrite(path.join(recordingDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await this.#persistDraft(draft); await this.#upsertSummary(draft);
    this.#activeOrigins.delete(draft.id);
    return { ...this.#summary(draft), startUrl: draft.startUrl, manifest };
  }

  #closeSegment(draft: DraftRecording, pausedAfter: boolean) {
    const segment = draft.segments.at(-1);
    if (!segment || segment.endMs !== undefined) return;
    segment.endMs = Math.max(segment.startMs + 1, this.#elapsed(draft));
    segment.pausedAfter = pausedAfter;
  }

  #elapsed(draft: DraftRecording) {
    const origin = this.#activeOrigins.get(draft.id);
    const next = origin === undefined ? draft.lastElapsedMs : Math.max(draft.lastElapsedMs, Math.round(this.#clock.now() - origin));
    draft.lastElapsedMs = next;
    return next;
  }

  #summary(draft: DraftRecording): LocalRecordingSummary {
    return {
      id: draft.id, projectId: draft.projectId, title: draft.title, status: draft.status,
      startedAt: draft.startedAt, ...(draft.finishedAt ? { finishedAt: draft.finishedAt } : {}),
      durationMs: draft.lastElapsedMs, eventCount: draft.events.length,
      completenessWarnings: [...new Set(draft.completenessWarnings)], sharingChoice: draft.sharingChoice,
      shareState: draft.shareState,
    };
  }

  async #upsertSummary(draft: DraftRecording) {
    const summary = this.#summary(draft);
    const index = this.#index.recordings.findIndex((item) => item.id === draft.id);
    if (index >= 0) this.#index.recordings[index] = summary; else this.#index.recordings.push(summary);
    await this.#persistIndex();
  }

  async #draft(recordingId: string) {
    this.#validRecordingId(recordingId);
    const existing = this.#drafts.get(recordingId);
    if (existing) return existing;
    const draft = await this.#readDraft(recordingId); this.#drafts.set(recordingId, draft); return draft;
  }

  async #readDraft(recordingId: string) {
    this.#validRecordingId(recordingId);
    const draft = JSON.parse(await readFile(path.join(this.#root, recordingId, 'draft.json'), 'utf8')) as DraftRecording;
    if (draft.schemaVersion !== 1 || draft.id !== recordingId || !Array.isArray(draft.segments) || !Array.isArray(draft.events)) throw new Error('Recording draft is invalid.');
    return draft;
  }

  async #reviewByRecording(recordingId: string) {
    const summary = this.#index.recordings.find((item) => item.id === recordingId);
    if (!summary) throw new Error('Recording was not found.');
    return this.get(summary.projectId, recordingId);
  }

  async #readOptionalJson<T>(filePath: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(filePath, 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  async #recordingBytes(recordingId: string) {
    let total = 0;
    for (const directory of ['audio', 'screenshots']) {
      const root = path.join(this.#root, recordingId, directory);
      for (const name of await readdir(root)) total += (await stat(path.join(root, name))).size;
    }
    return total;
  }

  #validRecordingId(value: string) { if (!RECORDING_ID.test(value)) throw new Error('recordingId is invalid.'); }
  async #persistDraft(draft: DraftRecording) { await this.#atomicWrite(path.join(this.#root, draft.id, 'draft.json'), JSON.stringify(draft, null, 2)); }
  async #persistIndex() { await this.#atomicWrite(this.#indexPath, JSON.stringify(this.#index, null, 2)); }
  async #atomicWrite(destination: string, body: string) {
    this.#write = this.#write.then(async () => {
      const temporary = `${destination}.${process.pid}.tmp`;
      await writeFile(temporary, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, destination);
    });
    await this.#write;
  }
}
