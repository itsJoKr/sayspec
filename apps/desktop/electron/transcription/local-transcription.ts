import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { LocalTranscript, LocalTranscriptSegment, LocalTranscriptionLifecycleEvent, RecordingEvent, RecordingSegment, TranscriptRevision } from '@sayspec/contracts';
import { RecordingStore } from '../recording-store.ts';
import { LocalModelManager } from './model-manager.ts';
import type { CaptureTranscriptionInput, TranscriptionProvider } from './provider.ts';

export type WhisperJson = {
  result?: { language?: unknown };
  transcription?: Array<{ offsets?: { from?: unknown; to?: unknown }; text?: unknown }>;
};

export interface LocalTranscriptionManagerOptions {
  rootDirectory: string;
  store: RecordingStore;
  models: LocalModelManager;
  onLifecycle?(event: LocalTranscriptionLifecycleEvent): void;
}

function cleanWhisperText(value: unknown) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return /^\[(?:blank_audio|silence)\]$/i.test(text) ? '' : text;
}

export function normalizeWhisperSegments(input: WhisperJson, recordingSegment: RecordingSegment, events: readonly RecordingEvent[]) {
  return normalizeWhisperTimeline(input, recordingSegment, events.filter((event) => event.segmentId === recordingSegment.id).map((event) => ({ id: event.id, elapsedMs: event.elapsedMs })));
}

/** Also aligns cloud transcripts, which pass their own timing uncertainty and revision source. */
export function normalizeWhisperTimeline(input: WhisperJson, recordingSegment: RecordingSegment, events: readonly { id: string; elapsedMs: number }[], options: { uncertaintyMs?: number; source?: TranscriptRevision['source'] } = {}) {
  const raw = Array.isArray(input.transcription) ? input.transcription : [];
  const captureDuration = recordingSegment.endMs - recordingSegment.startMs;
  // The final spoken word may precede a long stretch of silence. That gap is
  // not clock uncertainty and must not be presented to the coding agent as one.
  const uncertainty = options.uncertaintyMs ?? 100;
  const source = options.source ?? 'whisper';
  const output: LocalTranscriptSegment[] = [];
  for (const item of raw) {
    const text = cleanWhisperText(item.text); if (!text) continue;
    const localStart = Math.max(0, Math.min(captureDuration - 1, Math.round(Number(item.offsets?.from) || 0)));
    const localEnd = Math.max(localStart + 1, Math.min(captureDuration, Math.round(Number(item.offsets?.to) || localStart + 1)));
    const startMs = recordingSegment.startMs + localStart; const endMs = recordingSegment.startMs + localEnd;
    const segmentEvents = events;
    let evidenceEventIds = segmentEvents.filter((event) => event.elapsedMs >= startMs && event.elapsedMs <= endMs).map((event) => event.id);
    if (!evidenceEventIds.length && segmentEvents.length) {
      evidenceEventIds = [segmentEvents.reduce((nearest, event) => Math.abs(event.elapsedMs - startMs) < Math.abs(nearest.elapsedMs - startMs) ? event : nearest).id];
    }
    const now = new Date().toISOString();
    output.push({
      id: `transcript_segment_${randomUUID()}`, recordingSegmentId: recordingSegment.id,
      startMs, endMs, timingUncertaintyMs: uncertainty, originalText: text, text,
      revisions: [{ id: `revision_${randomUUID()}`, text, editedAt: now, source }], evidenceEventIds,
    });
  }
  return { language: typeof input.result?.language === 'string' ? input.result.language : undefined, segments: output };
}

/** The built-in `whisper-local` transcription provider: whisper.cpp on this Mac, so narration never leaves it. */
export class LocalTranscriptionManager implements TranscriptionProvider {
  readonly id = 'whisper-local';
  readonly #root: string;
  readonly #store: RecordingStore;
  readonly #models: LocalModelManager;
  readonly #onLifecycle: NonNullable<LocalTranscriptionManagerOptions['onLifecycle']>;
  readonly #jobs = new Map<string, { controller: AbortController; process?: ChildProcess; promise: Promise<LocalTranscript> }>();

  constructor(options: LocalTranscriptionManagerOptions) {
    this.#root = path.resolve(options.rootDirectory); this.#store = options.store; this.#models = options.models;
    this.#onLifecycle = options.onLifecycle ?? (() => undefined);
  }

  async initialize() { await mkdir(this.#root, { recursive: true }); }

  async start(recordingId: string) {
    const existing = this.#jobs.get(recordingId); if (existing) return existing.promise;
    const controller = new AbortController();
    const holder: { controller: AbortController; process?: ChildProcess; promise: Promise<LocalTranscript> } = { controller, promise: Promise.resolve(null as unknown as LocalTranscript) };
    holder.promise = this.#transcribe(recordingId, holder).finally(() => this.#jobs.delete(recordingId));
    this.#jobs.set(recordingId, holder); return holder.promise;
  }

  /** Runs the existing local Whisper runtime for capture-owned Flutter audio. */
  async startFlutter(input: CaptureTranscriptionInput) {
    const existing = this.#jobs.get(input.captureId); if (existing) return existing.promise;
    const controller = new AbortController();
    const holder: { controller: AbortController; process?: ChildProcess; promise: Promise<LocalTranscript> } = { controller, promise: Promise.resolve(null as unknown as LocalTranscript) };
    holder.promise = this.#transcribeFlutter(input, holder).finally(() => this.#jobs.delete(input.captureId));
    this.#jobs.set(input.captureId, holder); return holder.promise;
  }

  running(recordingId: string) { return this.#jobs.has(recordingId); }

  async cancel(recordingId: string) {
    const job = this.#jobs.get(recordingId);
    if (job) { job.controller.abort(); job.process?.kill('SIGTERM'); return job.promise; }
    const review = await this.#store.get((await this.#store.listByRecording(recordingId)).projectId, recordingId);
    if (!review.transcript) throw new Error('No local transcription is available.');
    return review.transcript;
  }

  async shutdown() {
    for (const job of this.#jobs.values()) { job.controller.abort(); job.process?.kill('SIGTERM'); }
    await Promise.allSettled([...this.#jobs.values()].map((item) => item.promise));
  }

  async #transcribe(recordingId: string, job: { controller: AbortController; process?: ChildProcess }) {
    const ready = await this.#models.requireReady();
    const summary = await this.#store.listByRecording(recordingId);
    const review = await this.#store.get(summary.projectId, recordingId);
    const startedAt = new Date().toISOString();
    const base: LocalTranscript = {
      schemaVersion: 1, recordingId, status: 'running',
      provider: { kind: 'local', runtime: 'whisper.cpp', runtimeVersion: ready.setup.runtime.detectedVersion!, modelId: ready.setup.model.id, modelSha256: ready.setup.model.sha256, translated: false },
      segments: [], startedAt, warnings: [],
    };
    await this.#store.writeTranscript(recordingId, base);
    this.#emit(recordingId, 'running', 0, 'Preparing recorded audio for local transcription…');
    const temporary = await mkdtemp(path.join(this.#root, `${recordingId}-`));
    const segments: LocalTranscriptSegment[] = []; const languages: string[] = []; const warnings: string[] = [];
    try {
      const audioSegments = review.manifest.segments.filter((segment) => segment.audioArtifactId);
      for (const [index, recordingSegment] of audioSegments.entries()) {
        if (job.controller.signal.aborted) throw new DOMException('Canceled', 'AbortError');
        const source = await this.#store.assetPath(recordingId, recordingSegment.audioArtifactId!);
        const wav = path.join(temporary, `${recordingSegment.id}.wav`);
        this.#emit(recordingId, 'running', index / Math.max(1, audioSegments.length), `Decoding audio segment ${index + 1} of ${audioSegments.length} locally…`);
        await this.#run(ready.converterPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], job);
        const levelOutput = await this.#run(ready.converterPath, ['-hide_banner', '-i', wav, '-af', 'volumedetect', '-f', 'null', '-'], job);
        if (silentAudio(levelOutput)) {
          warnings.push(`No speech signal was detected in ${recordingSegment.id}; Whisper inference was skipped to avoid inventing text for silence.`);
          continue;
        }
        const outputPrefix = path.join(temporary, `${recordingSegment.id}-transcript`);
        this.#emit(recordingId, 'running', (index + 0.15) / Math.max(1, audioSegments.length), `Transcribing segment ${index + 1} of ${audioSegments.length} on this machine…`);
        const whisperArgs = ['-m', ready.modelPath, '-f', wav, '-l', 'auto', '--output-json', '--output-file', outputPrefix, '--no-prints', '--print-progress'];
        const reportProgress = (progress: number) => {
          this.#emit(recordingId, 'running', (index + 0.15 + progress * 0.8) / Math.max(1, audioSegments.length), `Transcribing segment ${index + 1} of ${audioSegments.length} on this machine…`);
        };
        try {
          await this.#run(ready.runtimePath, whisperArgs, job, reportProgress);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (job.controller.signal.aborted || !/failed to allocate (?:metal|mtl)|ggml_backend_metal|GGML_ASSERT\(buffer\) failed/i.test(detail)) throw error;
          warnings.push(`GPU memory was unavailable for ${recordingSegment.id}; local whisper.cpp retried on CPU. No provider or data destination changed.`);
          this.#emit(recordingId, 'running', (index + 0.15) / Math.max(1, audioSegments.length), `GPU memory was unavailable; retrying segment ${index + 1} locally on CPU…`);
          await this.#run(ready.runtimePath, ['--no-gpu', ...whisperArgs], job, reportProgress);
        }
        const parsed = JSON.parse(await readFile(`${outputPrefix}.json`, 'utf8')) as WhisperJson;
        const normalized = normalizeWhisperSegments(parsed, recordingSegment, review.manifest.events);
        if (normalized.language) languages.push(normalized.language); segments.push(...normalized.segments);
      }
      if (!segments.length) warnings.push(audioSegments.length ? 'No speech was detected in the saved narration.' : 'No saved microphone audio was available to transcribe.');
      const uniqueLanguages = [...new Set(languages)];
      const transcript: LocalTranscript = {
        ...base, status: 'ready', ...(uniqueLanguages.length ? { language: uniqueLanguages.length === 1 ? uniqueLanguages[0] : 'mixed' } : {}),
        segments, finishedAt: new Date().toISOString(), warnings,
      };
      await this.#store.writeTranscript(recordingId, transcript);
      this.#emit(recordingId, 'ready', 1, segments.length ? 'Local transcript is ready for review.' : 'Local transcription finished; no speech was detected.');
      return transcript;
    } catch (error) {
      const canceled = job.controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      const transcript: LocalTranscript = {
        ...base, status: canceled ? 'canceled' : 'failed', segments,
        finishedAt: new Date().toISOString(), warnings,
        error: canceled ? 'Local transcription canceled. The original audio is unchanged.' : `Local transcription failed. The original audio is unchanged. ${error instanceof Error ? error.message : String(error)}`,
      };
      await this.#store.writeTranscript(recordingId, transcript);
      this.#emit(recordingId, transcript.status, 0, transcript.error!);
      return transcript;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async #transcribeFlutter(input: {
    captureId: string; audioPath: string; durationMs: number; timingUncertaintyMs: number;
    events: readonly { id: string; elapsedMs: number }[];
    persist(transcript: LocalTranscript): Promise<unknown>;
  }, job: { controller: AbortController; process?: ChildProcess }) {
    const ready = await this.#models.requireReady();
    const startedAt = new Date().toISOString();
    const base: LocalTranscript = {
      schemaVersion: 1, recordingId: input.captureId, status: 'running',
      provider: { kind: 'local', runtime: 'whisper.cpp', runtimeVersion: ready.setup.runtime.detectedVersion!, modelId: ready.setup.model.id, modelSha256: ready.setup.model.sha256, translated: false },
      segments: [], startedAt, warnings: [],
    };
    await input.persist(base);
    this.#emit(input.captureId, 'running', 0, 'Preparing Flutter narration for local transcription…');
    const temporary = await mkdtemp(path.join(this.#root, `${input.captureId}-`));
    try {
      const wav = path.join(temporary, 'narration.wav');
      await this.#run(ready.converterPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input.audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], job);
      const levelOutput = await this.#run(ready.converterPath, ['-hide_banner', '-i', wav, '-af', 'volumedetect', '-f', 'null', '-'], job);
      const warnings: string[] = [];
      let segments: LocalTranscriptSegment[] = [];
      let language: string | undefined;
      if (silentAudio(levelOutput)) {
        warnings.push('No speech signal was detected in the Flutter narration; Whisper inference was skipped to avoid inventing text for silence.');
      } else {
        const outputPrefix = path.join(temporary, 'flutter-transcript');
        const whisperArgs = ['-m', ready.modelPath, '-f', wav, '-l', 'auto', '--output-json', '--output-file', outputPrefix, '--no-prints', '--print-progress'];
        const reportProgress = (progress: number) => this.#emit(input.captureId, 'running', 0.15 + progress * 0.8, 'Transcribing Flutter narration on this machine…');
        try { await this.#run(ready.runtimePath, whisperArgs, job, reportProgress); }
        catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (job.controller.signal.aborted || !/failed to allocate (?:metal|mtl)|ggml_backend_metal|GGML_ASSERT\(buffer\) failed/i.test(detail)) throw error;
          warnings.push('GPU memory was unavailable; local whisper.cpp retried the Flutter narration on CPU.');
          await this.#run(ready.runtimePath, ['--no-gpu', ...whisperArgs], job, reportProgress);
        }
        const parsed = JSON.parse(await readFile(`${outputPrefix}.json`, 'utf8')) as WhisperJson;
        const normalized = normalizeWhisperTimeline(parsed, { id: 'narration_1', startMs: 0, endMs: Math.max(1, input.durationMs), pausedAfter: false, audioArtifactId: 'narration_audio' }, input.events);
        language = normalized.language;
        segments = normalized.segments.map((segment) => ({ ...segment, timingUncertaintyMs: Math.max(segment.timingUncertaintyMs, Math.round(input.timingUncertaintyMs)) }));
        if (!segments.length) warnings.push('No speech was detected in the saved Flutter narration.');
      }
      const transcript: LocalTranscript = { ...base, status: 'ready', ...(language ? { language } : {}), segments, finishedAt: new Date().toISOString(), warnings };
      await input.persist(transcript);
      this.#emit(input.captureId, 'ready', 1, segments.length ? 'Flutter narration transcript is ready.' : 'Flutter transcription finished; no speech was detected.');
      return transcript;
    } catch (error) {
      const canceled = job.controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      const transcript: LocalTranscript = { ...base, status: canceled ? 'canceled' : 'failed', finishedAt: new Date().toISOString(), warnings: [], error: canceled ? 'Local transcription canceled. The original Flutter narration is unchanged.' : `Local transcription failed. The original Flutter narration is unchanged. ${error instanceof Error ? error.message : String(error)}` };
      await input.persist(transcript);
      this.#emit(input.captureId, transcript.status, 0, transcript.error!);
      return transcript;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  #run(executable: string, args: string[], job: { controller: AbortController; process?: ChildProcess }, onProgress?: (progress: number) => void) {
    return runAudioTool(executable, args, job, onProgress);
  }

  #emit(recordingId: string, state: LocalTranscript['status'], progress: number, message: string) {
    this.#onLifecycle({ kind: 'transcription', state, progress: Math.max(0, Math.min(1, progress)), message, recordingId });
  }
}

/** Runs FFmpeg or whisper.cpp for a cancelable job; resolves with the tail of its output. */
export function runAudioTool(executable: string, args: string[], job: { controller: AbortController; process?: ChildProcess }, onProgress?: (progress: number) => void) {
  return new Promise<string>((resolve, reject) => {
    if (job.controller.signal.aborted) { reject(new DOMException('Canceled', 'AbortError')); return; }
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] }); job.process = child;
    let output = ''; let settled = false;
    const capture = (chunk: Buffer) => {
      output = `${output}${String(chunk)}`.slice(-128 * 1024);
      for (const match of String(chunk).matchAll(/progress\s*=\s*(\d+)%/gi)) onProgress?.(Math.max(0, Math.min(1, Number(match[1]) / 100)));
    };
    child.stdout?.on('data', capture); child.stderr?.on('data', capture);
    const abort = () => child.kill('SIGTERM'); job.controller.signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => { if (!settled) { settled = true; reject(error); } });
    child.once('close', (code) => {
      job.controller.signal.removeEventListener('abort', abort); job.process = undefined;
      if (settled) return; settled = true;
      if (job.controller.signal.aborted) reject(new DOMException('Canceled', 'AbortError'));
      else if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(executable)} exited with code ${code ?? 'unknown'}: ${output.trim().slice(-2_000)}`));
    });
  });
}

/** Whether FFmpeg's volumedetect output shows digital silence, which speech models turn into invented text. */
export function silentAudio(volumedetectOutput: string) {
  const peak = volumedetectOutput.match(/max_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/i)?.[1];
  return peak === '-inf' || (peak !== undefined && Number(peak) <= -60);
}
