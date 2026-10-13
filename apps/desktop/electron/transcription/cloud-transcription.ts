import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { CLOUD_TRANSCRIPTION_MAX_MS, type CloudTranscriptionScope, type LocalTranscript, type LocalTranscriptSegment, type LocalTranscriptionLifecycleEvent, type RecordingSegment } from '@sayspec/contracts';
import type { RecordingStore } from '../recording-store.ts';
import { normalizeWhisperTimeline, runAudioTool, silentAudio } from './local-transcription.ts';
import type { LocalModelManager } from './model-manager.ts';
import type { CaptureTranscriptionInput, TranscriptionProvider, TranscriptionStartOptions } from './provider.ts';

export interface CloudTranscriptionManagerOptions {
  rootDirectory: string;
  store: RecordingStore;
  models: LocalModelManager;
  cloudFunctionsUrl?: string;
  onLifecycle?(event: LocalTranscriptionLifecycleEvent): void;
  fetchImpl?: typeof fetch;
}

type CloudTranscriptResult = {
  model: string; language?: string; durationMs: number;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
  allowance: { usedMinutes: number; limitMinutes: number };
};
type Job = { controller: AbortController; process?: ChildProcess; promise: Promise<LocalTranscript>; uploaded?: boolean };

// Gemini reports timestamps to about a second, coarser than whisper.cpp.
const CLOUD_TIMING_UNCERTAINTY_MS = 1_000;

/**
 * The `gemini-cloud` provider (Beta and Pro workspaces): each narration is
 * encoded on this Mac as 16 kbit/s mono Ogg/Opus and sent to the backend's
 * `narrationTranscribe` callable, which checks membership, plan and the
 * workspace's monthly allowance before Gemini transcribes it. The backend does
 * not keep the audio. Silent narration is never uploaded.
 */
export class CloudTranscriptionManager implements TranscriptionProvider {
  readonly id = 'gemini-cloud';
  readonly #root: string;
  readonly #store: RecordingStore;
  readonly #models: LocalModelManager;
  readonly #functionsUrl: string;
  readonly #fetch: typeof fetch;
  readonly #onLifecycle: NonNullable<CloudTranscriptionManagerOptions['onLifecycle']>;
  readonly #jobs = new Map<string, Job>();

  constructor(options: CloudTranscriptionManagerOptions) {
    this.#root = path.resolve(options.rootDirectory); this.#store = options.store; this.#models = options.models;
    this.#functionsUrl = options.cloudFunctionsUrl ?? ''; this.#fetch = options.fetchImpl ?? fetch;
    this.#onLifecycle = options.onLifecycle ?? (() => undefined);
  }

  async initialize() { await mkdir(this.#root, { recursive: true }); }

  async start(recordingId: string, options?: TranscriptionStartOptions) {
    const scope = this.#scope(options);
    return this.#startJob(recordingId, (job) => this.#transcribe(recordingId, scope, job));
  }

  async startFlutter(input: CaptureTranscriptionInput, options?: TranscriptionStartOptions) {
    const scope = this.#scope(options);
    return this.#startJob(input.captureId, (job) => this.#transcribeFlutter(input, scope, job));
  }

  running(recordingId: string) { return this.#jobs.has(recordingId); }

  async cancel(recordingId: string) {
    const job = this.#jobs.get(recordingId);
    if (job) { job.controller.abort(); job.process?.kill('SIGTERM'); return job.promise; }
    const review = await this.#store.get((await this.#store.listByRecording(recordingId)).projectId, recordingId);
    if (!review.transcript) throw new Error('No transcription is available.');
    return review.transcript;
  }

  async shutdown() {
    for (const job of this.#jobs.values()) { job.controller.abort(); job.process?.kill('SIGTERM'); }
    await Promise.allSettled([...this.#jobs.values()].map((item) => item.promise));
  }

  #scope(options?: TranscriptionStartOptions) {
    if (!this.#functionsUrl) throw new Error('This build has no cloud backend for Gemini transcription.');
    const scope = options?.cloud;
    if (!scope || typeof scope.idToken !== 'string' || !scope.idToken || scope.idToken.length > 16_384) throw new Error('Sign in again before using Gemini transcription.');
    if (typeof scope.organizationId !== 'string' || !scope.organizationId || typeof scope.projectId !== 'string' || !scope.projectId) throw new Error('Choose a cloud workspace project before using Gemini transcription.');
    return { idToken: scope.idToken, organizationId: scope.organizationId, projectId: scope.projectId };
  }

  #startJob(id: string, run: (job: Job) => Promise<LocalTranscript>) {
    const existing = this.#jobs.get(id); if (existing) return existing.promise;
    const job: Job = { controller: new AbortController(), promise: Promise.resolve(null as unknown as LocalTranscript) };
    job.promise = run(job).finally(() => this.#jobs.delete(id));
    this.#jobs.set(id, job); return job.promise;
  }

  async #transcribe(recordingId: string, scope: CloudTranscriptionScope, job: Job) {
    const summary = await this.#store.listByRecording(recordingId);
    const review = await this.#store.get(summary.projectId, recordingId);
    const audioSegments = review.manifest.segments.filter((segment) => segment.audioArtifactId);
    const base = this.#base(recordingId);
    await this.#store.writeTranscript(recordingId, base);
    this.#emit(recordingId, 'running', 0, 'Preparing narration for Gemini transcription…');
    const temporary = await mkdtemp(path.join(this.#root, `${recordingId}-`));
    const segments: LocalTranscriptSegment[] = []; const languages: string[] = []; const warnings: string[] = [];
    let model = ''; let allowance: CloudTranscriptResult['allowance'] | undefined;
    try {
      const longest = audioSegments.find((segment) => segment.endMs - segment.startMs > CLOUD_TRANSCRIPTION_MAX_MS);
      if (longest) throw new Error('A narration segment is longer than 25 minutes, the most Gemini transcription accepts at a time. Choose local Whisper transcription for this recording.');
      const converter = await this.#models.requireConverter();
      for (const [index, recordingSegment] of audioSegments.entries()) {
        if (job.controller.signal.aborted) throw new DOMException('Canceled', 'AbortError');
        const label = `segment ${index + 1} of ${audioSegments.length}`;
        this.#emit(recordingId, 'running', index / Math.max(1, audioSegments.length), `Preparing ${label} for Gemini transcription…`);
        const ogg = await this.#encode(converter, await this.#store.assetPath(recordingId, recordingSegment.audioArtifactId!), path.join(temporary, `${recordingSegment.id}.ogg`), job);
        if (!ogg) { warnings.push(`No speech signal was detected in ${recordingSegment.id}; it was not uploaded.`); continue; }
        this.#emit(recordingId, 'running', (index + 0.2) / Math.max(1, audioSegments.length), `Transcribing ${label} with Gemini in SaySpec Cloud…`);
        const result = await this.#call(scope, ogg, job);
        const events = review.manifest.events.filter((event) => event.segmentId === recordingSegment.id).map((event) => ({ id: event.id, elapsedMs: event.elapsedMs }));
        const normalized = this.#align(result, recordingSegment, events, CLOUD_TIMING_UNCERTAINTY_MS);
        model = result.model; allowance = result.allowance;
        if (normalized.language) languages.push(normalized.language); segments.push(...normalized.segments);
      }
      if (!segments.length) warnings.push(audioSegments.length ? 'No speech was detected in the saved narration.' : 'No saved microphone audio was available to transcribe.');
      const uniqueLanguages = [...new Set(languages)];
      const transcript: LocalTranscript = {
        ...base, provider: { ...base.provider, ...(model ? { model } : {}) } as LocalTranscript['provider'], status: 'ready',
        ...(uniqueLanguages.length ? { language: uniqueLanguages.length === 1 ? uniqueLanguages[0] : 'mixed' } : {}),
        segments, finishedAt: new Date().toISOString(), warnings,
      };
      await this.#store.writeTranscript(recordingId, transcript);
      this.#emit(recordingId, 'ready', 1, this.#readyMessage(segments.length > 0, allowance));
      return transcript;
    } catch (error) {
      const transcript = this.#failed(base, segments, warnings, job, error);
      await this.#store.writeTranscript(recordingId, transcript);
      this.#emit(recordingId, transcript.status, 0, transcript.error!);
      return transcript;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async #transcribeFlutter(input: CaptureTranscriptionInput, scope: CloudTranscriptionScope, job: Job) {
    const base = this.#base(input.captureId);
    await input.persist(base);
    this.#emit(input.captureId, 'running', 0, 'Preparing Flutter narration for Gemini transcription…');
    const temporary = await mkdtemp(path.join(this.#root, `${input.captureId}-`));
    try {
      if (input.durationMs > CLOUD_TRANSCRIPTION_MAX_MS) throw new Error('This narration is longer than 25 minutes, the most Gemini transcription accepts at a time. Choose local Whisper transcription for it.');
      const ogg = await this.#encode(await this.#models.requireConverter(), input.audioPath, path.join(temporary, 'narration.ogg'), job);
      const warnings: string[] = [];
      let segments: LocalTranscriptSegment[] = []; let language: string | undefined; let result: CloudTranscriptResult | undefined;
      if (!ogg) warnings.push('No speech signal was detected in the Flutter narration; it was not uploaded.');
      else {
        this.#emit(input.captureId, 'running', 0.2, 'Transcribing Flutter narration with Gemini in SaySpec Cloud…');
        result = await this.#call(scope, ogg, job);
        const narration: RecordingSegment = { id: 'narration_1', startMs: 0, endMs: Math.max(1, input.durationMs), pausedAfter: false, audioArtifactId: 'narration_audio' };
        ({ language, segments } = this.#align(result, narration, input.events, Math.max(CLOUD_TIMING_UNCERTAINTY_MS, Math.round(input.timingUncertaintyMs))));
        if (!segments.length) warnings.push('No speech was detected in the saved Flutter narration.');
      }
      const transcript: LocalTranscript = {
        ...base, provider: { ...base.provider, ...(result ? { model: result.model } : {}) } as LocalTranscript['provider'], status: 'ready',
        ...(language ? { language } : {}), segments, finishedAt: new Date().toISOString(), warnings,
      };
      await input.persist(transcript);
      this.#emit(input.captureId, 'ready', 1, this.#readyMessage(segments.length > 0, result?.allowance));
      return transcript;
    } catch (error) {
      const transcript = this.#failed(base, [], [], job, error);
      await input.persist(transcript);
      this.#emit(input.captureId, transcript.status, 0, transcript.error!);
      return transcript;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  /** Encodes narration as the backend expects; undefined when it is digital silence. */
  async #encode(converter: string, source: string, output: string, job: Job) {
    await runAudioTool(converter, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '16k', '-application', 'voip', output], job);
    if (silentAudio(await runAudioTool(converter, ['-hide_banner', '-i', output, '-af', 'volumedetect', '-f', 'null', '-'], job))) return undefined;
    return readFile(output);
  }

  async #call(scope: CloudTranscriptionScope, audio: Buffer, job: Job): Promise<CloudTranscriptResult> {
    job.uploaded = true;
    const response = await this.#fetch(`${this.#functionsUrl}/narrationTranscribe`, {
      method: 'POST', headers: { Authorization: `Bearer ${scope.idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { organizationId: scope.organizationId, projectId: scope.projectId, mimeType: 'audio/ogg', audio: audio.toString('base64') } }),
      signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(600_000)]),
    });
    const body = await response.json().catch(() => null) as { result?: CloudTranscriptResult; error?: { message?: string } } | null;
    if (!response.ok || !body?.result || !Array.isArray(body.result.segments)) throw new Error(body?.error?.message ?? `SaySpec Cloud returned HTTP ${response.status}.`);
    return body.result;
  }

  #align(result: CloudTranscriptResult, segment: RecordingSegment, events: readonly { id: string; elapsedMs: number }[], uncertaintyMs: number) {
    const timeline = { result: { language: result.language }, transcription: result.segments.map((item) => ({ offsets: { from: item.startMs, to: item.endMs }, text: item.text })) };
    return normalizeWhisperTimeline(timeline, segment, events, { uncertaintyMs, source: 'gemini' });
  }

  #base(recordingId: string): LocalTranscript {
    return { schemaVersion: 1, recordingId, status: 'running', provider: { kind: 'cloud', service: 'gemini', model: 'unknown', translated: false }, segments: [], startedAt: new Date().toISOString(), warnings: [] };
  }

  #failed(base: LocalTranscript, segments: LocalTranscriptSegment[], warnings: string[], job: Job, error: unknown): LocalTranscript {
    const canceled = job.controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    return {
      ...base, status: canceled ? 'canceled' : 'failed', segments, finishedAt: new Date().toISOString(), warnings,
      error: canceled
        ? `Gemini transcription canceled. The original audio is unchanged.${job.uploaded ? ' Narration already sent still counts toward this month\'s allowance.' : ''}`
        : `Gemini transcription failed. The original audio is unchanged. ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  #readyMessage(speech: boolean, allowance: CloudTranscriptResult['allowance'] | undefined) {
    const usage = allowance ? ` ${allowance.usedMinutes} of ${allowance.limitMinutes} workspace minutes used this month.` : '';
    return `${speech ? 'Gemini transcript is ready.' : 'Gemini transcription finished; no speech was detected.'}${usage}`;
  }

  #emit(recordingId: string, state: LocalTranscript['status'], progress: number, message: string) {
    this.#onLifecycle({ kind: 'transcription', state, progress: Math.max(0, Math.min(1, progress)), message, recordingId });
  }
}
