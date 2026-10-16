import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { flutterSessionIdOf } from '@sayspec/contracts';
import type {
  FlutterCapture, FlutterCaptureSummary, FlutterEvidenceEvent, FlutterRecordingStatus, FlutterWidgetCandidate, FlutterWidgetIdentity,
  LocalTranscript,
} from '@sayspec/contracts';

const CAPTURE_ID = /^flutter_capture_[a-f0-9-]{36}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/;
const REQUIRED_SCHEMA = 1;
const MAX_CAPTURE_BYTES = 512 * 1024 * 1024;

interface CaptureDraft extends FlutterCaptureSummary {
  clock: FlutterCapture['clock'];
  events: FlutterEvidenceEvent[];
  artifacts: FlutterCapture['artifacts'][number][];
  narration?: FlutterCapture['narration'];
}

const now = () => new Date().toISOString();

function cleanId(value: unknown, label: string) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

/**
 * Stores Flutter recording evidence locally.
 *
 * Every capture is immutable once stopped: the raw events, the clock
 * calibration and the screenshot artifacts are written together so a reopened
 * review shows exactly what the device emitted.
 */
export class FlutterCaptureStore {
  readonly #root: string;
  readonly #indexPath: string;
  #index: FlutterCaptureSummary[] = [];

  constructor(root: string) {
    this.#root = root;
    this.#indexPath = path.join(root, 'index.json');
  }

  async initialize() {
    await mkdir(this.#root, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.#indexPath, 'utf8')) as { captures?: FlutterCaptureSummary[] };
      this.#index = Array.isArray(parsed.captures) ? parsed.captures : [];
    } catch { this.#index = []; }
  }

  list(projectId: string) {
    return this.#index.filter((item) => item.projectId === projectId).map((item) => ({ ...item }));
  }

  findSummary(captureId: string) {
    const found = this.#index.find((item) => item.id === captureId);
    return found ? { ...found } : undefined;
  }

  /** A recording session's recordings, oldest first. */
  listSession(projectId: string, sessionId: string) {
    return this.list(projectId).filter((item) => flutterSessionIdOf(item) === sessionId).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  /** The most recent capture for a project, used to recover an interrupted run. */
  latest(projectId: string) {
    return this.list(projectId).at(-1);
  }

  async create(input: { organizationId?: string; projectId: string; sessionId?: string; sessionTitle?: string; title: string; deviceId: string; deviceName: string; platform: 'android' | 'ios'; appId: string; entryPoint?: { name: string; command: string }; appVersion?: string; recorderSdkVersion: string; recorderSchemaVersion: number }): Promise<CaptureDraft> {
    const id = `flutter_capture_${randomUUID()}`;
    const draft: CaptureDraft = {
      schemaVersion: 1,
      id,
      organizationId: cleanId(input.organizationId ?? 'local', 'Organization'),
      projectId: cleanId(input.projectId, 'Project'),
      title: input.title.slice(0, 200) || 'Flutter recording',
      ...(input.sessionId ? { sessionId: cleanId(input.sessionId, 'Recording session') } : {}),
      ...(input.sessionTitle ? { sessionTitle: input.sessionTitle.slice(0, 200) } : {}),
      status: 'preparing',
      startedAt: now(),
      durationMs: 0,
      eventCount: 0,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      platform: input.platform,
      appId: input.appId,
      ...(input.entryPoint ? { entryPoint: { name: input.entryPoint.name.slice(0, 80), command: input.entryPoint.command.slice(0, 600) } } : {}),
      ...(input.appVersion ? { appVersion: input.appVersion } : {}),
      recorderSdkVersion: input.recorderSdkVersion,
      recorderSchemaVersion: input.recorderSchemaVersion,
      completenessWarnings: [],
      shareState: 'local',
      clock: { offsetMs: 0, roundTripMs: 0, samples: 0, uncertaintyMs: 0 },
      events: [],
      artifacts: [],
    };
    await mkdir(path.join(this.#directory(id), 'audio'), { recursive: true });
    return draft;
  }

  async #persist(draft: CaptureDraft) {
    const size = JSON.stringify(draft).length;
    if (size > 64 * 1024 * 1024) throw new Error('The Flutter capture journal exceeds its 64 MiB budget.');
    await writeFile(path.join(this.#directory(draft.id), 'capture.json'), JSON.stringify(draft, null, 2));
    const summary = this.#summaryOf(draft);
    this.#index = [...this.#index.filter((item) => item.id !== summary.id), summary];
    await writeFile(this.#indexPath, JSON.stringify({ captures: this.#index }, null, 2));
  }

  #directory(id: string) {
    if (!CAPTURE_ID.test(id)) throw new Error('Flutter capture id is invalid.');
    return path.join(this.#root, id);
  }

  #summaryOf(draft: CaptureDraft): FlutterCaptureSummary {
    const { clock: _clock, events: _events, artifacts: _artifacts, narration: _narration, ...summary } = draft;
    return summary;
  }

  /**
   * Applies one recorder batch.
   *
   * The envelope's schema version is checked before any event is stored: an app
   * built against a newer SDK is refused instead of silently misread.
   */
  async appendBatch(draft: CaptureDraft, input: { envelope?: Record<string, unknown>; events: Record<string, unknown>[] }) {
    if (input.envelope) {
      const schema = Number(input.envelope.schemaVersion ?? 0);
      if (schema !== REQUIRED_SCHEMA) throw new Error(`The app reported recorder schema ${schema}; this SaySpec build understands schema ${REQUIRED_SCHEMA}.`);
      const clock = input.envelope.clock as Record<string, unknown> | undefined;
      if (clock && typeof clock === 'object') {
        draft.clock = {
          offsetMs: Number(clock.offsetMs ?? 0),
          roundTripMs: Number(clock.roundTripMs ?? 0),
          samples: Number(clock.samples ?? 0),
          uncertaintyMs: Number(clock.uncertaintyMs ?? 0),
        };
      }
      if (draft.clock.samples === 0) draft.completenessWarnings = [...new Set([...draft.completenessWarnings, 'Clock calibration did not complete; narration alignment is approximate.'])];
      else if (draft.clock.uncertaintyMs > 750) draft.completenessWarnings = [...new Set([...draft.completenessWarnings, `Clock alignment uncertainty is ${draft.clock.uncertaintyMs} ms.`])];
      const device = input.envelope.device as Record<string, unknown> | undefined;
      const sdk = input.envelope.sdk as Record<string, unknown> | undefined;
      if (sdk?.version) draft.recorderSdkVersion = String(sdk.version);
      if (device?.platform && device.platform !== draft.platform && String(device.platform) === 'ios') draft.platform = 'ios';
    }
    for (const raw of input.events) {
      const event = this.#normalizeEvent(draft, raw);
      if (!event) continue;
      draft.events.push(event);
      draft.eventCount = draft.events.length;
    }
    if (draft.events.length > 20_000) throw new Error('The Flutter capture exceeds the 20,000-event budget.');
    draft.durationMs = draft.events.length ? Math.max(0, (draft.events.at(-1)?.hostAlignedMs ?? 0) - (draft.events[0]?.hostAlignedMs ?? 0)) : 0;
    await this.#persist(draft);
    return draft;
  }

  #normalizeEvent(draft: CaptureDraft, raw: Record<string, unknown>): FlutterEvidenceEvent | undefined {
    const id = typeof raw.id === 'string' && raw.id.length <= 160 ? raw.id : `event_${draft.events.length + 1}`;
    if (draft.events.some((item) => item.id === id)) return undefined;
    const kind = ['action', 'navigation', 'lifecycle', 'marker'].includes(String(raw.kind)) ? String(raw.kind) as FlutterEvidenceEvent['kind'] : 'action';
    const monotonicMs = Number(raw.monotonicMs ?? 0);
    const screenshot = typeof raw.screenshot === 'string' && raw.screenshot.length > 0 ? this.#writeScreenshot(draft, id, raw.screenshot) : undefined;
    const widget = normalizeWidget(raw.widget);
    if (!widget && kind === 'action') draft.completenessWarnings = [...new Set([...draft.completenessWarnings, `${id}: the app reported no widget identity for this action.`])];
    return {
      id,
      seq: Number(raw.seq ?? draft.events.length + 1),
      kind,
      monotonicMs,
      hostAlignedMs: monotonicMs + draft.clock.offsetMs,
      ...(typeof raw.route === 'string' ? { route: raw.route } : {}),
      ...(typeof raw.previousRoute === 'string' ? { previousRoute: raw.previousRoute } : {}),
      ...(widget ? { widget } : {}),
      payload: typeof raw.payload === 'object' && raw.payload !== null ? raw.payload as Record<string, unknown> : {},
      ...(screenshot ? { screenshotArtifactId: screenshot.id } : {}),
    };
  }

  #writeScreenshot(draft: CaptureDraft, eventId: string, base64: string) {
    let bytes: Buffer;
    try { bytes = Buffer.from(base64, 'base64'); } catch { return undefined; }
    if (!bytes.byteLength || bytes.byteLength > 4 * 1024 * 1024) return undefined;
    const artifactId = `artifact_${createHash('sha256').update(eventId).digest('hex').slice(0, 16)}`;
    const relativePath = path.join('screenshots', `${artifactId}.png`);
    const absolute = path.join(this.#directory(draft.id), relativePath);
    // Written synchronously through a bounded queue so ordering matches events.
    writeQueue.push({ absolute, bytes, artifactId, relativePath, mimeType: 'image/png' });
    void drainQueue();
    const entry = { id: artifactId, relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, mimeType: 'image/png' };
    if (!draft.artifacts.some((item) => item.id === artifactId)) draft.artifacts.push(entry);
    return entry;
  }

  async flushWrites() { await drainQueue(true); }

  async setStatus(draft: CaptureDraft, status: FlutterRecordingStatus, error?: string) {
    draft.status = status;
    if (error) draft.error = error;
    if (status === 'ready' || status === 'failed' || status === 'interrupted') draft.finishedAt = now();
    await this.flushWrites();
    await this.#persist(draft);
    return { ...draft };
  }

  async beginNarration(draft: CaptureDraft, mimeType: string, startedAtHostMonotonicMs: number) {
    if (draft.narration) throw new Error('Narration is already attached to this Flutter recording.');
    if (!mimeType.startsWith('audio/') || mimeType.length > 120) throw new Error('Narration MIME type is invalid.');
    const artifactId = 'narration_audio';
    draft.narration = {
      artifactId, captureId: draft.id, mimeType,
      startedAtHostMonotonicMs, finishedAtHostMonotonicMs: startedAtHostMonotonicMs,
      durationMs: 0, sha256: '', byteLength: 0,
    };
    await this.#persist(draft);
    return draft.narration;
  }

  async appendNarration(draft: CaptureDraft, mimeType: string, bytes: Uint8Array) {
    const narration = draft.narration;
    if (!narration || narration.captureId !== draft.id) throw new Error('Start narration for this Flutter recording before appending audio.');
    if (mimeType !== narration.mimeType) throw new Error('Narration MIME type changed during the capture.');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 2 * 1024 * 1024) throw new Error('Narration audio chunk exceeds the 2 MiB budget.');
    if (narration.byteLength + bytes.byteLength > MAX_CAPTURE_BYTES) throw new Error('The Flutter narration exceeds its 512 MiB budget.');
    await appendFile(path.join(this.#directory(draft.id), 'audio', 'narration.webm'), bytes, { mode: 0o600 });
    narration.byteLength += bytes.byteLength;
  }

  async finishNarration(draft: CaptureDraft, finishedAtHostMonotonicMs: number) {
    const narration = draft.narration;
    if (!narration) throw new Error('No narration belongs to this Flutter recording.');
    const audioPath = path.join(this.#directory(draft.id), 'audio', 'narration.webm');
    const bytes = await readFile(audioPath).catch(() => undefined);
    narration.finishedAtHostMonotonicMs = Math.max(narration.startedAtHostMonotonicMs, finishedAtHostMonotonicMs);
    narration.durationMs = narration.finishedAtHostMonotonicMs - narration.startedAtHostMonotonicMs;
    if (!bytes?.byteLength) {
      draft.completenessWarnings = [...new Set([...draft.completenessWarnings, 'No microphone narration was saved for this capture.'])];
      await this.#persist(draft);
      return narration;
    }
    narration.byteLength = bytes.byteLength;
    narration.sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifact = { id: narration.artifactId, relativePath: 'audio/narration.webm', sha256: narration.sha256, byteLength: narration.byteLength, mimeType: narration.mimeType };
    draft.artifacts = [...draft.artifacts.filter((item) => item.id !== artifact.id), artifact];
    await this.#persist(draft);
    return narration;
  }

  async writeTranscript(captureId: string, transcript: LocalTranscript) {
    if (transcript.recordingId !== captureId || transcript.schemaVersion !== 1) throw new Error('Flutter narration transcript does not belong to this capture.');
    await writeFile(path.join(this.#directory(captureId), 'transcript.json'), JSON.stringify(transcript, null, 2));
    return transcript;
  }

  async setShareState(captureId: string, state: NonNullable<FlutterCaptureSummary['shareState']>) {
    if (!['local', 'uploading', 'shared', 'failed'].includes(state)) throw new Error('Flutter share state is invalid.');
    const draft = JSON.parse(await readFile(path.join(this.#directory(captureId), 'capture.json'), 'utf8')) as CaptureDraft;
    draft.shareState = state; await this.#persist(draft); return this.#summaryOf(draft);
  }

  async get(projectId: string, captureId: string): Promise<FlutterCapture> {
    const raw = JSON.parse(await readFile(path.join(this.#directory(captureId), 'capture.json'), 'utf8')) as CaptureDraft;
    if (raw.projectId !== projectId) throw new Error('That Flutter recording belongs to a different project.');
    const summary = this.#summaryOf(raw);
    let transcript: LocalTranscript | undefined;
    try { transcript = JSON.parse(await readFile(path.join(this.#directory(captureId), 'transcript.json'), 'utf8')) as LocalTranscript; } catch { /* optional */ }
    return {
      summary,
      clock: raw.clock,
      events: raw.events,
      artifacts: raw.artifacts,
      ...(raw.narration ? { narration: raw.narration } : {}),
      ...(transcript ? { transcript } : {}),
      assertions: deriveAssertions(raw.events),
    };
  }

  async narrationPath(projectId: string, captureId: string) {
    const capture = await this.get(projectId, captureId);
    if (!capture.narration?.sha256 || !capture.narration.byteLength) throw new Error('This Flutter recording has no saved microphone narration.');
    const audioPath = path.join(this.#directory(captureId), 'audio', 'narration.webm');
    const bytes = await readFile(audioPath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== capture.narration.sha256 || bytes.byteLength !== capture.narration.byteLength) throw new Error('The saved Flutter narration no longer matches its capture manifest.');
    return { path: audioPath, narration: capture.narration };
  }

  async readNarration(captureId: string) {
    const raw = JSON.parse(await readFile(path.join(this.#directory(captureId), 'capture.json'), 'utf8')) as CaptureDraft;
    if (!raw.narration?.sha256) throw new Error('This Flutter recording has no saved microphone narration.');
    const bytes = await readFile(path.join(this.#directory(captureId), 'audio', 'narration.webm'));
    if (createHash('sha256').update(bytes).digest('hex') !== raw.narration.sha256) throw new Error('The saved Flutter narration no longer matches its capture manifest.');
    return { artifactId: raw.narration.artifactId, mimeType: raw.narration.mimeType, bytes };
  }

  async readArtifact(captureId: string, artifactId: string) {
    const raw = JSON.parse(await readFile(path.join(this.#directory(captureId), 'capture.json'), 'utf8')) as CaptureDraft;
    const artifact = raw.artifacts.find((item) => item.id === artifactId);
    if (!artifact) throw new Error('That screenshot is not part of this recording.');
    const bytes = await readFile(path.join(this.#directory(captureId), artifact.relativePath));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== artifact.sha256) throw new Error('The stored screenshot no longer matches its recorded hash.');
    return { artifactId, mimeType: artifact.mimeType, bytes };
  }

  /** Deletes captures that were left mid-recording and never finished. */
  async pruneUnfinished(projectId: string, keepId?: string) {
    for (const summary of this.list(projectId)) {
      if (summary.id === keepId) continue;
      if (summary.status !== 'preparing' && summary.status !== 'recording' && summary.status !== 'paused') continue;
      const draft = JSON.parse(await readFile(path.join(this.#directory(summary.id), 'capture.json'), 'utf8')) as CaptureDraft;
      await this.setStatus(draft, 'interrupted', 'SaySpec stopped while this recording was running.');
    }
  }

  async remove(captureId: string) {
    await rm(this.#directory(captureId), { recursive: true, force: true });
    this.#index = this.#index.filter((item) => item.id !== captureId);
    await writeFile(this.#indexPath, JSON.stringify({ captures: this.#index }, null, 2));
  }

  async sizeOf(captureId: string) {
    const directory = this.#directory(captureId);
    let total = 0;
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      const entry = await stat(path.join(directory, name)).catch(() => null);
      if (entry?.isFile()) total += entry.size;
    }
    if (total > MAX_CAPTURE_BYTES) throw new Error('The Flutter capture exceeds its disk budget.');
    return total;
  }
}

const writeQueue: { absolute: string; bytes: Buffer; artifactId: string; relativePath: string; mimeType: string }[] = [];
let draining = false;

async function drainQueue(force = false) {
  if (draining && !force) return;
  draining = true;
  try {
    while (writeQueue.length) {
      const item = writeQueue.shift()!;
      await mkdir(path.dirname(item.absolute), { recursive: true });
      await writeFile(item.absolute, item.bytes);
    }
  } finally { draining = false; }
}

function normalizeWidget(raw: unknown): FlutterWidgetIdentity | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const widgetType = typeof value.widgetType === 'string' ? value.widgetType : 'Unknown';
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map<FlutterWidgetCandidate>((item) => ({
        kind: ['key', 'semantics', 'text', 'type'].includes(String(item.kind)) ? String(item.kind) as FlutterWidgetCandidate['kind'] : 'type',
        value: String(item.value ?? ''),
        confidence: ['high', 'medium', 'low'].includes(String(item.confidence)) ? String(item.confidence) as FlutterWidgetCandidate['confidence'] : 'low',
      })).filter((item) => item.value.length > 0)
    : [];
  const bounds = value.bounds && typeof value.bounds === 'object'
    ? value.bounds as { x?: number; y?: number; width?: number; height?: number }
    : undefined;
  return {
    widgetType,
    ...(typeof value.key === 'string' ? { key: value.key } : {}),
    ...(typeof value.keyKind === 'string' ? { keyKind: value.keyKind } : {}),
    ...(typeof value.semanticLabel === 'string' ? { semanticLabel: value.semanticLabel } : {}),
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ancestors: Array.isArray(value.ancestors) ? value.ancestors.filter((item): item is string => typeof item === 'string').slice(0, 8) : [],
    candidates,
    ...(bounds ? { bounds: { x: Number(bounds.x ?? 0), y: Number(bounds.y ?? 0), width: Number(bounds.width ?? 0), height: Number(bounds.height ?? 0) } } : {}),
  };
}

/**
 * Turns recorded identity into Patrol finder suggestions.
 *
 * These are suggestions a reviewer (or the interactive Claude session) checks
 * against the narration; a recorded literal is never treated as the assertion.
 */
export function deriveAssertions(events: readonly FlutterEvidenceEvent[]) {
  const suggestions: { eventId: string; suggestion: string; confidence: 'high' | 'medium' | 'low'; rationale: string }[] = [];
  for (const event of events) {
    if (event.kind !== 'action' || !event.widget) continue;
    const candidate = event.widget.candidates.find((item) => item.kind === 'key') ?? event.widget.candidates.find((item) => item.kind === 'semantics') ?? event.widget.candidates.find((item) => item.kind === 'text');
    if (!candidate) {
      suggestions.push({ eventId: event.id, suggestion: `find.byType(${event.widget.widgetType})`, confidence: 'low', rationale: 'No key, semantics label or visible text was recorded, so this finder is positional and fragile.' });
      continue;
    }
    const escaped = candidate.value.replaceAll("'", "\\'");
    if (candidate.kind === 'key') suggestions.push({ eventId: event.id, suggestion: `find.byKey(const ValueKey<String>('${escaped}'))`, confidence: candidate.confidence, rationale: `The app recorded widget key “${candidate.value}”.` });
    else if (candidate.kind === 'semantics') suggestions.push({ eventId: event.id, suggestion: `find.bySemanticsLabel('${escaped}')`, confidence: candidate.confidence, rationale: `The app recorded the semantics label “${candidate.value}”.` });
    else if (candidate.kind === 'text') suggestions.push({ eventId: event.id, suggestion: `find.text('${escaped}')`, confidence: candidate.confidence, rationale: `The app recorded the visible text “${candidate.value}”; narration must confirm it is the intent.` });
    else suggestions.push({ eventId: event.id, suggestion: `find.byType(${candidate.value})`, confidence: 'low', rationale: 'Only the widget type was available.' });
  }
  return suggestions;
}
