import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { FlutterDeviceSummary, LocalSourceSelection, PatrolAttempt, PatrolRun, PatrolRunAnalysisEvent, PatrolSavedTest } from '@sayspec/contracts';
import { RecordLayout, RecordingsSidebar } from './recordings-sidebar';
import { Button, StatePanel } from './ui';
import { DeviceSelect } from './device-select';

const messageOf = (error: unknown) => (error instanceof Error ? error.message.replace(/^Error:\s*/, '') : String(error));
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

type ItemState = PatrolAttempt['state'] | 'waiting' | 'not-run';

function defaultRunName() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `Run ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** Time the test itself took on the device; the shared build is not part of it. */
function duration(attempt: PatrolAttempt) {
  const milliseconds = attempt.tests.reduce((total, test) => total + test.durationMs, 0);
  if (!attempt.finishedAt || !milliseconds) return '';
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Attempts of one run item, newest first, and the state it has in the run's latest start. */
function itemProgress(run: PatrolRun, attempts: readonly PatrolAttempt[], testId: string) {
  const history = attempts.filter((attempt) => attempt.runId === run.id && attempt.testId === testId).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const current = run.startedAt ? history.find((attempt) => attempt.startedAt >= run.startedAt!) : undefined;
  const state: ItemState = current?.state
    ?? (run.state === 'running' ? (run.activeTestId === testId ? 'preparing' : 'waiting') : 'not-run');
  return { history, current, state };
}

function runCounts(run: PatrolRun, attempts: readonly PatrolAttempt[]) {
  const states = run.items.map((item) => itemProgress(run, attempts, item.testId).state);
  return {
    total: states.length,
    done: states.filter((state) => !['waiting', 'not-run', 'queued', 'preparing', 'building', 'running'].includes(state)).length,
    passed: states.filter((state) => state === 'passed').length,
    failed: states.filter((state) => state === 'failed' || state === 'infrastructure-error').length,
    blocked: states.filter((state) => state === 'blocked').length,
    notRun: states.filter((state) => state === 'canceled' || state === 'not-run' || state === 'waiting').length,
  };
}

/** Run-level badge: Not run, Running n/N, Stopped, Interrupted, then pass/fail counts. */
function RunStatus({ run, attempts }: { run: PatrolRun; attempts: readonly PatrolAttempt[] }) {
  const counts = runCounts(run, attempts);
  if (run.state === 'queued') return <span className="run-status run-status--not-run">Not run</span>;
  if (run.state === 'running') return <span className="run-status run-status--running"><span aria-hidden="true">↻</span>Running {counts.done}/{run.items.length}</span>;
  return <span className="run-statuses" aria-label={`${run.state === 'canceled' ? 'Stopped' : run.state === 'interrupted' ? 'Interrupted' : 'Finished'}: ${counts.passed} passed, ${counts.failed} failed, ${counts.blocked} blocked, ${counts.notRun} not run`}>
    {run.state === 'canceled' && <span className="run-status run-status--canceled">Stopped</span>}
    {run.state === 'interrupted' && <span className="run-status run-status--failed">Interrupted</span>}
    {counts.passed > 0 && <span className="run-status run-status--passed"><span aria-hidden="true">✓</span>{counts.passed} passed</span>}
    {counts.failed > 0 && <span className="run-status run-status--failed"><span aria-hidden="true">×</span>{counts.failed} failed</span>}
    {counts.blocked > 0 && <span className="run-status run-status--blocked">{counts.blocked} blocked</span>}
    {run.state === 'finished' && counts.notRun > 0 && <span className="run-status run-status--not-run">{counts.notRun} not run</span>}
  </span>;
}

function ItemStatus({ state }: { state: ItemState }) {
  if (state === 'passed') return <span className="run-status run-status--passed"><span aria-hidden="true">✓</span>Passed</span>;
  if (state === 'failed') return <span className="run-status run-status--failed"><span aria-hidden="true">×</span>Failed</span>;
  if (state === 'infrastructure-error') return <span className="run-status run-status--failed"><span aria-hidden="true">×</span>Could not run</span>;
  if (state === 'blocked') return <span className="run-status run-status--blocked">Blocked</span>;
  if (state === 'canceled') return <span className="run-status run-status--canceled">Stopped</span>;
  if (state === 'building') return <span className="run-status run-status--running"><span aria-hidden="true">↻</span>Building</span>;
  if (state === 'queued') return <span className="run-status run-status--not-run">Waiting</span>;
  if (state === 'preparing' || state === 'running') return <span className="run-status run-status--running"><span aria-hidden="true">↻</span>Running</span>;
  if (state === 'waiting') return <span className="run-status run-status--not-run">Waiting</span>;
  return <span className="run-status run-status--not-run">Not run</span>;
}

/**
 * Runs saved Patrol tests on a leased Android device or iOS simulator, as named test runs.
 *
 * Mirrors Record: the content area shows a new run or the selected run, and a
 * full-height sidebar lists the project's runs with their status. A run
 * freezes its tests' versions when it is created; starting it builds the app
 * once and runs every test on the chosen device. Each test shows only its
 * result and its log. When a test fails, the coding agent starts analyzing the
 * run in a second tab, and its HTML report opens in the
 * browser once written.
 *
 * Tests selected in the library arrive as `queuedTestIds` and preselect a new run.
 */
export function PatrolRuns({ projectId, organizationId, queuedTestIds = [], source, onChooseSource }: {
  projectId: string;
  queuedTestIds?: string[];
  organizationId: string;
  source?: LocalSourceSelection;
  onChooseSource: (source: LocalSourceSelection) => void;
}) {
  const [tests, setTests] = useState<PatrolSavedTest[]>([]);
  const [devices, setDevices] = useState<FlutterDeviceSummary[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [runs, setRuns] = useState<PatrolRun[]>([]);
  const [attempts, setAttempts] = useState<PatrolAttempt[]>([]);
  const [loaded, setLoaded] = useState(false);
  // '' is the New run view.
  const [runId, setRunId] = useState<string | undefined>(queuedTestIds.length ? '' : undefined);
  const [name, setName] = useState(defaultRunName);
  const [picked, setPicked] = useState<string[]>(queuedTestIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'results' | 'analysis'>('results');
  const [log, setLog] = useState<{ title: string; attemptId?: string }>();

  async function refreshSetup() {
    try {
      const [nextTests, nextDevices] = await Promise.all([window.sayspec!.listPatrolTests({ projectId, organizationId }), window.sayspec!.listFlutterDevices()]);
      setTests(nextTests); setDevices(nextDevices);
      setDeviceId((current) => nextDevices.some((device) => device.id === current && device.state === 'ready') ? current : nextDevices.find((device) => device.state === 'ready')?.id ?? '');
    } catch (reason) { setError(messageOf(reason)); }
  }

  useEffect(() => { void refreshSetup(); }, [projectId, organizationId]);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const next = await window.sayspec!.listPatrolRuns({ organizationId, projectId });
        if (!live) return;
        setRuns(next.runs); setAttempts(next.attempts); setLoaded(true);
        // Opens the latest run unless the New view was chosen.
        setRunId((current) => current === undefined || (current && !next.runs.some((run) => run.id === current)) ? next.runs.at(-1)?.id ?? '' : current);
      } catch (reason) { if (live) setError(messageOf(reason)); }
    };
    void poll(); const interval = setInterval(() => void poll(), 1500);
    return () => { live = false; clearInterval(interval); };
  }, [organizationId, projectId]);

  const selectedRun = runs.find((run) => run.id === runId);
  const runningElsewhere = runs.find((run) => run.state === 'running' && run.id !== selectedRun?.id && run.deviceId === deviceId);

  function openNew() { setRunId(''); setName(defaultRunName()); setPicked([]); setError(''); }
  function openRun(id: string) { setRunId(id); setError(''); setTab('results'); }

  async function act(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }
  const create = () => act(async () => {
    const ordered = tests.filter((test) => picked.includes(test.id)).map((test) => test.id);
    const run = await window.sayspec!.createPatrolRun({ organizationId, projectId, testIds: ordered, name });
    setRuns((previous) => [...previous, run]); setRunId(run.id);
  });
  const start = (run: PatrolRun) => act(async () => {
    if (!source) throw new Error('Choose the Flutter project folder so the saved tests can be materialized and built.');
    if (!deviceId) throw new Error('Choose a device that is ready.');
    const started = await window.sayspec!.startPatrolRun({ organizationId, projectId, runId: run.id, deviceId, sourceHandle: source.handle });
    setRuns((previous) => previous.map((item) => item.id === started.id ? started : item));
    setTab('results');
  });
  const analyzeAgain = (run: PatrolRun) => act(async () => {
    if (!source) throw new Error('Choose the Flutter project folder so the analysis can read the app source.');
    const updated = await window.sayspec!.restartPatrolRunAnalysis({ organizationId, projectId, runId: run.id, sourceHandle: source.handle });
    setRuns((previous) => previous.map((item) => item.id === updated.id ? updated : item));
    setTab('analysis');
  });
  const openReport = (run: PatrolRun) => act(() => window.sayspec!.openPatrolRunReport({ organizationId, projectId, runId: run.id }));
  const stop = (run: PatrolRun) => act(async () => {
    const stopped = await window.sayspec!.stopPatrolRun({ organizationId, projectId, runId: run.id });
    setRuns((previous) => previous.map((item) => item.id === stopped.id ? stopped : item));
  });
  const remove = (run: PatrolRun) => act(async () => {
    await window.sayspec!.deletePatrolRun({ organizationId, projectId, runId: run.id });
    const rest = runs.filter((item) => item.id !== run.id);
    setRuns(rest); setRunId(rest.at(-1)?.id ?? '');
  });

  const sidebar = <RecordingsSidebar
    title="Test runs"
    newLabel="New test run"
    empty="Create a run to execute saved Patrol tests together on a device."
    items={[...runs].reverse().map((run) => ({
      id: run.id,
      title: run.name,
      meta: `${plural(run.items.length, 'test')} · ${new Date(run.startedAt ?? run.createdAt).toLocaleString()}`,
      ...(run.deviceName ? { detail: run.deviceName } : {}),
      status: <RunStatus run={run} attempts={attempts} />,
    }))}
    selectedId={runId || undefined}
    onSelect={openRun}
    onNew={openNew}
  />;

  const messages = error && <p className="inline-error" role="alert">{error}</p>;
  const sourceCallout = !source && <p className="setup-callout" role="note">Choose the Flutter project folder so SaySpec can materialize and build the saved tests. <Button onClick={() => void window.sayspec!.chooseSourceDirectory().then((next) => next && onChooseSource(next)).catch((reason) => setError(messageOf(reason)))}>Choose source folder</Button></p>;

  if (!loaded) return <RecordLayout title="Runs" sidebar={sidebar}>{messages}</RecordLayout>;

  if (!selectedRun) {
    const allPicked = tests.length > 0 && tests.every((test) => picked.includes(test.id));
    return <RecordLayout title="Runs" sidebar={sidebar}>
      <section className="patrol-runs" aria-label="New test run">
        {tests.length === 0 ? <StatePanel tone="empty" title="No saved Patrol tests yet">Record a Flutter flow, then generate and save a Patrol test. Saved tests run here unchanged.</StatePanel> : <div className="patrol-new-run">
          <h2>New test run</h2>
          <label className="field">Run name<input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
          <fieldset className="patrol-run-picker">
            <legend>Tests <span>{picked.length} of {tests.length} selected</span></legend>
            <div className="patrol-run-picker__list"><label className="patrol-run-picker__all"><input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? [] : tests.map((test) => test.id))} />Select all</label>
            {tests.map((test) => <label key={test.id}>
              <input type="checkbox" checked={picked.includes(test.id)} onChange={(event) => setPicked((previous) => event.target.checked ? [...previous, test.id] : previous.filter((id) => id !== test.id))} />
              <span><strong>{test.title}</strong><small>v{test.version} · {test.relativePath}</small></span>
            </label>)}</div>
          </fieldset>
          <p className="control-help">Each test runs at its latest saved version, frozen when the run is created. The app is built once and every test runs on the device you choose when you start it.</p>
          <div className="patrol-run-actions"><Button variant="primary" data-testid="create-patrol-run" disabled={busy || !picked.length || !name.trim()} onClick={() => void create()}>Create run{picked.length ? ` (${picked.length})` : ''}</Button></div>
        </div>}
        {messages}
      </section>
    </RecordLayout>;
  }

  const run = selectedRun;
  const running = run.state === 'running';
  const counts = runCounts(run, attempts);
  const analysis = run.analysis;
  const hasRunLog = Boolean(run.artifacts?.some((artifact) => artifact.relativePath === 'patrol-run.log'));
  const canAnalyze = !running && run.state !== 'queued' && counts.failed > 0 && analysis?.state !== 'running' && analysis?.state !== 'ready';
  const agent = analysis?.provider === 'codex' ? 'Codex' : 'Claude';
  const shownTab = analysis ? tab : 'results';
  return <RecordLayout title="Runs" sidebar={sidebar}>
    <section className="patrol-runs" aria-label={`${run.name} details`}>
      <header className="patrol-run-header">
        <div><h2>{run.name}</h2><p>{plural(run.items.length, 'test')} · created {new Date(run.createdAt).toLocaleString()}{run.finishedAt ? ` · finished ${new Date(run.finishedAt).toLocaleString()}` : ''}{run.deviceName ? ` · ${run.deviceName}` : ''}</p></div>
        <RunStatus run={run} attempts={attempts} />
      </header>
      <div className="patrol-run-controls">
        <DeviceSelect label="Device" ariaLabel="Patrol device" platforms={['android', 'ios']} disabled={running}
          devices={devices} value={deviceId} onChange={setDeviceId}
          onStarted={async (device) => { await refreshSetup(); setDeviceId(device.id); }} />
        <div className="patrol-run-actions">
          {running
            ? <Button variant="primary" data-testid="stop-patrol-run" disabled={busy} onClick={() => void stop(run)}>Stop</Button>
            : <Button variant="primary" data-testid="run-patrol-run" disabled={busy || !deviceId || !source || Boolean(runningElsewhere)} onClick={() => void start(run)}>{run.state === 'queued' ? 'Run' : 'Run again'}</Button>}
          {!running && <Button onClick={() => void refreshSetup()}>Re-check devices</Button>}
          {!running && <Button variant="quiet" disabled={busy} onClick={() => void remove(run)}>Delete run</Button>}
        </div>
      </div>
      {runningElsewhere && !running && <p className="control-help">{runningElsewhere.name} is running on this device. Wait for it to finish or stop it.</p>}
      {sourceCallout}
      {messages}
      {run.state !== 'queued' && <div className="patrol-run-summary" role="status">
        <p className="patrol-run-summary__counts">
          {running ? <span>Running {counts.done} of {counts.total}</span> : <>
            <span className="patrol-run-summary__passed"><strong>{counts.passed}</strong> passed</span>
            <span className="patrol-run-summary__failed"><strong>{counts.failed}</strong> failed</span>
            {counts.blocked > 0 && <span><strong>{counts.blocked}</strong> blocked</span>}
            {counts.notRun > 0 && <span><strong>{counts.notRun}</strong> not run</span>}
          </>}
        </p>
        {analysis?.state === 'running' && <p className="patrol-run-summary__analysis"><span aria-hidden="true">↻</span>{analysis.detail ?? `${agent} is analyzing the failures. The report opens in your browser when it is ready.`}{analysis.detail && shownTab !== 'analysis' && <Button onClick={() => setTab('analysis')}>Open analysis tab</Button>}</p>}
        {analysis?.state === 'ready' && <p className="patrol-run-summary__analysis">{agent} analysis is ready. <Button onClick={() => void openReport(run)}>Open report</Button></p>}
        {analysis?.state === 'failed' && <p className="patrol-run-summary__analysis patrol-run-summary__analysis--failed">Analysis did not finish: {analysis.detail ?? 'no report was written.'}</p>}
        {canAnalyze && <Button disabled={busy} onClick={() => void analyzeAgain(run)}>{analysis ? 'Analyze again' : 'Analyze failures'}</Button>}
      </div>}
      {analysis && <div className="review-tabs" role="tablist" aria-label="Run details">
        <button type="button" role="tab" aria-selected={shownTab === 'results'} onClick={() => setTab('results')}>Results</button>
        <button type="button" role="tab" aria-selected={shownTab === 'analysis'} onClick={() => setTab('analysis')}>{agent} analysis{analysis.state === 'running' && <span className="patrol-run-tab__live" aria-label="running" />}</button>
      </div>}
      {shownTab === 'results' && <section className="patrol-run-tests" role={analysis ? 'tabpanel' : undefined} aria-labelledby="patrol-run-tests-title">
        <h3 id="patrol-run-tests-title">Tests in this run <span>{run.items.length}</span>{hasRunLog && !running && <Button variant="quiet" onClick={() => setLog({ title: `${run.name} · full run log` })}>Full run log</Button>}</h3>
        <ol>{run.items.map((item) => {
          const progress = itemProgress(run, attempts, item.testId);
          const shown = progress.current ?? (run.state === 'running' ? undefined : progress.history[0]);
          return <li key={item.testId} className="patrol-run-item">
            <ItemStatus state={progress.state} />
            <span className="patrol-run-item__title"><strong>{item.title}</strong><small>v{item.version} · {item.relativePath}</small></span>
            <span className="patrol-run-item__time">{shown ? duration(shown) : ''}</span>
            {shown?.finishedAt ? <Button variant="quiet" onClick={() => setLog({ title: item.title, attemptId: shown.id })}>Log</Button> : <span />}
          </li>;
        })}</ol>
      </section>}
      {shownTab === 'analysis' && analysis && <div role="tabpanel" aria-label={`${agent} analysis`}>
        <PatrolRunAnalysisTerminal key={`${run.id}:${analysis.startedAt}`} runId={run.id} organizationId={organizationId} projectId={projectId} agent={agent} />
      </div>}
      {log && <LogDialog title={log.title} load={() => window.sayspec!.readPatrolRunLog({ organizationId, projectId, runId: run.id, ...(log.attemptId ? { attemptId: log.attemptId } : {}) })} onClose={() => setLog(undefined)} />}
    </section>
  </RecordLayout>;
}

/** A test's or the run's log, in a modal the user closes with Escape or Close. */
function LogDialog({ title, load, onClose }: { title: string; load: () => Promise<string>; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    dialogRef.current?.showModal();
    let live = true;
    void load().then((value) => { if (live) setText(value); }).catch((reason) => { if (live) setError(messageOf(reason)); });
    return () => { live = false; };
  }, []);
  return <dialog ref={dialogRef} className="log-dialog" aria-labelledby="log-dialog-title" onClose={onClose} onClick={(event) => { if (event.target === dialogRef.current) dialogRef.current?.close(); }}>
    <header><h3 id="log-dialog-title">{title}</h3><Button onClick={() => dialogRef.current?.close()}>Close</Button></header>
    {error ? <p className="inline-error" role="alert">{error}</p> : text === undefined ? <p className="control-help">Loading the log…</p> : <pre tabIndex={0}>{text}</pre>}
  </dialog>;
}

/**
 * The run's analysis terminal. The agent runs in the main process whether or
 * not this tab is open; attaching replays what it printed so far and then
 * follows it live, with keyboard input while the session is open.
 */
function PatrolRunAnalysisTerminal({ runId, organizationId, projectId, agent }: { runId: string; organizationId: string; projectId: string; agent: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'attaching' | 'live' | 'ended' | 'unavailable'>('attaching');
  useEffect(() => {
    const mount = mountRef.current; if (!mount) return;
    const terminal = new Terminal({ cursorBlink: true, convertEol: true, scrollback: 10_000, fontFamily: 'SFMono-Regular, Menlo, monospace', fontSize: 13, theme: { background: '#17211d', foreground: '#e9eee9', cursor: '#e9eee9' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(mount); fit.fit();
    let seq = -1;
    let token: string | undefined;
    const queued: PatrolRunAnalysisEvent[] = [];
    const apply = (event: PatrolRunAnalysisEvent) => {
      if (event.kind === 'data' && event.data && event.seq > seq) { terminal.write(event.data); seq = event.seq; }
      if (event.kind === 'exit') { token = undefined; setState('ended'); terminal.write(`\r\n${agent} exited (${event.exitCode ?? 'unknown'}).\r\n`); }
    };
    // Events are queued until the snapshot arrives, so nothing is lost or written twice.
    const unsubscribe = window.sayspec!.onPatrolRunAnalysisEvent((event) => { if (event.runId !== runId) return; if (seq < 0) queued.push(event); else apply(event); });
    const resize = () => { if (token) void window.sayspec!.resizePatrolRunAnalysis({ runId, sessionToken: token, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined); };
    void window.sayspec!.attachPatrolRunAnalysis({ organizationId, projectId, runId }).then((snapshot) => {
      terminal.write(snapshot.output); seq = snapshot.seq; token = snapshot.sessionToken;
      setState(token ? 'live' : snapshot.output ? 'ended' : 'unavailable');
      for (const event of queued.splice(0)) apply(event);
      resize(); if (token) terminal.focus();
    }).catch(() => setState('unavailable'));
    const input = terminal.onData((data) => { if (token) void window.sayspec!.writePatrolRunAnalysis({ runId, sessionToken: token, data }).catch(() => undefined); });
    const observer = new ResizeObserver(() => { if (mount.offsetWidth > 0 && mount.offsetHeight > 0) { fit.fit(); resize(); } });
    observer.observe(mount);
    return () => { observer.disconnect(); unsubscribe(); input.dispose(); terminal.dispose(); };
  }, [runId, organizationId, projectId, agent]);
  return <section className="claude-tab" aria-label={`${agent} analysis terminal`}>
    <div className="claude-tab__frame">
      <div ref={mountRef} className="claude-tab__terminal" role="region" aria-label={`Interactive ${agent} terminal`} />
      {state === 'unavailable' && <div className="claude-tab__overlay" role="status"><span>This analysis session ended when SaySpec closed. Its report, if written, is still available.</span></div>}
    </div>
  </section>;
}
