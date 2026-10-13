import { useEffect, useMemo, useRef, useState } from 'react';
import {
  flutterSessionIdOf, type FlutterCapture, type FlutterCaptureLifecycleEvent, type FlutterCaptureSummary, type FlutterDeviceSummary,
  type FlutterRecorderSdkCompatibility, type LocalSourceSelection, type LocalTranscriptionSetup, type PatrolAttempt, type PatrolSavedTest, type PlanKind,
} from '@sayspec/contracts';
import { Button, Field, StatusLabel } from './ui';
import { GenerationPickers, RecordLayout, RecordingsSidebar, useCodingAgent } from './recordings-sidebar';
import { PatrolGenerationTerminal } from './patrol-generation-terminal';
import { shareFlutterSlice } from './flutter-share';
import { useCloud } from './cloud/context';
import { EntryPointSelect, useProjectEntryPoints } from './entry-points';
import { RecorderIntegrationDialog } from './flutter-integration';
import { DeviceSelect } from './device-select';
import { cloudTranscriptionScope, useNarrationChoice } from './narration-model-preference';

const messageOf = (error: unknown) => (error instanceof Error ? error.message.replace(/^Error:\s*/, '') : String(error));

function audioMimeType() {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((value) => MediaRecorder.isTypeSupported(value)) ?? '';
}

function timeLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function defaultSessionTitle(appName: string) {
  const timestamp = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
  return `${appName} · ${timestamp}`;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const MAX_LAUNCH_LINES = 2000;

/**
 * `flutter run` output while the app builds and launches: collapsed by
 * default, opened when the launch fails so the cause is one glance away.
 */
function LaunchConsole({ lines, failed }: { lines: readonly string[]; failed: boolean }) {
  const [open, setOpen] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  useEffect(() => { if (failed) setOpen(true); }, [failed]);
  useEffect(() => {
    const output = outputRef.current;
    if (open && output) output.scrollTop = output.scrollHeight;
  }, [open, lines]);
  return <details className="launch-console" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Launch console <span>{lines.length ? plural(lines.length, 'line') : 'waiting for output…'}</span></summary>
    <pre ref={outputRef} aria-label="Flutter launch output">{lines.join('\n')}</pre>
  </details>;
}

/** One app launch and the recordings made in it; tests are generated per session. */
interface FlutterSession { id: string; title: string; deviceName: string; recordings: FlutterCaptureSummary[] }

function groupSessions(captures: readonly FlutterCaptureSummary[]): FlutterSession[] {
  const sessions = new Map<string, FlutterSession>();
  for (const capture of [...captures].sort((left, right) => left.startedAt.localeCompare(right.startedAt))) {
    const id = flutterSessionIdOf(capture);
    const session = sessions.get(id) ?? { id, title: capture.sessionTitle ?? capture.title, deviceName: capture.deviceName, recordings: [] };
    session.recordings.push(capture);
    sessions.set(id, session);
  }
  return [...sessions.values()].sort((left, right) => right.recordings.at(-1)!.startedAt.localeCompare(left.recordings.at(-1)!.startedAt));
}

/**
 * Flutter recording panel.
 *
 * The Record view keeps project setup compact and focuses on device selection
 * and capture. Full machine readiness and integration setup live in Settings.
 */
export function FlutterRecordPanel({ project, source, visible = true, onChooseSource, cloudPlan }: {
  project: { id: string; name: string; baseUrl?: string; organizationId: string; createdByUid?: string };
  source?: LocalSourceSelection;
  visible?: boolean;
  onChooseSource: (source: LocalSourceSelection) => void;
  /** The cloud workspace's plan (null while loading); undefined for a guest project. */
  cloudPlan?: PlanKind | null;
}) {
  const cloud = useCloud();
  const narration = useNarrationChoice(cloudPlan);
  const gemini = narration.engine === 'cloud' && project.organizationId !== 'local';
  const [devices, setDevices] = useState<FlutterDeviceSummary[]>([]);
  const [checkingDevices, setCheckingDevices] = useState(true);
  const [deviceId, setDeviceId] = useState('');
  const [sdk, setSdk] = useState<FlutterRecorderSdkCompatibility | null>(null);
  const [integrationOpen, setIntegrationOpen] = useState(false);
  const [captures, setCaptures] = useState<FlutterCaptureSummary[]>([]);
  const [active, setActive] = useState<FlutterCaptureSummary | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionCaptures, setSessionCaptures] = useState<FlutterCapture[]>([]);
  const [tests, setTests] = useState<PatrolSavedTest[]>([]);
  const [lifecycle, setLifecycle] = useState<FlutterCaptureLifecycleEvent | null>(null);
  const [launchLog, setLaunchLog] = useState<string[]>([]);
  const [launchFailed, setLaunchFailed] = useState(false);
  const entryPoints = useProjectEntryPoints(project.id, 'flutter')?.entryPoints ?? [];
  const [entryPointName, setEntryPointName] = useState('');
  const entryPoint = entryPoints.find((item) => item.name === entryPointName);
  const [title, setTitle] = useState(() => defaultSessionTitle(project.name));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [microphoneId, setMicrophoneId] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [transcriptionSetup, setTranscriptionSetup] = useState<LocalTranscriptionSetup | null>(null);
  const agent = useCodingAgent();
  const [generation, setGeneration] = useState<{ sessionId: string; count: number } | null>(null);
  const transcribingRef = useRef('');
  const sessionIdRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioWritesRef = useRef<Promise<void>>(Promise.resolve());

  // The live session outlives this view (a remount, or Record/Stop pressed on
  // the device), so the current capture and narration owner live in refs the
  // lifecycle listener can read.
  const activeRef = useRef<FlutterCaptureSummary | null>(null);
  const narrationCaptureRef = useRef('');
  const stoppingRef = useRef(false);
  const lifecycleHandlerRef = useRef<(event: FlutterCaptureLifecycleEvent) => void>(() => undefined);

  function adoptActive(next: FlutterCaptureSummary | null) {
    activeRef.current = next;
    setActive(next);
  }

  async function syncActive() {
    const next = await window.sayspec!.getActiveFlutterCapture({ projectId: project.id });
    adoptActive(next);
    return next;
  }

  async function refreshCaptures() {
    setCaptures(await window.sayspec!.listFlutterCaptures({ projectId: project.id }));
  }

  async function refresh() {
    setError(''); setCheckingDevices(true);
    try {
      const [allDevices, nextCaptures] = await Promise.all([
        window.sayspec!.listFlutterDevices(),
        window.sayspec!.listFlutterCaptures({ projectId: project.id }),
      ]);
      const readyDevices = allDevices.filter((device) => device.state === 'ready');
      setDevices(allDevices);
      setDeviceId((current) => readyDevices.some((device) => device.id === current) ? current : readyDevices[0]?.id ?? '');
      setCaptures(nextCaptures);
    } catch (reason) { setError(messageOf(reason)); }
    finally { setCheckingDevices(false); }
  }

  useEffect(() => {
    void refresh();
    // Reattach to a session that kept running while this view was unmounted.
    void syncActive().then((next) => {
      if (!next) return;
      if (next.status === 'recording' || next.status === 'paused') setError('This view reloaded during a test, so its narration stopped. Stop and save it, then record the test again.');
      else setStatus('The app is running. Tap Record in the SaySpec overlay on the device to record a test.');
    }).catch(() => undefined);
  }, [project.id]);
  // Record stays mounted while hidden, so re-check devices each time it is shown again.
  const shownRef = useRef(visible);
  useEffect(() => {
    if (visible && !shownRef.current) void refresh();
    shownRef.current = visible;
  }, [visible]);
  useEffect(() => {
    setTitle(defaultSessionTitle(project.name));
  }, [project.id, project.name]);
  // The first entry point is the default; a choice survives edits that keep it.
  useEffect(() => {
    setEntryPointName((current) => entryPoints.some((item) => item.name === current) ? current : entryPoints[0]?.name ?? '');
  }, [entryPoints.map((item) => item.name).join('\n')]);
  lifecycleHandlerRef.current = (event) => {
    setLifecycle(event);
    if (event.state === 'failed') setError(event.message);
    if (event.captureId === 'pending') return;
    if (['recording', 'paused', 'waiting-for-user', 'restarting', 'stop-requested'].includes(event.state)) setStatus(event.message);
    if (event.state === 'recording' && narrationCaptureRef.current !== event.captureId) { void beginTest(event.captureId); void refreshCaptures().catch(() => undefined); }
    else if (event.state === 'stop-requested') void stop(event.captureId);
    else if (event.state === 'waiting-for-user' || event.state === 'restarting' || event.state === 'paused') void syncActive().catch(() => undefined);
  };
  useEffect(() => window.sayspec!.onFlutterCaptureLifecycle((event) => lifecycleHandlerRef.current(event)), []);
  useEffect(() => window.sayspec!.onFlutterCaptureLaunchLog((event) => {
    if (event.projectId === project.id) setLaunchLog((lines) => [...lines, ...event.lines].slice(-MAX_LAUNCH_LINES));
  }), [project.id]);
  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const update = () => void navigator.mediaDevices.enumerateDevices().then((items) => setMicrophones(items.filter((item) => item.kind === 'audioinput'))).catch(() => undefined);
    update(); navigator.mediaDevices.addEventListener('devicechange', update);
    return () => navigator.mediaDevices.removeEventListener('devicechange', update);
  }, []);
  useEffect(() => () => stopMicrophone(), []);
  useEffect(() => { void window.sayspec!.getLocalTranscriptionSetup().then(setTranscriptionSetup).catch(() => undefined); }, []);
  useEffect(() => window.sayspec!.onLocalTranscriptionLifecycle((event) => {
    if (!preparing) return;
    if (event.kind === 'model') setStatus(event.state === 'downloading' && event.progress > 0 ? `Downloading the local narration model… ${Math.round(event.progress * 100)}%` : event.message);
    else if (transcribingRef.current && sessionCaptures.some((item) => item.summary.id === event.recordingId) && event.message) setStatus(`${transcribingRef.current} ${event.message}`);
  }), [preparing, sessionCaptures]);

  function checkSdk() {
    setSdk(null);
    if (!source) return;
    void window.sayspec!.checkFlutterRecorderSdk({ sourceHandle: source.handle })
      .then(setSdk)
      .catch((reason) => setError(messageOf(reason)));
  }
  useEffect(checkSdk, [source?.handle]);

  /** Launches the app idle; each test starts from Record in the device overlay. */
  async function start() {
    if (!source) { setError('Choose the Flutter project folder first.'); return; }
    if (!deviceId) { setError('Choose a device that is ready.'); return; }
    setBusy(true); setError(''); setStatus('Building and launching the app…'); sessionIdRef.current = null; setSessionId(null);
    setLaunchLog([]); setLaunchFailed(false);
    try {
      const permission = await window.sayspec!.requestMicrophoneAccess();
      if (permission.state !== 'granted') throw new Error(permission.detail);
      const next = await window.sayspec!.startFlutterCapture({ organizationId: project.organizationId, projectId: project.id, projectName: project.name, deviceId, ...(entryPoint ? { entryPoint } : {}), sourceHandle: source.handle, title: title.trim() || defaultSessionTitle(project.name) });
      adoptActive(next);
      setStatus('The app is running. Tap Record in the SaySpec overlay on the device, then narrate while you test.');
    } catch (reason) { setError(messageOf(reason)); setStatus(''); setLaunchFailed(true); }
    finally { setBusy(false); }
  }

  /** Record was pressed on the device: narration for that test starts here. */
  async function beginTest(captureId: string) {
    narrationCaptureRef.current = captureId;
    try {
      const stream = await openMicrophone();
      const mimeType = audioMimeType();
      await window.sayspec!.beginFlutterNarration({ captureId, mimeType: mimeType || 'audio/webm' });
      startNarrationRecorder(stream, captureId, mimeType);
    } catch (reason) {
      stopMicrophone();
      setError(`Narration could not start: ${messageOf(reason)}`);
    }
    await syncActive().catch(() => undefined);
  }

  /** Saves the current test, from the desktop Stop or the device overlay. */
  async function stop(captureId = activeRef.current?.id) {
    if (!captureId || stoppingRef.current) return;
    stoppingRef.current = true;
    setBusy(true); setError(''); setStatus('Saving the test…');
    try {
      if (narrationCaptureRef.current === captureId) await finishNarration(captureId);
      const result = await window.sayspec!.stopFlutterCapture({ captureId });
      setStatus(`${result.summary.title} saved to “${result.summary.sessionTitle ?? result.summary.title}”. The app is restarting for the next test.`);
    } catch (reason) { setError(messageOf(reason)); setStatus(''); }
    finally {
      narrationCaptureRef.current = '';
      stoppingRef.current = false;
      setBusy(false);
      await Promise.all([syncActive(), refreshCaptures()]).catch(() => undefined);
    }
  }

  async function control(action: 'pause' | 'resume' | 'end') {
    const current = activeRef.current;
    if (!current) return;
    setError('');
    try {
      if (action === 'end') {
        if (narrationCaptureRef.current === current.id) await finishNarration(current.id).catch(() => undefined);
        narrationCaptureRef.current = '';
        await window.sayspec!.cancelFlutterCapture({ captureId: current.id });
        adoptActive(null); setStatus(current.status === 'preparing' ? 'Recording session ended.' : 'Recording session ended; the unfinished test is kept locally.');
        await refresh(); return;
      }
      const next = action === 'pause' ? await window.sayspec!.pauseFlutterCapture({ captureId: current.id }) : await window.sayspec!.resumeFlutterCapture({ captureId: current.id });
      adoptActive(next); setStatus(action === 'pause' ? 'Recording paused.' : 'Recording resumed.');
    } catch (reason) { setError(messageOf(reason)); }
  }

  async function openMicrophone() {
    const permission = await window.sayspec!.requestMicrophoneAccess();
    if (permission.state !== 'granted') throw new Error(permission.detail);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Audio recording is unavailable in this desktop build.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneId ? { deviceId: { exact: microphoneId } } : true, video: false });
    if (!stream.getAudioTracks()[0]) throw new Error('No microphone input became available.');
    streamRef.current = stream;
    setMicrophones((await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === 'audioinput'));
    return stream;
  }

  function startNarrationRecorder(stream: MediaStream, captureId: string, preferredMimeType: string) {
    const recorder = new MediaRecorder(stream, preferredMimeType ? { mimeType: preferredMimeType, audioBitsPerSecond: 64_000 } : { audioBitsPerSecond: 64_000 });
    const mimeType = preferredMimeType || recorder.mimeType || 'audio/webm';
    recorder.addEventListener('dataavailable', (event) => {
      if (!event.data.size) return;
      audioWritesRef.current = audioWritesRef.current.then(async () => {
        await window.sayspec!.appendFlutterNarration({ captureId, mimeType, bytes: new Uint8Array(await event.data.arrayBuffer()) });
      }).catch((reason) => setError(messageOf(reason)));
    });
    recorder.start(1_000); mediaRecorderRef.current = recorder;
  }

  async function finishNarration(captureId: string) {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') await new Promise<void>((resolve) => { recorder.addEventListener('stop', () => resolve(), { once: true }); recorder.stop(); });
    mediaRecorderRef.current = null;
    await audioWritesRef.current;
    stopMicrophone();
    return window.sayspec!.finishFlutterNarration({ captureId });
  }

  function stopMicrophone() {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }

  async function loadSession(id: string) {
    const summaries = captures.filter((item) => flutterSessionIdOf(item) === id);
    const [loaded, saved] = await Promise.all([
      Promise.all(summaries.map((item) => window.sayspec!.getFlutterCapture({ projectId: project.id, captureId: item.id }))),
      window.sayspec!.listPatrolTests({ projectId: project.id, organizationId: project.organizationId }),
    ]);
    const ordered = loaded.sort((left, right) => left.summary.startedAt.localeCompare(right.summary.startedAt));
    // A slow load must not replace a session the user has since left.
    if (sessionIdRef.current === id) { setSessionCaptures(ordered); setTests(saved); }
    return { captures: ordered, tests: saved };
  }

  /**
   * Generate tests: transcribe every recording of the session on this device,
   * then open one coding-agent terminal that writes one test per recording.
   */
  async function generate() {
    if (!selectedSession || !source) return;
    if (!agent.provider) { setError('Choose Claude Code or Codex next to Generate tests.'); return; }
    const setup = transcriptionSetup ?? await window.sayspec!.getLocalTranscriptionSetup();
    if (!gemini && setup.runtime.state !== 'ready') { setError(setup.runtime.detail); return; }
    setPreparing(true); setError(''); setGeneration(null);
    try {
      if (!gemini && setup.model.state !== 'installed') {
        setStatus('Downloading the local narration model…');
        const installed = await window.sayspec!.installLocalTranscriptionModel({ modelId: setup.model.id });
        setTranscriptionSetup(installed);
        if (installed.model.state !== 'installed') throw new Error('The narration model download did not complete.');
      }
      const current = await loadSession(selectedSession.id);
      const tested = testedCaptureIds(current.tests);
      const candidates = current.captures.filter((item) => item.summary.status === 'ready' && item.narration?.sha256 && !tested.has(item.summary.id));
      if (!candidates.length) throw new Error(current.captures.some((item) => tested.has(item.summary.id)) ? 'Every narrated recording in this session already has a test.' : 'No finished recording in this session has narration. Narrate what each test should verify while recording.');
      // Choosing Gemini replaces Whisper transcripts of recordings that do not have a test yet.
      const untranscribed = candidates.filter((item) => item.transcript?.status !== 'ready' || (gemini && item.transcript.provider.kind !== 'cloud'));
      for (const [index, item] of untranscribed.entries()) {
        transcribingRef.current = `Transcribing ${item.summary.title}${gemini ? ' with Gemini' : ''} (${index + 1} of ${untranscribed.length})…`;
        setStatus(transcribingRef.current);
        const transcript = await window.sayspec!.transcribeFlutterCapture({ projectId: project.id, captureId: item.summary.id, ...(gemini ? { cloud: await cloudTranscriptionScope(cloud, project.organizationId, project.id) } : {}) });
        if (transcript.status !== 'ready') throw new Error(`${item.summary.title}: ${transcript.error ?? 'Transcription did not complete.'}`);
      }
      transcribingRef.current = '';
      const transcribed = (await loadSession(selectedSession.id)).captures.filter((item) => candidates.some((candidate) => candidate.summary.id === item.summary.id) && item.transcript?.status === 'ready' && item.transcript.segments.length > 0);
      if (!transcribed.length) throw new Error('No speech was detected in this session. Narrate what each test should verify, then record again.');
      const silent = candidates.length - transcribed.length;
      setStatus(`${agent.name} is writing ${plural(transcribed.length, 'test')} in the terminal below, one per recording.${silent ? ` ${plural(silent, 'recording')} without speech ${silent === 1 ? 'is' : 'are'} skipped.` : ''}`);
      setGeneration({ sessionId: selectedSession.id, count: transcribed.length });
    } catch (reason) { setError(messageOf(reason)); setStatus(''); }
    finally { transcribingRef.current = ''; setPreparing(false); }
  }

  function openSession(id: string | null) {
    setError(''); setStatus(''); setGeneration(null); setSessionCaptures([]);
    sessionIdRef.current = id; setSessionId(id);
  }

  const readyDevice = devices.find((device) => device.id === deviceId && device.state === 'ready');
  const sessions = useMemo(() => groupSessions(captures), [captures]);
  const selectedSession = sessions.find((item) => item.id === sessionId);
  const liveSessionId = active?.sessionId;
  const liveLabel = !selectedSession || !active ? undefined : active.status === 'recording' ? 'Recording' : active.status === 'paused' ? 'Paused' : 'App running';
  const sessionSignature = selectedSession?.recordings.map((item) => `${item.id}:${item.status}`).join('|') ?? '';

  // Reload the open session when its recordings change, for example a new
  // recording saved into the live session.
  useEffect(() => {
    if (sessionId) void loadSession(sessionId).catch((reason) => setError(messageOf(reason)));
  }, [sessionId, sessionSignature]);

  const sidebar = <RecordingsSidebar
    title="Sessions"
    empty="Each app launch is a session. Its recordings appear here as you finish them."
    items={sessions.map((item) => ({
      id: item.id,
      title: item.title,
      meta: `${new Date(item.recordings[0]!.startedAt).toLocaleString()} · ${plural(item.recordings.length, 'recording')}`,
      detail: item.id === liveSessionId ? `Live · ${item.deviceName}` : item.deviceName,
    }))}
    selectedId={sessionId ?? undefined}
    onSelect={(id) => openSession(id)}
    onNew={() => openSession(null)}
    live={liveLabel}
  />;

  const messages = <>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {status && <p className="settings-status" role="status">{status}</p>}
  </>;

  if (selectedSession) {
    const tested = testedCaptureIds(tests);
    const latest = selectedSession.recordings.at(-1)!;
    const narrated = sessionCaptures.filter((item) => item.summary.status === 'ready' && item.narration?.sha256);
    // Recordings a Generate run would write a test for; a transcript without speech cannot become one.
    const pending = narrated.filter((item) => !tested.has(item.summary.id) && !(item.transcript?.status === 'ready' && !item.transcript.segments.length));
    return <RecordLayout sidebar={sidebar}>
      <article className="flutter-capture-review" data-testid="flutter-capture-review">
        <div className="flutter-capture-review__head">
          <div><h2>{selectedSession.title}</h2><p>Recording session · {selectedSession.deviceName} · {new Date(selectedSession.recordings[0]!.startedAt).toLocaleString()} · {plural(selectedSession.recordings.length, 'recording')}</p></div>
          <div className="generate-actions">
            <GenerationPickers setup={transcriptionSetup} narration={narration} agent={agent} disabled={preparing} />
            <Button variant="primary" disabled={preparing || !source || !pending.length} title={!pending.length && narrated.length ? 'Every recording with narrated speech already has a test.' : undefined} onClick={() => void generate()}>{preparing ? 'Preparing…' : pending.length > 1 ? `Generate ${pending.length} tests` : 'Generate tests'}</Button>
          </div>
        </div>
        {agent.notice && <p className="control-help" role="status">{agent.notice}</p>}
        {messages}
        {!source && <p className="capture-warning" role="status">Choose the Flutter source folder again before generation so SaySpec can resolve its pinned SDK and run the exact candidate.</p>}
        {sessionCaptures.length > 0 && !narrated.length && <p className="capture-warning" role="status">No finished recording in this session has narration, so Generate tests is unavailable. Record the expectations again instead of inferring them from event names.</p>}
        {generation?.sessionId === selectedSession.id && source && <PatrolGenerationTerminal
          projectId={project.id} sessionId={selectedSession.id} recordingCount={generation.count}
          sourceHandle={source.handle} deviceId={latest.deviceId} appId={latest.appId}
          onSaved={() => void loadSession(selectedSession.id).catch(() => undefined)}
          onClose={() => { setGeneration(null); setStatus(''); void loadSession(selectedSession.id).catch(() => undefined); }}
        />}
        <ol className="session-recordings" aria-label="Recordings in this session">
          {sessionCaptures.map((item) => <SessionRecording key={item.summary.id} capture={item} test={tests.find((test) => test.state === 'published' && test.recordingCaptureId === item.summary.id)} project={project} onChanged={() => void loadSession(selectedSession.id).catch(() => undefined)} onError={setError} />)}
        </ol>
      </article>
    </RecordLayout>;
  }

  return <RecordLayout sidebar={sidebar}>
    <section className="flutter-record" aria-label="Flutter recording">
    <div className="flutter-record__steps">
      <article className="setup-card">
        <div className="flutter-record__card-head"><h3 id="flutter-device-heading">1 · Device</h3><Button className="flutter-record__refresh" variant="quiet" aria-label="Re-check devices" title="Re-check devices" disabled={busy || checkingDevices} onClick={() => void refresh()}>↻</Button></div>
        {checkingDevices && devices.length === 0 ? <p role="status">Looking for devices…</p>
          : <DeviceSelect className="flutter-record__device" ariaLabelledBy="flutter-device-heading" platforms={['android', 'ios']}
            devices={devices} value={deviceId} onChange={setDeviceId}
            onStarted={async (device) => { await refresh(); setDeviceId(device.id); }} />}
      </article>
      <article className="setup-card">
        <h3>2 · Recorder integration</h3>
        {!source ? <div className="setup-actions"><p>Choose the Flutter project folder to record it.</p><Button onClick={() => void window.sayspec!.chooseSourceDirectory().then((next) => next && onChooseSource(next)).catch((reason) => setError(messageOf(reason)))}>Choose source folder</Button></div>
          : <p className="recorder-integration-check" role="status">
            <span>Project folder <strong>{source.label}</strong>{sdk?.state === 'ready' ? ' · recorder ready' : !sdk ? ' · checking recorder dependency…' : ''}</span>
            {sdk && sdk.state !== 'ready' && <StatusLabel status="warning">{sdk.state === 'incompatible' ? 'Recorder dependency incompatible' : 'Recorder dependency not found'}</StatusLabel>}
          </p>}
        {source && sdk && sdk.state !== 'ready' && <div className="setup-actions"><p className="control-help">{sdk.detail}</p><Button onClick={() => setIntegrationOpen(true)}>Add recorder…</Button></div>}
        {source && <RecorderIntegrationDialog open={integrationOpen} onOpenChange={setIntegrationOpen} sourceHandle={source.handle} onApplied={checkSdk} />}
      </article>
      <article className="setup-card">
        <h3>3 · Record</h3>
        <div className="flutter-record__record-fields">
          <EntryPointSelect entryPoints={entryPoints} value={entryPointName} onChange={setEntryPointName} fallback="Default · flutter run" disabled={Boolean(active)} />
          <Field label="Session title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <label className="select-field">Microphone<select aria-label="Flutter narration microphone" value={microphoneId} onChange={(event) => setMicrophoneId(event.target.value)}><option value="">Default microphone</option>{microphones.filter((item) => item.deviceId !== 'default').map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || `Microphone ${index + 1}`}</option>)}</select></label>
        </div>
        {!active ? <div className="record-start"><Button variant="primary" disabled={busy || !source || !readyDevice} onClick={() => void start()}>{busy ? 'Launching…' : 'Launch app for recording'}</Button><p className="control-help">Start and stop each test from the SaySpec overlay in the app. After Stop the app restarts for the next test without rebuilding.</p>{(busy || launchLog.length > 0) && <LaunchConsole lines={launchLog} failed={launchFailed} />}</div>
          : active.status === 'preparing' ? <div className="record-actions">
            <StatusLabel status="warning">{busy ? 'Saving' : 'Waiting for Record on the device'}</StatusLabel>
            <Button variant="quiet" disabled={busy} onClick={() => void control('end')}>End session</Button>
          </div>
          : <div className="record-actions">
            <StatusLabel status={active.status === 'paused' ? 'warning' : 'running'}>{active.status === 'paused' ? 'Paused' : 'Recording'}</StatusLabel>
            {active.status === 'paused' ? <Button onClick={() => void control('resume')}>Resume</Button> : <Button onClick={() => void control('pause')}>Pause</Button>}
            <Button variant="primary" disabled={busy} onClick={() => void stop()}>Stop and save</Button>
            <Button variant="quiet" disabled={busy} onClick={() => void control('end')}>End session</Button>
          </div>}
        {lifecycle && <p className="control-help" role="status">{lifecycle.state}: {lifecycle.message}</p>}
        {active && !readyDevice && <p className="inline-error" role="alert">The recording was started for a device that is no longer reporting ready.</p>}
      </article>
    </div>
    {messages}
  </section>
  </RecordLayout>;
}

function testedCaptureIds(tests: readonly PatrolSavedTest[]) {
  return new Set(tests.filter((test) => test.state === 'published' && test.recordingCaptureId).map((test) => test.recordingCaptureId!));
}

/** One recording of a session: its narration, expectation and a summary of the evidence. */
function SessionRecording({ capture, test, project, onChanged, onError }: {
  capture: FlutterCapture;
  test?: PatrolSavedTest;
  project: { id: string; organizationId: string; createdByUid?: string };
  onChanged(): void;
  onError(message: string): void;
}) {
  const { summary } = capture;
  const actionCount = capture.events.filter((event) => event.kind === 'action').length;
  const appStarted = capture.events.find((event) => event.kind === 'lifecycle' && event.payload.phase === 'started') ?? capture.events[0];
  const state = test ? <StatusLabel status="passed">Test generated</StatusLabel>
    : summary.status === 'recording' || summary.status === 'paused' ? <StatusLabel status="running">Recording</StatusLabel>
    : summary.status !== 'ready' ? <StatusLabel status="warning">{summary.status === 'interrupted' ? 'Interrupted' : 'Failed'}</StatusLabel>
    : !capture.narration?.sha256 ? <StatusLabel status="blocked">No narration</StatusLabel>
    : <StatusLabel status="draft">No test yet</StatusLabel>;
  return <li className="session-recording" data-testid="session-recording">
    <div className="session-recording__head">
      <h3>{summary.title}</h3>
      {state}
      <span className="session-recording__meta">{new Date(summary.startedAt).toLocaleTimeString()} · {timeLabel(summary.durationMs)}</span>
    </div>
    {test && <p className="control-help">Test “{test.title}” · <code>{test.relativePath}</code></p>}
    {capture.narration?.sha256 && capture.transcript?.status === 'ready' && <div className="flutter-narration">{capture.transcript.segments.length > 0 ? <NarratedExpectation text={capture.transcript.segments.map((segment) => segment.text.trim()).join(' ')} /> : <p>No speech was detected in this narration.</p>}</div>}
    <dl className="capture-metadata">
      <div><dt>Actions</dt><dd>{plural(actionCount, 'action')}</dd></div>
      <div><dt>Clock uncertainty</dt><dd>{capture.clock.uncertaintyMs} ms</dd></div>
      {appStarted && <>
        <div><dt>App started</dt><dd>{new Date(appStarted.hostAlignedMs).toISOString().slice(11, 23)}</dd></div>
        <div><dt>Device monotonic</dt><dd>{appStarted.monotonicMs} ms</dd></div>
        {appStarted.route && <div><dt>Route</dt><dd>{appStarted.route}</dd></div>}
      </>}
    </dl>
    {(summary.error || summary.completenessWarnings.length > 0) && <ul className="capture-warnings">{summary.error && <li>{summary.error}</li>}{summary.completenessWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
    {project.createdByUid && test && <RecordingShare capture={capture} test={test} project={{ ...project, createdByUid: project.createdByUid }} onChanged={onChanged} onError={onError} />}
  </li>;
}

/** Explicit Pro sharing of one recording with its published test and a local attempt. */
function RecordingShare({ capture, test, project, onChanged, onError }: {
  capture: FlutterCapture;
  test: PatrolSavedTest;
  project: { id: string; organizationId: string; createdByUid: string };
  onChanged(): void;
  onError(message: string): void;
}) {
  const cloud = useCloud();
  const [attempt, setAttempt] = useState<PatrolAttempt | null>(null);
  const [includeRawAudio, setIncludeRawAudio] = useState(false);
  const [progress, setProgress] = useState(0);
  const [label, setLabel] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    let live = true;
    void window.sayspec!.listPatrolAttempts({ projectId: project.id, organizationId: project.organizationId, testId: test.id }).then((attempts) => {
      if (live) setAttempt([...attempts].reverse().find((item) => item.versionId === test.versionId && ['passed', 'failed', 'canceled', 'infrastructure-error'].includes(item.state)) ?? null);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [project.id, project.organizationId, test.id, test.versionId]);

  async function share() {
    if (!attempt || !cloud) return;
    const controller = new AbortController(); abortRef.current = controller; setLabel('Preparing explicit Pro share…');
    try {
      await shareFlutterSlice(cloud, { capture, version: test, attempt, createdByUid: project.createdByUid, includeRawAudio, signal: controller.signal, onProgress(value, next) { setProgress(value); setLabel(next); } });
      onChanged();
    } catch (reason) { onError(messageOf(reason)); }
    finally { abortRef.current = null; }
  }

  const shareState = capture.summary.shareState;
  return <div className="share-panel"><strong>Explicit Pro sharing</strong><p>{shareState === 'shared' ? 'This Flutter slice is shared. The run is labeled client-reported local execution.' : attempt ? 'Share the evidence, immutable Patrol source, runtime requirements and selected local attempt. Machine paths, credentials and device leases stay local.' : 'Replay the published version once from Runs before sharing an attempt receipt.'}</p><label className="sharing-choice"><input type="checkbox" checked={includeRawAudio} onChange={(event) => setIncludeRawAudio(event.target.checked)} /><span><strong>Include raw narration audio</strong><small>Off by default. Transcript and structured evidence are included either way.</small></span></label>{shareState === 'uploading' ? <><progress value={progress} max={1} aria-label="Flutter sharing progress" /><small>{label}</small><Button onClick={() => abortRef.current?.abort()}>Cancel upload</Button></> : shareState !== 'shared' && <Button variant="primary" disabled={!attempt} onClick={() => void share()}>Share Flutter slice</Button>}</div>;
}

/** Compact transcript preview, clamped to five lines until expanded. */
function NarratedExpectation({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  return <div className="narrated-expectation">
    <strong>Narrated expectation</strong>
    <p ref={ref} data-expanded={expanded}>{text}</p>
    {(overflowing || expanded) && <button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Read more…'}</button>}
  </div>;
}
