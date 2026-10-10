import type {
  RecordingControlSnapshot, RecordingLifecycleEvent, RecordingStopResult,
  WebRecordingStartInput,
} from '@sayspec/contracts';
import { RecordingStore } from './recording-store.ts';
import { WebCaptureAdapter } from './web-capture-adapter.ts';

export interface RecordingManagerOptions {
  store: RecordingStore;
  headless?: boolean;
  executablePath?: string;
  onLifecycle(event: RecordingLifecycleEvent): void;
}

type RecordingSession = {
  activeRecordingId: string;
  input: WebRecordingStartInput;
  adapter: WebCaptureAdapter;
};

export class RecordingManager {
  readonly #store: RecordingStore;
  readonly #options: RecordingManagerOptions;
  readonly #sessions = new Map<string, RecordingSession>();

  constructor(options: RecordingManagerOptions) { this.#store = options.store; this.#options = options; }

  async start(input: WebRecordingStartInput): Promise<RecordingControlSnapshot> {
    if (this.#sessions.size) throw new Error('Finish or cancel the current browser session before starting another.');
    const snapshot = await this.#store.create(input);
    const recordingId = snapshot.recording.id;
    let session: RecordingSession;
    const adapter = new WebCaptureAdapter({
      headless: this.#options.headless, executablePath: this.#options.executablePath,
      onEvent: async (event) => { await this.#store.addEvent(session.activeRecordingId, event); },
      onWarning: async (message) => { await this.#store.warning(session.activeRecordingId, message); },
      onControlRequested: (action) => {
        this.#options.onLifecycle({ recordingId: session.activeRecordingId, state: action === 'start' ? 'start-requested' : 'stop-requested' });
      },
      onBrowserClosed: () => {
        this.#sessions.delete(session.activeRecordingId);
        this.#options.onLifecycle({ recordingId: session.activeRecordingId, state: 'browser-closed', message: 'The recording browser was closed. Partial evidence can be recovered.' });
      },
    });
    session = { activeRecordingId: recordingId, input: { ...input }, adapter };
    try {
      this.#sessions.set(recordingId, session);
      await adapter.prepare(input.startUrl);
      return snapshot;
    } catch (error) {
      this.#sessions.delete(recordingId);
      await adapter.close();
      await this.#store.cancel(recordingId);
      throw error;
    }
  }

  async begin(recordingId: string) {
    const adapter = this.#adapter(recordingId);
    const snapshot = await this.#store.beginSegment(recordingId);
    adapter.resume(true); this.#options.onLifecycle({ recordingId, state: 'recording' }); return snapshot;
  }

  async appendAudio(input: { recordingId: string; segmentId: string; mimeType: string; bytes: Uint8Array }) { await this.#store.appendAudio(input); }

  async pause(recordingId: string) {
    await this.#adapter(recordingId).pause();
    const snapshot = await this.#store.pause(recordingId);
    this.#options.onLifecycle({ recordingId, state: 'paused' }); return snapshot;
  }

  async resume(recordingId: string) {
    const snapshot = await this.#store.beginSegment(recordingId);
    this.#adapter(recordingId).resume(); this.#options.onLifecycle({ recordingId, state: 'recording' }); return snapshot;
  }

  async stop(recordingId: string): Promise<RecordingStopResult> {
    const session = this.#session(recordingId);
    await session.adapter.pause();
    const review = await this.#store.stop(recordingId);
    this.#options.onLifecycle({ recordingId, state: 'ready' });
    let next: RecordingControlSnapshot | undefined;
    try {
      next = await this.#store.create(session.input);
      this.#sessions.delete(recordingId); session.activeRecordingId = next.recording.id;
      this.#sessions.set(session.activeRecordingId, session);
      await session.adapter.reset(session.input.startUrl);
      return { review, next };
    } catch (error) {
      this.#sessions.delete(session.activeRecordingId); await session.adapter.close();
      if (next) await this.#store.cancel(next.recording.id).catch(() => undefined);
      this.#options.onLifecycle({ recordingId, state: 'ready', message: `The test was saved, but the browser could not reset: ${error instanceof Error ? error.message : String(error)}` });
      return { review };
    }
  }

  async interrupt(recordingId: string, reason: string) {
    const session = this.#sessions.get(recordingId);
    await session?.adapter.pause(); await session?.adapter.close(); this.#sessions.delete(recordingId);
    const review = await this.#store.interrupt(recordingId, reason);
    this.#options.onLifecycle({ recordingId, state: 'interrupted', message: reason }); return review;
  }

  async cancel(recordingId: string) {
    const session = this.#sessions.get(recordingId);
    await session?.adapter.pause(); await session?.adapter.close(); this.#sessions.delete(recordingId);
    await this.#store.cancel(recordingId);
  }

  async shutdown() {
    for (const recordingId of [...this.#sessions.keys()]) {
      await this.interrupt(recordingId, 'Recording was interrupted because SaySpec closed.');
    }
  }

  #session(recordingId: string) {
    const session = this.#sessions.get(recordingId);
    if (!session) throw new Error('The recording browser is no longer available.');
    return session;
  }

  #adapter(recordingId: string) { return this.#session(recordingId).adapter; }
}
