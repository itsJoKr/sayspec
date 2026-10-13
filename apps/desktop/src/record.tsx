import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LocalRecordingReview, LocalRecordingSummary, LocalSourceSelection, ReadinessReport,
  LocalTranscriptionSetup, PlanKind, RecordingControlSnapshot, RecordingEvent,
  RecordingSharingChoice, PlaywrightGenerationDraft,
} from '@sayspec/contracts';
import { Button, Field, StatusLabel } from './ui';
import { shareRecording } from './recording-share';
import { useCloud } from './cloud/context';
import { ClaudeTerminalPanel } from './claude-terminal';
import { FlutterRecordPanel } from './flutter-record';
import { GenerationPickers, RecordLayout, RecordingsSidebar, useCodingAgent } from './recordings-sidebar';
import { EntryPointSelect, useProjectEntryPoints } from './entry-points';
import { cloudTranscriptionScope, useNarrationChoice } from './narration-model-preference';

type RecordProject = { id: string; name: string; targetType: 'web' | 'flutter'; baseUrl?: string };
type CloudScope = { organizationId: string; createdByUid: string };

function messageOf(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error:\s*/, '') : 'Recording could not continue.';
}

function timeLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function audioMimeType() {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((value) => MediaRecorder.isTypeSupported(value)) ?? '';
}

export function RecordPage({ project, source, visible = true, onChooseSource, cloudScope, cloudTests = Boolean(cloudScope), cloudPlan }: {
  project?: RecordProject;
  source?: LocalSourceSelection;
  visible?: boolean;
  onChooseSource: (source: LocalSourceSelection) => void;
  cloudScope?: CloudScope;
  /** Whether generated tests are recorded in Firebase; false when the project stores tests in a folder. */
  cloudTests?: boolean;
  /** The cloud workspace's plan (null while loading); decides whether Gemini transcription is available. */
  cloudPlan?: PlanKind | null;
}) {
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [startUrl, setStartUrl] = useState('http://127.0.0.1:3000');
  const [sharingChoice, setSharingChoice] = useState<RecordingSharingChoice>('local-only');
  const [capture, setCapture] = useState<RecordingControlSnapshot | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [microphoneId, setMicrophoneId] = useState('');
  const [microphoneTesting, setMicrophoneTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [silence, setSilence] = useState(false);
  const [recordings, setRecordings] = useState<LocalRecordingSummary[]>([]);
  const [review, setReview] = useState<LocalRecordingReview | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioWritesRef = useRef<Promise<void>>(Promise.resolve());
  const levelCleanupRef = useRef<(() => void) | null>(null);
  const overlayRequestRef = useRef(false);

  const refreshRecordings = useCallback(async (selectId?: string) => {
    if (!project) return;
    const next = await window.sayspec!.listLocalRecordings({ projectId: project.id });
    setRecordings(next);
    if (selectId) setReview(await window.sayspec!.getLocalRecording({ projectId: project.id, recordingId: selectId }));
  }, [project]);

  useEffect(() => {
    setReadiness(null); setError(''); setCapture(null); setReview(null);
    void refreshRecordings();
  }, [project?.id, source?.handle, refreshRecordings]);

  const entryPoints = useProjectEntryPoints(project?.targetType === 'web' ? project.id : undefined, 'web')?.entryPoints ?? [];
  const [entryPointName, setEntryPointName] = useState('');
  const entryPoint = entryPoints.find((item) => item.name === entryPointName);
  useEffect(() => { setStartUrl(project?.baseUrl ?? 'http://127.0.0.1:3000'); }, [project?.id, project?.baseUrl]);
  // The first entry point is the default and supplies the starting URL; the URL stays editable.
  useEffect(() => {
    const next = entryPoints.find((item) => item.name === entryPointName) ?? entryPoints[0];
    setEntryPointName(next?.name ?? '');
    if (next?.url) setStartUrl(next.url);
  }, [entryPoints.map((item) => `${item.name}\t${item.url}`).join('\n')]);
  function chooseEntryPoint(name: string) {
    setEntryPointName(name);
    const next = entryPoints.find((item) => item.name === name);
    if (next?.url) setStartUrl(next.url);
  }

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const update = () => void navigator.mediaDevices.enumerateDevices().then((items) => setMicrophones(items.filter((item) => item.kind === 'audioinput'))).catch(() => undefined);
    update(); navigator.mediaDevices.addEventListener('devicechange', update);
    return () => navigator.mediaDevices.removeEventListener('devicechange', update);
  }, []);

  useEffect(() => {
    if (!capture || capture.recording.status !== 'recording') return;
    const started = Date.now() - capture.recording.durationMs;
    let previous = Date.now();
    const timer = window.setInterval(() => {
      const current = Date.now();
      if (current - previous > 5_000) setError('This Mac slept or paused for too long. Stop and review the partial recording before continuing.');
      previous = current; setElapsedMs(current - started);
    }, 250);
    return () => window.clearInterval(timer);
  }, [capture?.recording.id, capture?.recording.status]);

  useEffect(() => window.sayspec!.onRecordingLifecycle((event) => {
    if (event.recordingId !== capture?.recording.id || overlayRequestRef.current) return;
    void (async () => {
      overlayRequestRef.current = true;
      if (event.state === 'start-requested') {
        if (capture.recording.status === 'preparing') await beginCaptureFromOverlay();
        else if (capture.recording.status === 'paused') await resumeCapture();
      } else if (event.state === 'stop-requested') {
        await stopCapture();
      } else if (event.state === 'browser-closed') {
        await stopAudioSegment(); stopMicrophone(); setCapture(null);
        if (capture.recording.status === 'preparing') {
          await window.sayspec!.cancelRecording({ recordingId: event.recordingId });
        } else {
          const recovered = await window.sayspec!.interruptRecording({ recordingId: event.recordingId, reason: event.message ?? 'The recording browser was closed.' });
          setReview(recovered);
        }
        await refreshRecordings();
      }
    })().catch(async (reason) => {
      stopMicrophone(); setCapture(null); setError(messageOf(reason));
      await window.sayspec!.cancelRecording({ recordingId: event.recordingId }).catch(() => undefined);
      await refreshRecordings();
    }).finally(() => { overlayRequestRef.current = false; });
  }), [capture?.recording.id, capture?.recording.status, refreshRecordings]);

  useEffect(() => () => { stopMicrophone(); }, []);
  if (!project) return <RecordLayout sidebar={null}>{null}</RecordLayout>;

  async function chooseSource() {
    setError('');
    try { const next = await window.sayspec!.chooseSourceDirectory(); if (next) onChooseSource(next); }
    catch (reason) { setError(messageOf(reason)); }
  }

  async function checkSetup() {
    setChecking(true); setError('');
    try { setReadiness(await window.sayspec!.checkReadiness({ targetType: project!.targetType, task: 'record', sourceHandle: source?.handle })); }
    catch (reason) { setError(messageOf(reason)); }
    finally { setChecking(false); }
  }

  async function openWebBrowser() {
    setStarting(true); setError(''); setReview(null);
    if (microphoneTesting) { stopMicrophone(); setMicrophoneTesting(false); }
    try {
      const prepared = await window.sayspec!.startWebRecording({
        projectId: project!.id, projectName: project!.name, startUrl,
        sharingChoice, ...(cloudScope ?? {}),
      });
      setCapture(prepared); setElapsedMs(0);
    } catch (reason) {
      setError(messageOf(reason));
    } finally { setStarting(false); }
  }

  async function beginCaptureFromOverlay() {
    if (!capture) return;
    const stream = await openMicrophone();
    const next = await window.sayspec!.beginRecordingSegment({ recordingId: capture.recording.id });
    startAudioRecorder(stream, capture.recording.id, next.activeSegmentId!);
    setReview(null); setCapture(next); setElapsedMs(0);
  }

  async function openMicrophone() {
    const permission = await window.sayspec!.requestMicrophoneAccess();
    if (permission.state !== 'granted') throw new Error(permission.detail);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Audio recording is unavailable in this desktop build.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneId ? { deviceId: { exact: microphoneId } } : true, video: false });
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('No microphone input became available.');
    track.addEventListener('ended', () => { if (streamRef.current?.getTracks().includes(track)) setError('The microphone disconnected. Stop and review the partial recording.'); });
    streamRef.current = stream; startLevelMeter(stream);
    const devices = await navigator.mediaDevices.enumerateDevices(); setMicrophones(devices.filter((item) => item.kind === 'audioinput'));
    return stream;
  }

  async function toggleMicrophoneTest() {
    setError('');
    if (microphoneTesting) {
      stopMicrophone(); setMicrophoneTesting(false); return;
    }
    try {
      await openMicrophone(); setMicrophoneTesting(true);
    } catch (reason) {
      stopMicrophone(); setMicrophoneTesting(false); setError(messageOf(reason));
    }
  }

  function startLevelMeter(stream: MediaStream) {
    levelCleanupRef.current?.();
    const context = new AudioContext(); const analyser = context.createAnalyser(); const sourceNode = context.createMediaStreamSource(stream);
    analyser.fftSize = 256; sourceNode.connect(analyser); const samples = new Uint8Array(analyser.fftSize);
    let frame = 0; let quietSince = performance.now(); let stopped = false;
    const read = () => {
      if (stopped) return; analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
      setLevel(Math.min(1, rms * 6));
      if (rms > 0.012) { quietSince = performance.now(); setSilence(false); }
      else if (performance.now() - quietSince > 10_000) setSilence(true);
      frame = requestAnimationFrame(read);
    };
    read(); levelCleanupRef.current = () => { stopped = true; cancelAnimationFrame(frame); sourceNode.disconnect(); void context.close(); };
  }

  function startAudioRecorder(stream: MediaStream, recordingId: string, segmentId: string) {
    const mimeType = audioMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64_000 } : { audioBitsPerSecond: 64_000 });
    recorder.addEventListener('dataavailable', (event) => {
      if (!event.data.size) return;
      audioWritesRef.current = audioWritesRef.current.then(async () => {
        const bytes = new Uint8Array(await event.data.arrayBuffer());
        await window.sayspec!.appendRecordingAudio({ recordingId, segmentId, mimeType: event.data.type || mimeType || 'audio/webm', bytes });
      }).catch((reason) => {
        setError(messageOf(reason));
        void window.sayspec!.interruptRecording({ recordingId, reason: messageOf(reason) }).then((saved) => { setCapture(null); setReview(saved); void refreshRecordings(); });
      });
    });
    recorder.start(1_000); mediaRecorderRef.current = recorder;
  }

  async function stopAudioSegment() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') await new Promise<void>((resolve) => { recorder.addEventListener('stop', () => resolve(), { once: true }); recorder.stop(); });
    mediaRecorderRef.current = null; await audioWritesRef.current;
  }

  function stopMicrophone() {
    levelCleanupRef.current?.(); levelCleanupRef.current = null; setLevel(0); setSilence(false);
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }

  async function pauseCapture() {
    if (!capture) return;
    try { const next = await window.sayspec!.pauseRecording({ recordingId: capture.recording.id }); await stopAudioSegment(); setCapture(next); }
    catch (reason) { setError(messageOf(reason)); }
  }

  async function resumeCapture() {
    if (!capture || !streamRef.current) return;
    try { const next = await window.sayspec!.resumeRecording({ recordingId: capture.recording.id }); startAudioRecorder(streamRef.current, capture.recording.id, next.activeSegmentId!); setCapture(next); }
    catch (reason) { setError(messageOf(reason)); }
  }

  async function stopCapture() {
    if (!capture) return;
    try {
      if (capture.recording.status === 'recording') await window.sayspec!.pauseRecording({ recordingId: capture.recording.id });
      await stopAudioSegment();
      const result = await window.sayspec!.stopRecording({ recordingId: capture.recording.id });
      stopMicrophone(); setCapture(result.next ?? null); setReview(result.review); await refreshRecordings();
    } catch (reason) { setError(messageOf(reason)); }
  }

  async function cancelCapture() {
    if (!capture) return;
    try {
      if (capture.recording.status === 'recording') await window.sayspec!.pauseRecording({ recordingId: capture.recording.id });
      await stopAudioSegment(); await window.sayspec!.cancelRecording({ recordingId: capture.recording.id });
      stopMicrophone(); setCapture(null); await refreshRecordings();
    } catch (reason) { setError(messageOf(reason)); }
  }

  if (project.targetType !== 'web') return <FlutterRecordPanel project={{ ...project, organizationId: cloudScope?.organizationId ?? 'local', createdByUid: cloudScope?.createdByUid }} source={source} visible={visible} onChooseSource={onChooseSource} cloudPlan={cloudScope ? cloudPlan ?? null : undefined} />;

  const sidebar = <RecordingsSidebar
    items={recordings.map((item) => ({ id: item.id, title: item.title, meta: `${new Date(item.startedAt).toLocaleString()} · ${timeLabel(item.durationMs)}`, detail: item.status === 'interrupted' ? 'Recovered with warnings' : `${item.eventCount} actions · ${item.shareState === 'shared' ? 'Shared' : 'Local'}` }))}
    selectedId={review?.id}
    onSelect={(id) => void window.sayspec!.getLocalRecording({ projectId: project.id, recordingId: id }).then(setReview).catch((reason) => setError(messageOf(reason)))}
    onNew={() => setReview(null)}
    live={review && capture ? (capture.recording.status === 'preparing' ? 'Browser ready' : capture.recording.status === 'paused' ? 'Paused' : 'Recording') : undefined}
  />;
  return <RecordLayout sidebar={sidebar}>
    <section className="record-console" {...(review ? { 'aria-labelledby': 'record-start-title' } : { 'aria-label': 'Record a test' })}>
      {(review || capture) && <div className="record-console__head">{review && <h2 id="record-start-title">Review recording</h2>}{capture && <StatusLabel status={capture.recording.status === 'recording' ? 'running' : 'warning'}>{capture.recording.status === 'preparing' ? 'Browser ready' : capture.recording.status}</StatusLabel>}</div>}
      {review ? <RecordingReview review={review} cloudScope={cloudScope} cloudTests={cloudTests} cloudPlan={cloudScope ? cloudPlan ?? null : undefined} onBack={() => setReview(null)} onDiscard={async () => { await window.sayspec!.cancelRecording({ recordingId: review.id }); setReview(null); await refreshRecordings(); }} /> : capture ? <div className="capture-console" data-testid="capture-console">
        <div className="capture-clock"><span className={capture.recording.status === 'recording' ? 'capture-dot' : 'capture-dot capture-dot--paused'} aria-hidden="true" /><strong>{timeLabel(elapsedMs)}</strong><span>{capture.recording.status === 'preparing' ? 'Browser ready. Click Record in the SaySpec overlay on your webpage.' : capture.recording.status === 'paused' ? 'Capture paused' : 'Actions and narration are being saved locally.'}</span></div>
        {capture.recording.status === 'recording' && <div className="audio-level" aria-label={`Microphone level ${Math.round(level * 100)} percent`}><i style={{ width: `${Math.max(2, level * 100)}%` }} /></div>}
        {silence && <p className="capture-warning" role="status">No microphone signal detected. Check the selected input before continuing.</p>}
        <div className="record-actions">
          {capture.recording.status === 'recording' ? <Button onClick={() => void pauseCapture()}>Pause</Button>
            : capture.recording.status === 'paused' ? <Button variant="primary" onClick={() => void resumeCapture()}>Resume</Button> : null}
          {capture.recording.status !== 'preparing' && <Button variant="primary" data-testid="stop-recording" onClick={() => void stopCapture()}>Stop & review</Button>}
          <Button variant="quiet" data-testid="cancel-recording" onClick={() => void cancelCapture()}>Cancel</Button>
        </div>
      </div> : <div className="capture-setup">
            {entryPoints.length > 0 && <EntryPointSelect entryPoints={entryPoints} value={entryPointName} onChange={chooseEntryPoint} fallback="" />}
            <Field label="Starting URL" name="recording-url" value={startUrl} onChange={(event) => setStartUrl(event.target.value)} hint={entryPoint?.command && entryPoint.url === startUrl ? `If the app is not running yet, start it from the project with: ${entryPoint.command}` : undefined} />
            <div className="microphone-setup">
              <label className="select-field" htmlFor="field-microphone">Microphone<select id="field-microphone" value={microphoneId} onChange={(event) => { if (microphoneTesting) { stopMicrophone(); setMicrophoneTesting(false); } setMicrophoneId(event.target.value); }}><option value="">Default microphone</option>{microphones.filter((item) => item.deviceId !== 'default').map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || `Microphone ${index + 1}`}</option>)}</select></label>
              <div className="microphone-test">
                <Button type="button" onClick={() => void toggleMicrophoneTest()} aria-pressed={microphoneTesting}>{microphoneTesting ? 'Stop microphone test' : 'Test microphone'}</Button>
                {microphoneTesting && <><div className="audio-level microphone-test__meter" aria-label={`Microphone test level ${Math.round(level * 100)} percent`}><i style={{ width: `${Math.max(2, level * 100)}%` }} /></div><span className="microphone-test__status">{level > 0.02 ? 'Microphone input detected.' : 'Speak to test your microphone.'}</span></>}
              </div>
            </div>
            {cloudScope && <label className="sharing-choice"><input type="checkbox" checked={sharingChoice === 'share-after-review'} onChange={(event) => setSharingChoice(event.target.checked ? 'share-after-review' : 'local-only')} /><span><strong>Offer cloud sharing after review</strong><small>Evidence remains on this Mac unless you explicitly share it.</small></span></label>}
            <div className="record-start"><Button variant="primary" data-testid="open-recording-browser" onClick={() => void openWebBrowser()} disabled={starting}>{starting ? 'Opening…' : 'Open testing browser'}</Button><p className="control-help">Start recording in the browser, then walk through your test and narrate what should happen.</p></div>
          </div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {readiness && !readiness.ready && <ul className="readiness-list">{readiness.items.filter((item) => item.state !== 'ready').map((item) => <li key={item.id}><strong>{item.label}</strong><span>{item.detail} {item.recovery}</span></li>)}</ul>}
    </section>
  </RecordLayout>;
}

function RecordingReview({ review: initialReview, cloudScope, cloudTests, cloudPlan, onBack, onDiscard }: { review: LocalRecordingReview; cloudScope?: CloudScope; cloudTests: boolean; cloudPlan?: PlanKind | null; onBack: () => void; onDiscard: () => Promise<void> }) {
  const cloud = useCloud();
  const [review, setReview] = useState(initialReview);
  const [selected, setSelected] = useState<RecordingEvent | null>(review.manifest.events[0] ?? null);
  const [audioUrl, setAudioUrl] = useState(''); const [imageUrl, setImageUrl] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);
  const shareAbortRef = useRef<AbortController | null>(null);
  const [shareState, setShareState] = useState(review.shareState);
  const [shareProgress, setShareProgress] = useState(0);
  const [shareLabel, setShareLabel] = useState('');
  const [shareError, setShareError] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [reviewTab, setReviewTab] = useState<'recording' | 'claude'>('recording');
  const [claudeMode, setClaudeMode] = useState<'inspect' | 'prepare' | 'generate'>('inspect');
  const [generationStatus, setGenerationStatus] = useState('');
  const [transcriptionSetup, setTranscriptionSetup] = useState<LocalTranscriptionSetup | null>(null);
  const [transcriptionProgress, setTranscriptionProgress] = useState({ value: 0, message: '' });
  const [transcriptionError, setTranscriptionError] = useState('');
  const segment = selected ? review.manifest.segments.find((item) => item.id === selected.segmentId) : review.manifest.segments[0];

  useEffect(() => { setReview(initialReview); }, [initialReview]);
  useEffect(() => { setReviewTab('recording'); setClaudeMode('inspect'); setGenerationStatus(''); }, [initialReview.id]);
  useEffect(() => { void window.sayspec!.getLocalTranscriptionSetup().then(setTranscriptionSetup).catch((error) => setTranscriptionError(messageOf(error))); }, []);
  useEffect(() => window.sayspec!.onLocalTranscriptionLifecycle((event) => {
    if (event.kind === 'model' && event.state !== 'downloading') void window.sayspec!.getLocalTranscriptionSetup().then(setTranscriptionSetup);
    if (event.recordingId === review.id) {
      setTranscriptionProgress({ value: event.progress, message: event.message });
      if (event.state !== 'running') void window.sayspec!.getLocalRecording({ projectId: review.projectId, recordingId: review.id }).then(setReview);
    }
  }), [review.id, review.projectId]);

  useEffect(() => {
    let disposed = false; let nextAudio = ''; let nextImage = '';
    void (async () => {
      if (segment?.audioArtifactId) {
        const asset = await window.sayspec!.readRecordingAsset({ recordingId: review.id, artifactId: segment.audioArtifactId });
        const copy = new Uint8Array(asset.bytes.byteLength); copy.set(asset.bytes);
        nextAudio = URL.createObjectURL(new Blob([copy.buffer], { type: asset.mimeType })); if (!disposed) setAudioUrl(nextAudio);
      } else setAudioUrl('');
      const screenshotId = selected?.evidenceArtifactIds.find((id) => review.manifest.artifacts.find((item) => item.id === id)?.mimeType === 'image/png');
      if (screenshotId) {
        const asset = await window.sayspec!.readRecordingAsset({ recordingId: review.id, artifactId: screenshotId });
        const copy = new Uint8Array(asset.bytes.byteLength); copy.set(asset.bytes);
        nextImage = URL.createObjectURL(new Blob([copy.buffer], { type: asset.mimeType })); if (!disposed) setImageUrl(nextImage);
      } else setImageUrl('');
    })();
    return () => { disposed = true; if (nextAudio) URL.revokeObjectURL(nextAudio); if (nextImage) URL.revokeObjectURL(nextImage); };
  }, [review.id, selected?.id, segment?.audioArtifactId]);

  useEffect(() => {
    if (!audioUrl || !selected || !segment || !audioRef.current) return;
    const seek = () => { if (audioRef.current) audioRef.current.currentTime = Math.max(0, (selected.elapsedMs - segment.startMs) / 1000); };
    if (audioRef.current.readyState >= 1) seek(); else audioRef.current.addEventListener('loadedmetadata', seek, { once: true });
  }, [audioUrl, selected?.id, segment?.startMs]);

  useEffect(() => () => shareAbortRef.current?.abort(), []);

  async function share() {
    if (!cloudScope || !cloud) return;
    const controller = new AbortController(); shareAbortRef.current = controller;
    setShareState('uploading'); setShareError('');
    try {
      await shareRecording(cloud, review, { ...cloudScope, projectId: review.projectId }, controller.signal, (value, label) => { setShareProgress(value); setShareLabel(label); });
      setShareState('shared');
    } catch (error) { setShareState('failed'); setShareError(messageOf(error)); }
    finally { shareAbortRef.current = null; }
  }

  return <div className="recording-review" data-testid="recording-review">
    <div className="review-summary"><div className="review-actions"><Button variant="quiet" onClick={onBack}>← Recording session</Button><Button variant="quiet" onClick={() => confirmDiscard ? void onDiscard() : setConfirmDiscard(true)}>{confirmDiscard ? 'Confirm discard' : 'Discard recording'}</Button></div><div><strong>{review.eventCount} captured actions</strong><span>{timeLabel(review.durationMs)} · {review.manifest.segments.length} audio {review.manifest.segments.length === 1 ? 'segment' : 'segments'} · {review.shareState === 'shared' ? 'Shared' : 'Local only'}</span></div></div>
    <div className="review-tabs" role="tablist" aria-label="Recording review views"><button role="tab" aria-selected={reviewTab === 'recording'} onClick={() => setReviewTab('recording')}>Recording</button><button role="tab" aria-selected={reviewTab === 'claude'} onClick={() => setReviewTab('claude')}>AI</button></div>
    <div hidden={reviewTab !== 'claude'} role="tabpanel"><ClaudeTerminalPanel recordingId={review.id} active={reviewTab === 'claude'} mode={claudeMode} preparationStatus={generationStatus} /></div>
    <div hidden={reviewTab !== 'recording'} role="tabpanel" className="recording-review__recording">
    {review.completenessWarnings.length > 0 && <div className="review-warnings" role="status"><strong>Review these gaps</strong>{review.completenessWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
    <div className="review-grid"><div className="timeline" aria-label="Captured action timeline">{review.manifest.events.length ? review.manifest.events.map((event) => { const eventSegment = review.manifest.segments.find((item) => item.id === event.segmentId); return <button key={event.id} data-selected={selected?.id === event.id} aria-pressed={selected?.id === event.id} data-audio-offset-ms={eventSegment ? Math.max(0, event.elapsedMs - eventSegment.startMs) : undefined} onClick={() => setSelected(event)}><time>{timeLabel(event.elapsedMs)}</time><span><strong>{event.action}</strong>{event.targetDescription}<small>{event.value ? `Value: ${event.value}` : event.action === 'input' ? 'Sensitive value omitted' : event.frameUrl}</small></span></button>; }) : <p>No browser actions were captured.</p>}</div><div className="evidence-viewer">{imageUrl ? <img src={imageUrl} alt={`Screenshot for ${selected?.targetDescription ?? 'selected action'}`} /> : <div className="evidence-missing">No screenshot for this action.</div>}{audioUrl ? <audio ref={audioRef} controls src={audioUrl} /> : <p>No audio is available for this segment.</p>}</div></div>
    <section className="transcription-panel" aria-label="Generate test from recording">
      <GenerationPanel review={review} cloudScope={cloudTests ? cloudScope : undefined} transcriptionOrganizationId={cloudScope?.organizationId} cloudPlan={cloudPlan} onReview={setReview} onGenerationStart={() => { setClaudeMode('prepare'); setReviewTab('claude'); }} onLaunchClaude={() => setClaudeMode('generate')} onStatusChange={setGenerationStatus} transcriptionSetup={transcriptionSetup} transcriptionProgress={transcriptionProgress} />
      {transcriptionSetup?.model.error && transcriptionSetup.model.state !== 'installed' && <p className="inline-error" role="alert">{transcriptionSetup.model.error}</p>}
      {transcriptionError && <p className="inline-error" role="alert">{transcriptionError}</p>}
    </section>
    {cloudScope && review.sharingChoice === 'share-after-review' && <div className="share-panel"><strong>Cloud sharing is opt-in</strong><p>{shareState === 'shared' ? 'The validated evidence package is shared with this Pro project.' : 'This recording is still local. Choose Share only after checking its narration and screenshots.'}</p>{shareState === 'uploading' ? <><progress value={shareProgress} max={1} aria-label="Cloud sharing progress" /><small>{shareLabel}</small><Button onClick={() => shareAbortRef.current?.abort()}>Cancel upload</Button></> : shareState !== 'shared' && <Button variant="primary" onClick={() => void share()}>Share with Pro workspace</Button>}{shareError && <span className="inline-error" role="alert">{shareError}</span>}</div>}
    </div>
  </div>;
}

function GenerationPanel({ review, cloudScope, transcriptionOrganizationId, cloudPlan, onReview, onGenerationStart, onLaunchClaude, onStatusChange, transcriptionSetup, transcriptionProgress }: { review: LocalRecordingReview; cloudScope?: CloudScope; transcriptionOrganizationId?: string; cloudPlan?: PlanKind | null; onReview: (review: LocalRecordingReview) => void; onGenerationStart: () => void; onLaunchClaude: () => void; onStatusChange: (status: string) => void; transcriptionSetup: LocalTranscriptionSetup | null; transcriptionProgress: { value: number; message: string } }) {
  const cloud = useCloud();
  const agent = useCodingAgent();
  const narration = useNarrationChoice(cloudPlan);
  // Gemini needs the cloud workspace that owns this project; guest projects transcribe locally.
  const geminiOrganizationId = narration.engine === 'cloud' ? transcriptionOrganizationId : undefined;
  const agentProvider = agent.provider; const agentName = agent.name;
  const [busy, setBusy] = useState(review.generationDraft?.state === 'generating');
  const [progress, setProgress] = useState(''); const [error, setError] = useState('');
  const stageRef = useRef<'model' | 'transcription' | null>(null);
  const lastModelPercentRef = useRef<number | null>(null);
  const canceledRef = useRef(false);
  const draft = review.generationDraft;
  useEffect(() => window.sayspec!.onPlaywrightGenerationLifecycle((event) => {
    if (event.recordingId !== review.id) return;
    setProgress(event.message);
    if (event.state !== 'generating') void window.sayspec!.getLocalRecording({ projectId: review.projectId, recordingId: review.id }).then(async (updated) => {
      onReview(updated);
      if (event.state === 'draft' && updated.generationDraft?.provenance.executionValidated && cloudScope) {
        try { await persistCloudDraft(updated.generationDraft); } catch (reason) { setError(messageOf(reason)); }
      }
    });
  }), [review.id, review.projectId, onReview, cloudScope]);
  useEffect(() => window.sayspec!.onLocalTranscriptionLifecycle((event) => {
    if (stageRef.current !== 'model' || event.kind !== 'model') return;
    const percent = Math.round(event.progress * 100);
    if (event.state === 'downloading' && lastModelPercentRef.current === percent) return;
    lastModelPercentRef.current = event.state === 'downloading' ? percent : null;
    onStatusChange(event.state === 'downloading' && event.progress > 0
      ? `Downloading local transcription model… ${percent}%`
      : event.message);
  }), [onStatusChange]);
  useEffect(() => {
    if (stageRef.current === 'transcription' && transcriptionProgress.message) onStatusChange(transcriptionProgress.message);
  }, [transcriptionProgress, onStatusChange]);
  async function generate() {
    if (!agentProvider) { setError('Choose Claude Code or Codex next to Generate tests.'); return; }
    if (!geminiOrganizationId && (!transcriptionSetup || transcriptionSetup.runtime.state !== 'ready')) { setError('Local transcription is not ready. Check Narration under Settings.'); return; }
    onGenerationStart(); onStatusChange('Preparing recording evidence…');
    setBusy(true); setError(''); canceledRef.current = false;
    try {
      if (!geminiOrganizationId && transcriptionSetup!.model.state !== 'installed') {
        stageRef.current = 'model'; setProgress('Downloading the local narration model…');
        onStatusChange('Downloading local transcription model…');
        const installed = await window.sayspec!.installLocalTranscriptionModel({ modelId: transcriptionSetup!.model.id });
        if (installed.model.state !== 'installed' || canceledRef.current) throw new Error('Model download did not complete.');
      }
      // Choosing Gemini replaces a Whisper transcript (for example the automatic one after stopping).
      if (review.transcript?.status !== 'ready' || (geminiOrganizationId && review.transcript.provider.kind !== 'cloud')) {
        stageRef.current = 'transcription';
        setProgress(geminiOrganizationId ? 'Transcribing the saved narration with Gemini…' : 'Transcribing the saved narration on this device…');
        onStatusChange(geminiOrganizationId ? 'Transcribing narration with Gemini in SaySpec Cloud…' : 'Transcribing narration on this device…');
        const transcript = await window.sayspec!.transcribeRecording({ recordingId: review.id, ...(geminiOrganizationId ? { cloud: await cloudTranscriptionScope(cloud, geminiOrganizationId, review.projectId) } : {}) });
        if (transcript.status !== 'ready' || canceledRef.current) throw new Error(transcript.error ?? 'Transcription did not complete.');
        if (!transcript.segments.length) throw new Error('No speech was detected. Narrate what the test should verify, then record again.');
      }
      onStatusChange(`Starting ${agentName}…`);
      onLaunchClaude();
      setProgress(`${agentName} is running in the terminal.`);
    } catch (reason) { setError(messageOf(reason)); onStatusChange(canceledRef.current ? 'Canceled' : 'Generation failed'); }
    finally { stageRef.current = null; setBusy(false); }
  }
  async function cancel() {
    canceledRef.current = true;
    if (stageRef.current === 'model') await window.sayspec!.cancelLocalTranscriptionModelInstall();
    if (stageRef.current === 'transcription') await window.sayspec!.cancelRecordingTranscription({ recordingId: review.id });
    setProgress('Canceled.');
  }
  async function persistCloudDraft(generated: PlaywrightGenerationDraft) {
    if (!cloud || !cloudScope) return;
    const scope = { organizationId: cloudScope.organizationId, projectId: review.projectId };
    const testId = `test_${review.id.replace(/^recording_/, '').replaceAll('-', '_')}`;
    await cloud.tests.saveDraft({
      ...scope, testId, title: generated.title, folder: 'Generated tests', tags: ['recording'],
      intent: {
        prerequisites: generated.runtime.requirements,
        steps: generated.steps.map((step) => ({ action: step.instruction, target: '', expectedOutcome: step.assertion, evidenceIds: step.evidenceEventIds })),
        unresolvedQuestions: generated.unresolvedQuestions,
      }, generation: generated,
    });
    const suiteId = `suite_${review.id.replace(/^recording_/, '').replaceAll('-', '_')}`;
    const suite = await cloud.tests.readSuite({ ...scope, suiteId });
    const suiteTestIds = suite?.testIds ?? [];
    const storedSuiteName = suite?.name.trim() ? suite.name : '';
    await cloud.tests.saveSuite({
      ...scope,
      suiteId,
      expectedRevision: suite?.revision ?? 0,
      name: storedSuiteName.startsWith('Recorded · ') ? 'Just Recorded' : storedSuiteName || 'Just Recorded',
      testIds: [...new Set([...suiteTestIds, testId])],
      sourceRecordingId: review.id,
    });
    setProgress('✅ Test generated → Go to Tests tab');
  }
  return <section className="generation-panel" aria-labelledby="playwright-generation-title" data-testid="playwright-generation">
    <h3 id="playwright-generation-title">Generate test</h3>
    {!geminiOrganizationId && transcriptionSetup && transcriptionSetup.runtime.state !== 'ready' && <p className="inline-error" role="status">{transcriptionSetup.runtime.detail}</p>}
    <div className="transcript-actions"><GenerationPickers setup={transcriptionSetup} narration={narration} agent={agent} disabled={busy} /><Button variant="primary" onClick={() => void generate()} disabled={busy || (!geminiOrganizationId && transcriptionSetup?.runtime.state !== 'ready')}>{busy ? 'Preparing…' : draft?.state === 'draft' ? 'Generate again' : 'Generate tests'}</Button>{busy && <Button onClick={() => void cancel()}>Cancel</Button>}<span>{progress || (review.transcript?.status === 'running' ? transcriptionProgress.message || 'Transcribing locally…' : '')}</span></div>
    {agent.notice && <p className="control-help" role="status">{agent.notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
