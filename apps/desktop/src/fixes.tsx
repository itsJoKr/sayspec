import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { FailureAnalysis, FlutterDeviceSummary, LocalSourceSelection, ManagedTestFixProposal, PatrolAttempt, PatrolSavedTest, SavedWebTestAttempt } from '@sayspec/contracts';
import type { CloudBackend } from './cloud/backend';
import { useCloud } from './cloud/context';
import { syncCloudPatrolTests } from './cloud-patrol-tests';
import { DeviceSelect } from './device-select';
import { GitChanges } from './git-changes';
import { Button, StatePanel } from './ui';

export type FixTarget = { attempt: SavedWebTestAttempt; analysis: FailureAnalysis };
export type PatrolFixTarget = { attempt: PatrolAttempt; analysis: FailureAnalysis };
type FixSubject = { attempt: { id: string; organizationId: string; projectId: string; testId: string }; analysis: FailureAnalysis };
type StartFix = (input: { cols: number; rows: number; idToken?: string }) => Promise<{ sessionToken: string }>;
const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error:\s*/, '') : String(error);
/** The bearer token the main process forwards to the cloud backend for a cloud project's fix decisions; none for local projects. */
async function tokenFor(backend: CloudBackend | null, cloud: boolean) { const token = cloud ? await backend?.auth.idToken() : undefined; if (cloud && !token) throw new Error('Sign in again to review this Pro fix.'); return token; }

/** The fix session's terminal; `start` opens a session other than a managed Web test fix. */
function FixTerminal({ target, cloud, onProposal, start, intro }: { target: FixSubject; cloud: boolean; onProposal: (proposal: ManagedTestFixProposal) => void; start?: StartFix; intro?: string }) {
  const backend = useCloud();
  const mount = useRef<HTMLDivElement>(null); const session = useRef('');
  const [state, setState] = useState<'starting' | 'running' | 'exited' | 'error'>('starting'); const [error, setError] = useState('');
  useEffect(() => {
    const element = mount.current; if (!element) return;
    let disposed = false;
    const terminal = new Terminal({ cursorBlink: true, convertEol: true, scrollback: 10_000, fontFamily: 'SFMono-Regular, Menlo, monospace', fontSize: 13, theme: { background: '#17211d', foreground: '#e9eee9', cursor: '#e9eee9' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element);
    const attempt = target.attempt;
    const input = terminal.onData((data) => { if (session.current) void window.sayspec!.writeManagedFixSession({ attemptId: attempt.id, sessionToken: session.current, data }).catch(() => undefined); });
    const unsubscribe = window.sayspec!.onManagedFixTerminalEvent((event) => {
      if (event.attemptId !== attempt.id || disposed) return;
      if (event.kind === 'data' && event.data) terminal.write(event.data);
      if (event.kind === 'proposal' && event.proposal) onProposal(event.proposal);
      if (event.kind === 'error') { setError(event.data ?? 'The fix session failed.'); setState('error'); }
      if (event.kind === 'exit') { setState('exited'); terminal.write(`\r\nCoding agent exited (${event.exitCode ?? 'unknown'}).\r\n`); }
    });
    const observer = new ResizeObserver(() => { if (element.offsetWidth && element.offsetHeight) { fit.fit(); if (session.current) void window.sayspec!.resizeManagedFixSession({ attemptId: attempt.id, sessionToken: session.current, cols: terminal.cols, rows: terminal.rows }); } }); observer.observe(element);
    void (async () => {
      try {
        fit.fit(); const idToken = await tokenFor(backend, cloud);
        const open: StartFix = start ?? ((size) => window.sayspec!.startManagedFixSession({ organizationId: attempt.organizationId, projectId: attempt.projectId, testId: attempt.testId, attemptId: attempt.id, analysisId: target.analysis.id, ...size }));
        const started = await open({ cols: terminal.cols, rows: terminal.rows, idToken });
        if (disposed) { await window.sayspec!.closeManagedFixSession({ attemptId: attempt.id, sessionToken: started.sessionToken }); return; }
        session.current = started.sessionToken; setState('running'); terminal.focus();
      } catch (reason) { if (!disposed) { setError(messageOf(reason)); setState('error'); } }
    })();
    return () => { disposed = true; observer.disconnect(); unsubscribe(); input.dispose(); terminal.dispose(); if (session.current) void window.sayspec!.closeManagedFixSession({ attemptId: attempt.id, sessionToken: session.current }); session.current = ''; };
  }, [target.attempt.id, target.analysis.id, cloud]);
  return <section className="fix-terminal" aria-label="Interactive AI fix session"><p>{intro ?? 'Your selected coding agent proposes changes in an isolated session with read-only access to the project test library. Review the diff below before approving a new version.'}</p><div ref={mount} className="fix-terminal__screen" role="region" aria-label="Coding-agent fix terminal" />{state === 'starting' && <p role="status">Preparing the fix session…</p>}{state === 'running' && <Button onClick={() => { if (session.current) void window.sayspec!.closeManagedFixSession({ attemptId: target.attempt.id, sessionToken: session.current }); }}>End session</Button>}{error && <p className="inline-error" role="alert">{error}</p>}</section>;
}

export function FixesPage({ organizationId, projectId, cloud, baseUrl, target, onUpdated }: { organizationId: string; projectId: string; cloud: boolean; baseUrl?: string; target: FixTarget | null; onUpdated?: () => Promise<void> }) {
  const backend = useCloud();
  const [proposals, setProposals] = useState<ManagedTestFixProposal[]>([]); const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const selected = proposals.find((item) => item.id === selectedId);
  const ordered = useMemo(() => [...proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [proposals]);
  async function refresh() {
    const idToken = await tokenFor(backend, cloud);
    const versions = await window.sayspec!.listProjectWebTestVersions({ organizationId, projectId });
    const ids = [...new Set(versions.map((item) => item.testId))];
    const batches = await Promise.all(ids.map((testId) => window.sayspec!.listManagedFixProposals({ organizationId, projectId, testId, idToken })));
    const next = batches.flat(); setProposals(next); setSelectedId((current) => next.some((item) => item.id === current) ? current : next.at(-1)?.id ?? '');
  }
  useEffect(() => { setProposals([]); setSelectedId(''); setError(''); void refresh().catch((reason) => setError(messageOf(reason))); }, [organizationId, projectId, cloud]);
  useEffect(() => { if (target) setSelectedId(''); }, [target?.attempt.id]);
  function received(proposal: ManagedTestFixProposal) { setProposals((old) => [...old.filter((item) => item.id !== proposal.id), proposal]); setSelectedId(proposal.id); setNotice('Proposal recorded. Review the diff and assertion impact before deciding.'); }
  async function decide(kind: 'approve' | 'reject') {
    if (!selected) return; setBusy(true); setError('');
    try { const idToken = await tokenFor(backend, cloud); const next = await window.sayspec!.decideManagedFix({ organizationId, projectId, testId: selected.testId, proposalId: selected.id, kind, idToken }); received(next); setNotice(kind === 'approve' ? 'Approval recorded for this exact proposal and base.' : 'Rejection recorded. The original failure remains unchanged.'); }
    catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }
  async function apply() {
    if (!selected) return; setBusy(true); setError('');
    try {
      const idToken = await tokenFor(backend, cloud);
      const version = await window.sayspec!.applyManagedFix({ organizationId, projectId, testId: selected.testId, proposalId: selected.id, idToken });
      await refresh(); if (onUpdated) await onUpdated();
      if (!baseUrl) { setNotice(`New unvalidated version ${version.version} created. Configure a Web URL, then run it from Runs. The original failure is retained.`); return; }
      setNotice(`New version ${version.version} created. Running it as a separate attempt…`);
      const attempt = await window.sayspec!.runSavedWebTest({ organizationId, projectId, testId: selected.testId, versionId: version.id, baseUrl });
      let sync = '';
      if (cloud) try { if (!backend) throw new Error('This build has no cloud backend.'); await backend.runs.recordAttempt({ organizationId, projectId, testId: selected.testId, attempt }); } catch (reason) { sync = ` Pro attempt synchronization failed: ${messageOf(reason)}.`; }
      setNotice(`New version ${version.version} validation: ${attempt.state}. ${attempt.summary} The original failure is retained.${sync}`);
    } catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }
  return <section className="fixes-page" aria-label="Managed test fixes"><p>Fix proposals come from failed attempts. Approval creates a new version; it does not prove the test passes.</p>
    {target && <FixTerminal key={`${target.attempt.id}:${target.analysis.id}`} target={target} cloud={cloud} onProposal={received} />}
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!ordered.length ? <StatePanel tone="empty" title="No fix proposals yet">Open a failed attempt in Runs, read its analysis, then start a fix session.</StatePanel>
      : <div className="fixes-grid"><div className="fixes-list" role="list" aria-label="Fix proposals">{ordered.map((item) => <button key={item.id} role="listitem" type="button" aria-current={item.id === selectedId ? 'true' : undefined} onClick={() => setSelectedId(item.id)}><strong>{item.status}</strong><span>Test {item.testId} · {new Date(item.createdAt).toLocaleString()}</span></button>)}</div>
        {selected && <article className="fix-detail"><h2>Managed test proposal</h2><p>{selected.rationale}</p><p>Attempt {selected.attemptId} · analysis {selected.analysisId} · base {selected.baseVersionId}</p><p>Base {selected.baseContentHash.slice(0, 16)}… · proposal {selected.proposalHash.slice(0, 16)}…</p><h3>Assertion impact</h3><ul>{selected.assertionImpact.map((flag) => <li key={flag}>{flag}</li>)}</ul><details open><summary>Source diff</summary><pre className="fix-diff">{selected.diff}</pre></details>
          <div className="fix-actions">{selected.status === 'proposed' && <><Button variant="primary" disabled={busy} onClick={() => void decide('approve')}>Approve exact patch</Button><Button disabled={busy} onClick={() => void decide('reject')}>Reject</Button></>}{selected.status === 'approved' && <Button variant="primary" disabled={busy} onClick={() => void apply()}>Apply approved patch</Button>}{selected.status === 'applied' && <><p>Applied as version {selected.appliedVersionId}. The original failure remains in Runs.</p><Button disabled={busy} onClick={() => void apply()}>Retry sync and validation</Button></>}{selected.status === 'rejected' && <p>Rejected. No managed test was changed.</p>}</div>{selected.status === 'applied' && !cloud && <GitChanges target={{ kind: 'tests', organizationId, projectId, testIds: [selected.testId] }} refreshKey={selected.appliedVersionId} title="Commit the new version to Git" />}</article>}</div>}
  </section>;
}

const outcome = (attempt: PatrolAttempt) => attempt.state === 'passed' ? 'passed' : attempt.state === 'failed' ? 'failed' : attempt.state === 'infrastructure-error' ? 'could not run' : attempt.state;

/**
 * Patrol test fixes. A session started from a run's test-bug issue proposes
 * new source for that one saved test. Approving it records the decision;
 * applying it saves the test's next version, unvalidated until it passes on a
 * device. The failed version and its run stay as they were.
 */
export function PatrolTestFixesPage({ organizationId, projectId, cloudStorage, canManage = true, source, onChooseSource, target }: { organizationId: string; projectId: string; cloudStorage: boolean; canManage?: boolean; source?: LocalSourceSelection; onChooseSource(next: LocalSourceSelection): void; target: PatrolFixTarget | null }) {
  const backend = useCloud();
  const [proposals, setProposals] = useState<ManagedTestFixProposal[]>([]); const [selectedId, setSelectedId] = useState('');
  const [versions, setVersions] = useState<PatrolSavedTest[]>([]);
  const [devices, setDevices] = useState<FlutterDeviceSummary[]>([]); const [deviceId, setDeviceId] = useState('');
  const [validation, setValidation] = useState<{ versionId: string; attempt?: PatrolAttempt }>();
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const selected = proposals.find((item) => item.id === selectedId);
  const ordered = useMemo(() => [...proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [proposals]);
  const versionOf = (versionId?: string) => versions.find((item) => item.versionId === versionId);
  async function refresh() {
    const idToken = await tokenFor(backend, cloudStorage);
    const next = await window.sayspec!.listPatrolTestFixProposals({ organizationId, projectId, idToken });
    setProposals(next); setSelectedId((current) => next.some((item) => item.id === current) ? current : next.at(-1)?.id ?? '');
  }
  async function refreshDevices() {
    const next = await window.sayspec!.listFlutterDevices();
    setDevices(next); setDeviceId((current) => next.some((item) => item.id === current && item.state === 'ready') ? current : next.find((item) => item.state === 'ready')?.id ?? '');
  }
  useEffect(() => { setProposals([]); setSelectedId(''); setError(''); void refresh().catch((reason) => setError(messageOf(reason))); }, [organizationId, projectId, cloudStorage]);
  useEffect(() => { if (target) setSelectedId(''); }, [target?.attempt.id]);
  useEffect(() => {
    if (!selected) return; let active = true;
    void window.sayspec!.listPatrolTestVersions({ organizationId, projectId, testId: selected.testId }).then((items) => { if (active) setVersions(items); }).catch(() => undefined);
    return () => { active = false; };
  }, [selected?.testId, selected?.status, organizationId, projectId]);
  useEffect(() => { if (selected?.status === 'applied') void refreshDevices().catch((reason) => setError(messageOf(reason))); }, [selected?.id, selected?.status]);
  function received(proposal: ManagedTestFixProposal) { setProposals((old) => [...old.filter((item) => item.id !== proposal.id), proposal]); setSelectedId(proposal.id); setNotice('Proposal recorded. Review the diff and assertion impact before deciding.'); }
  async function act(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); } }
  const decide = (kind: 'approve' | 'reject') => act(async () => {
    if (!selected) return;
    const idToken = await tokenFor(backend, cloudStorage);
    received(await window.sayspec!.decidePatrolTestFix({ organizationId, projectId, testId: selected.testId, proposalId: selected.id, kind, idToken }));
    setNotice(kind === 'approve' ? 'Approval recorded for this exact proposal. Apply it to save the new version.' : 'Rejected. The saved test is unchanged.');
  });
  const apply = () => act(async () => {
    if (!selected) return;
    const idToken = await tokenFor(backend, cloudStorage);
    const version = await window.sayspec!.applyPatrolTestFix({ organizationId, projectId, testId: selected.testId, proposalId: selected.id, idToken });
    await refresh();
    let upload = '';
    if (cloudStorage && backend) {
      const synced = await syncCloudPatrolTests(backend, { organizationId, projectId }).catch((reason) => ({ problems: [messageOf(reason)] }));
      if (synced.problems.length) upload = ` It is not in SaySpec Cloud yet: ${synced.problems.join(' ')}`;
    }
    setNotice(`Saved as version ${version.version}. Run it on a device to check that it passes; the failed version and its run are unchanged.${upload}`);
  });
  const validate = () => act(async () => {
    if (!selected?.appliedVersionId) return;
    if (!source) throw new Error('Choose the Flutter project folder so SaySpec can build and run the new version.');
    if (!deviceId) throw new Error('Choose a device that is ready.');
    const versionId = selected.appliedVersionId;
    setValidation({ versionId }); setNotice('');
    const attempt = await window.sayspec!.runPatrolTest({ organizationId, projectId, testId: selected.testId, versionId, deviceId, sourceHandle: source.handle });
    setValidation({ versionId, attempt });
    // A pass marks the version validated.
    setVersions(await window.sayspec!.listPatrolTestVersions({ organizationId, projectId, testId: selected.testId }));
  });
  const base = versionOf(selected?.baseVersionId); const applied = versionOf(selected?.appliedVersionId);
  const checked = validation && validation.versionId === selected?.appliedVersionId ? validation : undefined;
  return <section className="fixes-page" aria-label="Patrol test fixes"><h2>Test fixes</h2><p>Fixes for tests the run analysis found wrong. An approved fix becomes the test's next version; it does not prove the test passes until it runs.</p>
    {target && (source
      ? <FixTerminal key={`${target.attempt.id}:${target.analysis.id}`} target={target} cloud={cloudStorage} onProposal={received}
          intro="Your selected coding agent proposes a new version of this Patrol test in an isolated session. It can read the Flutter app for context but cannot change it or the saved tests. Review the diff below before approving."
          start={(size) => window.sayspec!.startPatrolTestFixSession({ organizationId, projectId, testId: target.attempt.testId, attemptId: target.attempt.id, analysisId: target.analysis.id, sourceHandle: source.handle, ...size })} />
      : <StatePanel tone="empty" title="Select the Flutter source folder">The fix session reads the app to match the test to it, and the new version is built from it. <Button onClick={() => void window.sayspec!.chooseSourceDirectory().then((next) => next && onChooseSource(next)).catch((reason) => setError(messageOf(reason)))}>Choose source folder</Button></StatePanel>)}
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!ordered.length ? !target && <StatePanel tone="empty" title="No test fixes yet">Open a failed run in Runs and choose Fix test on a Test bug issue.</StatePanel>
      : <div className="fixes-grid"><div className="fixes-list" role="list" aria-label="Test fix proposals">{ordered.map((item) => <button key={item.id} role="listitem" type="button" aria-current={item.id === selectedId ? 'true' : undefined} onClick={() => setSelectedId(item.id)}><strong>{item.status}</strong><span>{item.fileChanges[0]?.relativePath ?? item.testId} · {new Date(item.createdAt).toLocaleString()}</span></button>)}</div>
        {selected && <article className="fix-detail"><h3>{base?.title ?? 'Patrol test'}{base ? ` · v${base.version}` : ''}</h3><p>{selected.rationale}</p><p>Attempt {selected.attemptId} · analysis {selected.analysisId}</p><p>Base {selected.baseContentHash.slice(0, 16)}… · proposal {selected.proposalHash.slice(0, 16)}…</p><h4>Assertion impact</h4><ul>{selected.assertionImpact.map((flag) => <li key={flag}>{flag}</li>)}</ul><details open><summary>Source diff</summary><pre className="fix-diff">{selected.diff}</pre></details>
          <div className="fix-actions">
            {!canManage && selected.status !== 'applied' && selected.status !== 'rejected' && <p>Only editors of this project can approve and apply fixes.</p>}
            {selected.status === 'proposed' && <><Button variant="primary" disabled={busy || !canManage} onClick={() => void decide('approve')}>Approve exact patch</Button><Button disabled={busy || !canManage} onClick={() => void decide('reject')}>Reject</Button></>}
            {selected.status === 'approved' && <Button variant="primary" disabled={busy || !canManage} onClick={() => void apply()}>Apply approved patch</Button>}
            {selected.status === 'applied' && <>
              <p>Saved as version {applied?.version ?? selected.appliedVersionId}{applied?.state === 'execution-validated' ? ', which has passed on a device' : ''}. The failed version and its run are unchanged.</p>
              <DeviceSelect label="Device" ariaLabel="Device for the new version" platforms={['android', 'ios']} disabled={busy} devices={devices} value={deviceId} onChange={setDeviceId} onStarted={async (device) => { await refreshDevices(); setDeviceId(device.id); }} />
              <Button variant="primary" disabled={busy || !deviceId || !source} onClick={() => void validate()}>{checked?.attempt ? 'Run new version again' : 'Run new version on device'}</Button>
              {checked && !checked.attempt && <p role="status">Building the app and running version {applied?.version ?? ''}. This takes a few minutes.</p>}
              {checked?.attempt && <div className="fix-validation" role="status"><p><strong>Version {applied?.version ?? ''} {outcome(checked.attempt)}.</strong> {checked.attempt.summary}</p>{checked.attempt.tests.filter((test) => test.outcome === 'failed').map((test) => <p key={test.title}>{test.title}: {test.errors.join(' ')}</p>)}{checked.attempt.state === 'passed' && <p>New runs created in Runs use this version.</p>}</div>}
            </>}
            {selected.status === 'rejected' && <p>Rejected. No saved test was changed.</p>}
          </div>
          {selected.status === 'applied' && !cloudStorage && <GitChanges target={{ kind: 'tests', organizationId, projectId, testIds: [selected.testId] }} refreshKey={selected.appliedVersionId} title="Commit the new version to Git" />}</article>}</div>}
  </section>;
}
