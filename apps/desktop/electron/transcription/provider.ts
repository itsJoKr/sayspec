import type { CloudTranscriptionScope, LocalTranscript, LocalTranscriptionLifecycleEvent } from '@sayspec/contracts';
import type { RecordingStore } from '../recording-store.ts';
import { CloudTranscriptionManager } from './cloud-transcription.ts';
import { LocalTranscriptionManager } from './local-transcription.ts';
import type { LocalModelManager } from './model-manager.ts';

/** Narration captured with a Flutter app, transcribed onto that capture's own clock. */
export type CaptureTranscriptionInput = {
  captureId: string;
  audioPath: string;
  durationMs: number;
  timingUncertaintyMs: number;
  events: readonly { id: string; elapsedMs: number }[];
  persist(transcript: LocalTranscript): Promise<unknown>;
};

/** Per-request context; `cloud` authorizes a cloud provider for the signed-in person's workspace. */
export type TranscriptionStartOptions = { cloud?: CloudTranscriptionScope };

/**
 * Turns a recording's narration into a timestamped transcript aligned with the
 * captured actions, which test generation then reads.
 *
 * `whisper-local` (whisper.cpp on this Mac, `local-transcription.ts`) is the
 * built-in implementation and keeps audio on the machine. `gemini-cloud`
 * (`cloud-transcription.ts`) sends narration to the workspace's cloud backend,
 * which transcribes it with Gemini for Beta and Pro workspaces; it exists only
 * in builds with a cloud backend. Another engine implements this interface and
 * is registered in `TRANSCRIPTION_PROVIDERS` below. Progress is reported
 * through the `onLifecycle` callback in the options; a web recording's
 * transcript is stored with the recording, a Flutter capture's through `persist`.
 */
export interface TranscriptionProvider {
  readonly id: string;
  initialize(): Promise<void>;
  /** Transcribes a finished web recording and stores the transcript with it. Calls for a recording already in progress share its job. */
  start(recordingId: string, options?: TranscriptionStartOptions): Promise<LocalTranscript>;
  startFlutter(input: CaptureTranscriptionInput, options?: TranscriptionStartOptions): Promise<LocalTranscript>;
  /** Whether this provider has a job running for the recording or capture. */
  running(recordingId: string): boolean;
  /** Stops a running job; resolves with the stored transcript when nothing is running. */
  cancel(recordingId: string): Promise<LocalTranscript>;
  shutdown(): Promise<void>;
}

export type TranscriptionProviderOptions = {
  rootDirectory: string;
  store: RecordingStore;
  models: LocalModelManager;
  /** Base URL of the cloud backend's callable functions; empty in local-only builds. */
  cloudFunctionsUrl?: string;
  onLifecycle?(event: LocalTranscriptionLifecycleEvent): void;
};

const TRANSCRIPTION_PROVIDERS: Record<string, (options: TranscriptionProviderOptions) => TranscriptionProvider> = {
  'whisper-local': (options) => new LocalTranscriptionManager(options),
  'gemini-cloud': (options) => new CloudTranscriptionManager(options),
};

export const DEFAULT_TRANSCRIPTION_PROVIDER = 'whisper-local';
export const CLOUD_TRANSCRIPTION_PROVIDER = 'gemini-cloud';

export function createTranscriptionProvider(id: string, options: TranscriptionProviderOptions): TranscriptionProvider {
  const create = TRANSCRIPTION_PROVIDERS[id];
  if (!create) throw new Error(`Unknown transcription provider "${id}". Available: ${Object.keys(TRANSCRIPTION_PROVIDERS).join(', ')}.`);
  return create(options);
}
