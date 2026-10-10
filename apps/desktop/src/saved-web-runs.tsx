import { useEffect, useRef, useState } from 'react';
import type { CodingAgentProviderId, FailureAnalysis, PortableWebTestBundle, SavedWebRun, SavedWebTestAttempt } from '@sayspec/contracts';
import { useCloud } from './cloud/context';
import { Button, StatePanel } from './ui';

const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error:\s*/, '') : String(error);

type RunAttemptState = SavedWebTestAttempt['state'] | 'not-run';

function latestAttempt(item: SavedWebRun['items'][number], attempts: SavedWebTestAttempt[]) {
  return attempts.filter((attempt) => item.attemptIds.includes(attempt.id)).sort((left, right) => left.startedAt.localeCompare(right.startedAt)).at(-1);
}

function runCounts(run: SavedWebRun, attempts: SavedWebTestAttempt[]) {
  const states = run.items.map((item) => latestAttempt(item, attempts)?.state ?? 'not-run');
  return {
    passed: states.filter((state) => state === 'passed').length,
    failed: states.filter((state) => state === 'failed').length,
    skipped: states.filter((state) => state === 'skipped').length,
    blocked: states.filter((state) => state === 'blocked').length,
    infrastructure: states.filter((state) => state === 'infrastructure-error').length,
    canceled: states.filter((state) => state === 'canceled').length,
    notRun: states.filter((state) => state === 'not-run').length,
  };
}

function RunStatus({ run, attempts }: { run: SavedWebRun; attempts: SavedWebTestAttempt[] }) {
  if (run.state === 'preparing' || run.state === 'running') return <span className="run-status run-status--running"><span aria-hidden="true">↻</span>Running</span>;
  if (run.state === 'queued') return <span className="run-status run-status--not-run">Not run</span>;
  if (run.state === 'interrupted') return <span className="run-status run-status--failed"><span aria-hidden="true">×</span>Interrupted</span>;
  if (run.state === 'canceled') return <span className="run-status run-status--canceled">Canceled</span>;
  const counts = runCounts(run, attempts);
  if (counts.passed === 0 && counts.failed === 0 && counts.skipped === 0 && counts.blocked === 0 && counts.infrastructure === 0 && counts.canceled === 0) return <span className="run-status run-status--not-run">Not run</span>;
  return <span className="run-statuses" aria-label={`Run results: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.blocked} blocked, ${counts.infrastructure} infrastructure errors, ${counts.canceled} canceled, ${counts.notRun} not run`}>
    {counts.passed > 0 && <span className="run-status run-status--passed"><span aria-hidden="true">✓</span>{counts.passed} pass</span>}
    {counts.failed > 0 && <span className="run-status run-status--failed"><span aria-hidden="true">×</span>{counts.failed} fail</span>}
    {counts.skipped > 0 && <span className="run-status run-status--skipped">{counts.skipped} skipped</span>}
    {counts.blocked > 0 && <span className="run-status run-status--blocked">{counts.blocked} blocked</span>}
    {counts.infrastructure > 0 && <span className="run-status run-status--failed">{counts.infrastructure} infrastructure</span>}
    {counts.canceled > 0 && <span className="run-status run-status--canceled">{counts.canceled} canceled</span>}
    {counts.notRun > 0 && <span className="run-status run-status--not-run">{counts.notRun} not run</span>}
  </span>;
}

function AttemptStatus({ state }: { state: RunAttemptState }) {
  if (state === 'passed') return <span className="run-status run-status--passed"><span aria-hidden="true">✓</span>Passed</span>;
  if (state === 'failed' || state === 'infrastructure-error') return <span className="run-status run-status--failed"><span aria-hidden="true">×</span>{state === 'failed' ? 'Failed' : 'Infrastructure error'}</span>;
  if (state === 'running' || state === 'preparing') return <span className="run-status run-status--running"><span aria-hidden="true">↻</span>Running</span>;
  if (state === 'skipped') return <span className="run-status run-status--skipped">Skipped</span>;
  if (state === 'blocked') return <span className="run-status run-status--blocked">Blocked</span>;
  if (state === 'canceled') return <span className="run-status run-status--canceled">Canceled</span>;
  return <span className="run-status run-status--not-run">Not run</span>;
}

function FailureExplanation({ attempt, onOpenFix }: { attempt: SavedWebTestAttempt; onOpenFix?: (attempt: SavedWebTestAttempt, analysis: FailureAnalysis) => void }) {
  const [analyses, setAnalyses] = useState<FailureAnalysis[]>([]);
  const [provider, setProvider] = useState<CodingAgentProviderId | ''>('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const scope = { organizationId: attempt.organizationId, projectId: attempt.projectId, testId: attempt.testId, attemptId: attempt.id };
  useEffect(() => {
    let live = true;
    void Promise.all([window.sayspec!.listFailureAnalyses(scope), window.sayspec!.getCodingAgentPreference()]).then(([records, preference]) => {
      if (live) { setAnalyses(records); setProvider(preference.provider ?? ''); }
    }).catch((reason) => { if (live) setError(messageOf(reason)); });
    return () => { live = false; };
  }, [attempt.id]);
  async function analyze() {
    if (!provider) { setError('Choose a coding-agent provider in Settings first.'); return; }
    setBusy(true); setError('');
    try { const record = await window.sayspec!.analyzeSavedWebFailure({ ...scope, provider }); setAnalyses((previous) => [...previous, record]); }
    catch (reason) { setError(messageOf(reason)); }
    finally { setBusy(false); }
  }
  if (!['failed', 'blocked', 'infrastructure-error'].includes(attempt.state)) return null;
  return <div className="failure-explanation"><p><strong>Failure explanation</strong> · framework result: {attempt.state}</p>
    <Button onClick={() => void analyze()} disabled={busy}>{busy ? 'Analyzing…' : 'Explain failure'}</Button>
    {busy && <Button onClick={() => void window.sayspec!.cancelFailureAnalysis({ attemptId: attempt.id })}>Cancel analysis</Button>}
    {!provider && <p>Choose Claude Code or Codex in Settings to request an explanation.</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {[...analyses].reverse().map((item) => <div key={item.id} className="failure-analysis"><p><strong>{item.status === 'complete' ? item.category : 'Analysis inconclusive'}</strong> · {item.explanation}</p><p>Expected: {item.expected}</p><p>Actual: {item.actual}</p><p>Next: {item.nextStep}</p>{item.status === 'complete' && (item.category === 'test' || item.category === 'application') && <Button disabled={!onOpenFix} onClick={() => onOpenFix?.(attempt, item)}>{item.category === 'application' ? 'Propose application fix' : 'Fix with AI'}</Button>}<details><summary>Supporting evidence and limitations</summary><p>{item.limitations}</p><p>Attempt {item.attemptId} · input {item.inputHash.slice(0, 16)}… · {item.provider} {item.cliVersion ?? ''}</p>{item.evidenceIds.length === 0 && <p>No cited evidence.</p>}{item.evidence.filter((entry) => item.evidenceIds.includes(entry.id)).map((entry) => <div key={entry.id}><strong>{entry.id} · {entry.label}</strong><pre>{entry.text}</pre></div>)}<details><summary>All frozen evidence</summary>{item.evidence.map((entry) => <div key={entry.id}><strong>{entry.id} · {entry.label}</strong><pre>{entry.text}</pre></div>)}</details></details></div>)}
  </div>;
}

export function SavedWebRuns({ organizationId, projectId, cloud, initialRunId, importRequest = 0, onLocalChanged, onOpenFix }: { organizationId: string; projectId: string; cloud: boolean; initialRunId?: string; importRequest?: number; onLocalChanged?: () => Promise<void>; onOpenFix?: (attempt: SavedWebTestAttempt, analysis: FailureAnalysis) => void }) {
  const backend = useCloud();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [runs, setRuns] = useState<SavedWebRun[]>([]); const [runId, setRunId] = useState(initialRunId ?? '');
  const [showBrowser, setShowBrowser] = useState(false);
  const [runAttempts, setRunAttempts] = useState<SavedWebTestAttempt[]>([]);
  const [runAttemptsById, setRunAttemptsById] = useState<Record<string, SavedWebTestAttempt[]>>({});
  const [importBundle, setImportBundle] = useState<PortableWebTestBundle | null>(null);
  const [importPreview, setImportPreview] = useState<{ title: string; fileCount: number; contentHash: string; requirements: readonly string[] } | null>(null);
  const [syncError, setSyncError] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);
  const lastImportRequest = useRef(importRequest);
  const synced = useRef(new Set<string>()); const syncing = useRef(new Set<string>()); const failedSync = useRef(new Set<string>());
  const selectedRun = runs.find((run) => run.id === runId);
  const selectedRunId = selectedRun?.id;

  useEffect(() => { setShowBrowser(selectedRun?.showBrowser === true); }, [selectedRunId]);

  useEffect(() => {
    if (importRequest !== lastImportRequest.current) { lastImportRequest.current = importRequest; importInputRef.current?.click(); }
  }, [importRequest]);

  async function syncItem(key: string, action: () => Promise<unknown>) {
    if (!cloud || !backend || synced.current.has(key) || syncing.current.has(key) || failedSync.current.has(key)) return;
    syncing.current.add(key);
    try { await action(); synced.current.add(key); setSyncError(''); }
    catch (reason) { failedSync.current.add(key); setSyncError(`Local results are retained, but Pro synchronization failed: ${messageOf(reason)}`); }
    finally { syncing.current.delete(key); }
  }
  async function syncRun(run: SavedWebRun, attempts: SavedWebTestAttempt[]) {
    if (!cloud || !backend) return;
    await syncItem(`run:${run.id}`, () => backend.runs.recordRun({ organizationId, projectId, run: { schemaVersion: 1, id: run.id, organizationId, projectId, name: run.name, environmentHash: run.environmentHash, items: run.items.map((item) => ({ testId: item.testId, versionId: item.versionId, contentHash: item.contentHash, title: item.title })) } }));
    for (const attempt of attempts.filter((item) => !['preparing', 'running'].includes(item.state))) await syncItem(`attempt:${attempt.id}`, () => backend.runs.recordAttempt({ organizationId, projectId, testId: attempt.testId, attempt }));
  }

  useEffect(() => {
    let current = true;
    const poll = async () => {
      try {
        const next = await window.sayspec!.listSavedWebRuns({ organizationId, projectId }); if (!current) return;
        const preferredId = runId || (initialRunId && next.some((run) => run.id === initialRunId) ? initialRunId : '');
        const entries = await Promise.all(next.map(async (run) => {
          const all = await Promise.all(run.items.map((item) => window.sayspec!.listSavedWebTestAttempts({ organizationId, projectId, testId: item.testId })));
          return { run, attempts: all.flat().filter((attempt) => run.items.some((item) => item.attemptIds.includes(attempt.id))) };
        }));
        if (!current) return;
        const attemptsById = Object.fromEntries(entries.map(({ run, attempts }) => [run.id, attempts]));
        const selected = next.find((run) => run.id === preferredId) ?? next.at(-1);
        setRuns(next); setRunAttemptsById(attemptsById); setRunId((id) => next.some((run) => run.id === (preferredId || id)) ? (preferredId || id) : next.at(-1)?.id ?? '');
        setRunAttempts(selected ? attemptsById[selected.id] ?? [] : []);
        if (cloud) for (const entry of entries) void syncRun(entry.run, entry.attempts);
      } catch (reason) { if (current) setError(messageOf(reason)); }
    };
    void poll(); const interval = setInterval(() => void poll(), 1200);
    return () => { current = false; clearInterval(interval); };
  }, [organizationId, projectId, runId, initialRunId]);

  async function startRun() {
    if (!selectedRun || busy) return;
    setError(''); setBusy(true); setNotice(`Starting the saved source locally in ${showBrowser ? 'watch browser' : 'headless'} mode; no AI generation or repair will occur.`);
    try {
      const started = await window.sayspec!.startSavedWebRun({ organizationId, projectId, runId: selectedRun.id, showBrowser });
      setRuns((previous) => previous.map((run) => run.id === started.id ? started : run));
      if (cloud) void syncRun(started, []);
    } catch (reason) { setError(messageOf(reason)); }
    finally { setBusy(false); }
  }

  async function retryItem(run: SavedWebRun, testId: string) {
    setError(''); setBusy(true);
    try {
      const attempt = await window.sayspec!.retrySavedWebRunItem({ organizationId, projectId, runId: run.id, testId });
      setNotice(`Retry ${attempt.state}; the earlier attempts and artifacts remain intact.`);
      if (cloud) await syncRun(run, [attempt]);
    } catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }

  async function downloadArtifact(attempt: SavedWebTestAttempt, relativePath: string) {
    setError('');
    try {
      const artifact = await window.sayspec!.readSavedWebTestArtifact({ organizationId, projectId, testId: attempt.testId, attemptId: attempt.id, relativePath });
      const url = URL.createObjectURL(new Blob([new Uint8Array(artifact.bytes)], { type: artifact.mimeType }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${attempt.id}-${relativePath.split('/').at(-1) ?? 'artifact'}`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (reason) { setError(messageOf(reason)); }
  }

  async function preview(file: File | undefined) {
    setImportBundle(null); setImportPreview(null); setError('');
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('Portable bundle exceeds the 1 MiB budget.');
      const bundle = JSON.parse(await file.text()) as PortableWebTestBundle;
      const result = await window.sayspec!.previewWebTestImport({ bundle });
      setImportBundle(bundle); setImportPreview(result);
    } catch (reason) { setError(messageOf(reason)); }
  }

  async function confirmImport() {
    if (!importBundle || !importPreview) return;
    setBusy(true); setError('');
    const testId = `import_${crypto.randomUUID()}`;
    try {
      if (cloud) { if (!backend) throw new Error('This build has no cloud backend.'); await backend.tests.importPortable({ organizationId, projectId, testId, bundle: importBundle }); }
      await window.sayspec!.importWebTest({ organizationId, projectId, testId, bundle: importBundle });
      if (onLocalChanged) await onLocalChanged();
      setImportBundle(null); setImportPreview(null);
      setNotice('Imported as a new generated test. Open Tests to select it for a run.');
    } catch (reason) { setError(messageOf(reason)); }
    finally { setBusy(false); }
  }

  function renderRunItem(item: SavedWebRun['items'][number]) {
    if (!selectedRun) return null;
    const history = runAttempts.filter((attempt) => item.attemptIds.includes(attempt.id)).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const current = history[0];
    return <article key={item.testId} className="run-item-detail">
      <div className="run-item-detail__header"><div><strong>{item.title}</strong><span>Source {item.contentHash.slice(0, 12)}…</span></div><AttemptStatus state={current?.state ?? 'not-run'} /></div>
      {history.map((attempt) => <details key={attempt.id} className="run-attempt"><summary><AttemptStatus state={attempt.state} /> <span>{new Date(attempt.startedAt).toLocaleString()}</span></summary><p>{attempt.summary}</p>{attempt.applicationPatch && <p>Application patch {attempt.applicationPatch.receiptId} · original failure {attempt.applicationPatch.originatingAttemptId} · local server {attempt.applicationPatch.runtimeHash?.slice(0, 16) ?? 'unavailable'}…</p>}<FailureExplanation attempt={attempt} onOpenFix={onOpenFix} /><pre>{attempt.detail}</pre>{attempt.tests.map((test) => <p key={test.id}>{test.outcome}: {test.title} ({test.durationMs} ms){test.errors.length ? ` — ${test.errors.join(' ')}` : ''}</p>)}<ul>{attempt.artifacts.map((artifact) => <li key={artifact.relativePath}><button type="button" onClick={() => void downloadArtifact(attempt, artifact.relativePath)}>Download {artifact.relativePath}</button> · {artifact.byteLength} bytes</li>)}</ul><div className="run-attempt__actions">{!['preparing', 'running'].includes(attempt.state) && <Button disabled={busy} onClick={() => void retryItem(selectedRun, item.testId)}>Retry test</Button>}</div></details>)}
    </article>;
  }

  return <section className="saved-runs" aria-label="Test runs">
    <input ref={importInputRef} className="sr-only" type="file" accept=".json,.sayspec.json,application/json" onChange={(event) => void preview(event.currentTarget.files?.[0])} />
    {importPreview && <div className="run-import-preview"><div><strong>{importPreview.title}</strong><span> · {importPreview.fileCount} file{importPreview.fileCount === 1 ? '' : 's'} · {importPreview.contentHash.slice(0, 12)}…</span><p>{importPreview.requirements.join(' · ')}</p></div><div className="run-import-preview__actions"><Button onClick={() => void confirmImport()} disabled={busy}>Import as new test</Button><Button onClick={() => { setImportBundle(null); setImportPreview(null); }}>Cancel</Button></div></div>}
    {!runs.length ? <StatePanel tone="empty" title="No test runs yet">Select tests in the Tests tab to create a run.</StatePanel> : <div className="run-browser">
      <div className="run-browser__list" role="list" aria-label="Test runs">
        <div className="run-list-heading"><strong>Saved runs</strong><span>{runs.length}</span></div>
        {[...runs].reverse().map((run) => <button key={run.id} type="button" role="listitem" aria-current={run.id === runId ? 'true' : undefined} onClick={() => { setRunId(run.id); setRunAttempts(runAttemptsById[run.id] ?? []); }}>
          <strong>{run.name}</strong>
          <span>{run.items.length} {run.items.length === 1 ? 'test' : 'tests'} · {new Date(run.createdAt).toLocaleString()}</span>
          <RunStatus run={run} attempts={runAttemptsById[run.id] ?? []} />
        </button>)}
      </div>
      {selectedRun ? <aside className="run-detail-panel" aria-label={`${selectedRun.name} details`}>
        <div className="run-detail-header"><div><h2>{selectedRun.name}</h2><p>{selectedRun.items.length} {selectedRun.items.length === 1 ? 'test' : 'tests'} · created {new Date(selectedRun.createdAt).toLocaleString()}</p></div><div className="run-detail-header__actions"><RunStatus run={selectedRun} attempts={runAttempts} />{selectedRun.state === 'queued' && <div className="run-start-controls"><label className="run-browser-toggle" title="Visible runs are slower and use one worker so you can watch the browser clicking."><input type="checkbox" checked={showBrowser} onChange={(event) => setShowBrowser(event.currentTarget.checked)} disabled={busy} /><span>Show browser</span></label><Button variant="primary" onClick={() => void startRun()} disabled={busy}>{busy ? 'Starting…' : 'Start test run'}</Button></div>}{['preparing', 'running'].includes(selectedRun.state) && <Button onClick={() => void window.sayspec!.cancelSavedWebRun({ organizationId, projectId, runId: selectedRun.id })}>Cancel run</Button>}</div></div>
        <p className="run-detail-base-url">Starting URL · {selectedRun.baseUrl} · {selectedRun.state === 'queued' ? (showBrowser ? 'watch browser' : 'headless') : (selectedRun.showBrowser ? 'watch browser' : 'headless')}</p>
        <div className="run-items-detail">{selectedRun.items.map(renderRunItem)}</div>
      </aside> : <aside className="run-detail-panel run-detail-panel--empty"><p>Select a run to see its details.</p></aside>}
    </div>}
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{syncError && <p className="inline-error" role="alert">{syncError} <Button onClick={() => { failedSync.current.clear(); setSyncError(''); for (const run of runs) void syncRun(run, runAttemptsById[run.id] ?? []); }}>Retry synchronization</Button></p>}
  </section>;
}
