import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ApplicationFixProposal, ApplicationFixReceipt, FailureAnalysis, FlutterDeviceSummary, LocalSourceSelection, PatrolAttempt, SavedWebTestAttempt } from '@sayspec/contracts';
import type { CloudBackend } from './cloud/backend';
import { useCloud } from './cloud/context';
import { GitChanges } from './git-changes';
import { Button, StatePanel } from './ui';

export type ApplicationFixTarget = { attempt: SavedWebTestAttempt | PatrolAttempt; analysis: FailureAnalysis };
const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error:\s*/, '') : String(error);
/** The bearer token the main process forwards to the cloud backend for a cloud project's fix decisions; none for local projects. */
async function tokenFor(backend: CloudBackend | null, cloud: boolean) { const token = cloud ? await backend?.auth.idToken() : undefined; if (cloud && !token) throw new Error('Sign in again to review this application fix.'); return token; }

function ApplicationTerminal({ target, targetType, source, cloud, onProposal }: { target: ApplicationFixTarget; targetType: 'web' | 'flutter'; source: LocalSourceSelection; cloud: boolean; onProposal(item: ApplicationFixProposal): void }) {
  const backend = useCloud();
  const mount = useRef<HTMLDivElement>(null); const session = useRef('');
  const [state, setState] = useState<'starting' | 'running' | 'exited' | 'error'>('starting'); const [error, setError] = useState('');
  useEffect(() => {
    const element = mount.current; if (!element) return;
    let disposed = false;
    const terminal = new Terminal({ cursorBlink: true, convertEol: true, scrollback: 10_000, fontFamily: 'SFMono-Regular, Menlo, monospace', fontSize: 12, theme: { background: '#17211d', foreground: '#e9eee9', cursor: '#e9eee9' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element);
    const attempt = target.attempt;
    const input = terminal.onData((data) => { if (session.current) void window.sayspec!.writeApplicationFixSession({ attemptId: attempt.id, sessionToken: session.current, data }).catch(() => undefined); });
    const unsubscribe = window.sayspec!.onApplicationFixTerminalEvent((event) => {
      if (event.attemptId !== attempt.id || disposed) return;
      if (event.kind === 'data' && event.data) terminal.write(event.data);
      if (event.kind === 'proposal' && event.proposal) onProposal(event.proposal);
      if (event.kind === 'error') { setError(event.data ?? 'The application fix session failed.'); setState('error'); }
      if (event.kind === 'exit') { setState('exited'); terminal.write(`\r\nCoding agent exited (${event.exitCode ?? 'unknown'}).\r\n`); }
    });
    const observer = new ResizeObserver(() => { if (element.offsetWidth && element.offsetHeight) { fit.fit(); if (session.current) void window.sayspec!.resizeApplicationFixSession({ attemptId: attempt.id, sessionToken: session.current, cols: terminal.cols, rows: terminal.rows }); } }); observer.observe(element);
    void (async () => {
      try {
        fit.fit(); const idToken = await tokenFor(backend, cloud);
        const started = await window.sayspec!.startApplicationFixSession({ organizationId: attempt.organizationId, projectId: attempt.projectId, testId: attempt.testId, attemptId: attempt.id, analysisId: target.analysis.id, target: targetType, sourceHandle: source.handle, cols: terminal.cols, rows: terminal.rows, idToken });
        if (disposed) { await window.sayspec!.closeApplicationFixSession({ attemptId: attempt.id, sessionToken: started.sessionToken }); return; }
        session.current = started.sessionToken; setState('running'); terminal.focus();
      } catch (reason) { if (!disposed) { setError(messageOf(reason)); setState('error'); } }
    })();
    return () => { disposed = true; observer.disconnect(); unsubscribe(); input.dispose(); terminal.dispose(); if (session.current) void window.sayspec!.closeApplicationFixSession({ attemptId: attempt.id, sessionToken: session.current }); session.current = ''; };
  }, [target.attempt.id, target.analysis.id, targetType, source.handle, cloud]);
  return <section className="fix-terminal" aria-label="Interactive application fix session"><p>Your selected coding agent reads bounded application source in the project workspace and writes a proposal in a disposable session. Review the actual diff and scope before approving any source change.</p><div ref={mount} className="fix-terminal__screen" role="region" aria-label="Coding-agent application fix terminal" />{state === 'starting' && <p role="status">Preparing the application fix session…</p>}{state === 'running' && <Button onClick={() => { if (session.current) void window.sayspec!.closeApplicationFixSession({ attemptId: target.attempt.id, sessionToken: session.current }); }}>End session</Button>}{error && <p className="inline-error" role="alert">{error}</p>}</section>;
}

export function ApplicationFixesPage({ organizationId, projectId, targetType, cloud, source, onChooseSource, target }: { organizationId: string; projectId: string; targetType: 'web' | 'flutter'; cloud: boolean; source?: LocalSourceSelection; onChooseSource(next: LocalSourceSelection): void; target: ApplicationFixTarget | null }) {
  const backend = useCloud();
  const [proposals, setProposals] = useState<ApplicationFixProposal[]>([]); const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false); const [receipt, setReceipt] = useState<ApplicationFixReceipt | null>(null);
  const [devices, setDevices] = useState<FlutterDeviceSummary[]>([]); const [deviceId, setDeviceId] = useState('');
  const [rerun, setRerun] = useState<SavedWebTestAttempt | PatrolAttempt | null>(null);
  const selected = proposals.find((item) => item.id === selectedId);
  const ordered = useMemo(() => [...proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [proposals]);
  useEffect(() => { let active = true; setProposals([]); setSelectedId(''); void (async () => { try { const idToken = await tokenFor(backend, cloud); const next = await window.sayspec!.listApplicationFixProposals({ organizationId, projectId, target: targetType, idToken }); if (active) { setProposals(next); setSelectedId(next.at(-1)?.id ?? ''); } } catch (reason) { if (active) setError(messageOf(reason)); } })(); return () => { active = false; }; }, [organizationId, projectId, targetType, cloud]);
  function received(item: ApplicationFixProposal) { setProposals((old) => [...old.filter((entry) => entry.id !== item.id), item]); setSelectedId(item.id); setNotice('Application proposal staged. Inspect every changed path and the diff before deciding.'); }
  useEffect(() => { setReceipt(null); if (!selected || selected.status !== 'applied') return; let active = true; void (async () => { try { const idToken = await tokenFor(backend, cloud); const item = await window.sayspec!.readApplicationFixReceipt({ organizationId, projectId, testId: selected.testId, proposalId: selected.id, target: targetType, idToken }); if (active) setReceipt(item); } catch (reason) { if (active) setError(messageOf(reason)); } })(); return () => { active = false; }; }, [selected?.id, selected?.status, organizationId, projectId, targetType, cloud]);
  useEffect(() => { if (targetType !== 'flutter' || selected?.status !== 'applied') return; let active = true; void window.sayspec!.listFlutterDevices().then((items) => { if (active) { setDevices(items); setDeviceId((current) => items.some((item) => item.id === current && item.state === 'ready') ? current : items.find((item) => item.state === 'ready')?.id ?? ''); } }).catch((reason) => { if (active) setError(messageOf(reason)); }); return () => { active = false; }; }, [targetType, selected?.id, selected?.status]);
  async function decide(kind: 'approve' | 'reject') {
    if (!selected || !source) return; setBusy(true); setError('');
    try { const idToken = await tokenFor(backend, cloud); const updated = await window.sayspec!.decideApplicationFix({ organizationId, projectId, testId: selected.testId, proposalId: selected.id, target: targetType, sourceHandle: source.handle, kind, idToken }); received(updated); setNotice(kind === 'approve' ? 'Exact application patch approved for this source folder and base.' : 'Application proposal rejected. The source and original failure remain unchanged.'); }
    catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }
  async function apply() {
    if (!selected || !source) return; setBusy(true); setError('');
    try { const idToken = await tokenFor(backend, cloud); const next = await window.sayspec!.applyApplicationFix({ organizationId, projectId, testId: selected.testId, proposalId: selected.id, target: targetType, sourceHandle: source.handle, idToken }); setReceipt(next); setProposals((old) => old.map((item) => item.id === selected.id ? { ...item, status: 'applied', receiptId: next.id } : item)); setNotice(`Approved application patch applied to ${next.changedPaths.join(', ')}. The original failure remains unchanged.`); }
    catch (reason) {
      setError(messageOf(reason));
      // Recovery may have rolled back to approved or preserved an intervening edit; show the stored state.
      try { const idToken = await tokenFor(backend, cloud); setProposals(await window.sayspec!.listApplicationFixProposals({ organizationId, projectId, target: targetType, idToken })); } catch { /* keep the error visible */ }
    } finally { setBusy(false); }
  }
  async function runPatched() {
    if (!selected || !source || !receipt) return; setBusy(true); setError(''); setRerun(null);
    try { const idToken = await tokenFor(backend, cloud); const attempt = await window.sayspec!.rerunApplicationFix({ organizationId, projectId, testId: selected.testId, proposalId: selected.id, target: targetType, sourceHandle: source.handle, deviceId: targetType === 'flutter' ? deviceId : undefined, idToken }); setRerun(attempt); setNotice(`Patched rerun ${attempt.state}. Open Runs to inspect its preserved artifacts and compare it with the original failure.`); }
    catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }
  async function chooseSource() { setError(''); try { const next = await window.sayspec!.chooseSourceDirectory(); if (next) onChooseSource(next); } catch (reason) { setError(messageOf(reason)); } }
  return <section className="fixes-page" aria-label="Application fixes"><h2>Application fixes</h2><p>Application proposals require a selected source folder. Your saved test and its original failure remain unchanged.</p>
    {!source && <StatePanel tone="empty" title={targetType === 'web' ? 'Source folder required for application fixes' : 'Select the Flutter source folder'}>URL-only Web projects can still record and run tests. To propose an application change, choose the local source folder. <Button onClick={() => void chooseSource()}>Choose source folder</Button></StatePanel>}
    {source && target?.analysis.category === 'application' && <ApplicationTerminal key={`${target.attempt.id}:${target.analysis.id}:${source.handle}`} target={target} targetType={targetType} source={source} cloud={cloud} onProposal={received} />}
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!ordered.length ? <StatePanel tone="empty" title="No application proposals yet">{targetType === 'flutter' ? 'Open a failed run in Runs and choose Fix app on an App bug issue.' : 'Open a failed attempt in Runs, review its application-defect analysis, and start a fix session.'}</StatePanel>
      : <div className="fixes-grid"><div className="fixes-list" role="list" aria-label="Application proposals">{ordered.map((item) => <button key={item.id} role="listitem" type="button" aria-current={item.id === selectedId ? 'true' : undefined} onClick={() => setSelectedId(item.id)}><strong>{item.status}</strong><span>{item.changedPaths.join(', ')} · {new Date(item.createdAt).toLocaleString()}</span></button>)}</div>
        {selected && <article className="fix-detail"><h3>Application proposal</h3><p>{selected.rationale}</p><p>Attempt {selected.attemptId} · analysis {selected.analysisId} · saved test {selected.testVersionId}</p><p>Source {selected.sourceRootHash.slice(0, 16)}… · proposal {selected.proposalHash.slice(0, 16)}…</p><h4>Changed paths and review flags</h4><ul>{selected.changedPaths.map((item) => <li key={item}>{item}</li>)}{selected.reviewFlags.map((item) => <li key={item}>{item}</li>)}</ul><details open><summary>Source diff</summary><pre className="fix-diff">{selected.diff}</pre></details><div className="fix-actions">{selected.status === 'proposed' && <><Button variant="primary" disabled={busy || !source} onClick={() => void decide('approve')}>Approve exact application patch</Button><Button disabled={busy || !source} onClick={() => void decide('reject')}>Reject</Button></>}{selected.status === 'approved' && <Button variant="primary" disabled={busy || !source} onClick={() => void apply()}>Apply approved patch</Button>}{(selected.status === 'applying' || selected.status === 'recovery-required') && <><p data-testid="application-fix-interrupted">{selected.status === 'applying' ? 'This application was interrupted before SaySpec confirmed every file. Checking compares each file with its approved and original hashes, completes the receipt when every file already matches, and otherwise restores only files SaySpec wrote.' : 'An edit made outside SaySpec was preserved during recovery. Review the listed files in your checkout, then check again.'}</p><Button variant="primary" disabled={busy || !source} onClick={() => void apply()}>Check interrupted application</Button></>}{selected.status === 'applied' && <><p>Applied receipt {receipt?.id ?? selected.receiptId}. The original failure remains in Runs.</p>{targetType === 'flutter' && <label>Ready device <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><option value="">Choose device</option>{devices.filter((item) => item.state === 'ready').map((item) => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}</select></label>}<Button variant="primary" disabled={busy || !source || !receipt || (targetType === 'flutter' && !deviceId)} onClick={() => void runPatched()}>Rerun unchanged saved test on patched application</Button><Button disabled={busy || !source} onClick={() => void apply()}>Retry receipt sync</Button>{rerun && <p>Before: {selected.attemptId} failed · After: {rerun.id} {rerun.state} · version {selected.testVersionId}</p>}</>}{selected.status === 'rejected' && <p>Rejected. No application source was changed.</p>}{selected.status === 'recovery-required' && <p>Recovery preserved an intervening source edit. Review the local files before a new proposal.</p>}</div>{selected.status === 'applied' && source && <GitChanges target={{ kind: 'application-fix', organizationId, projectId, testId: selected.testId, proposalId: selected.id, sourceHandle: source.handle }} refreshKey={`${receipt?.id ?? ''}:${rerun?.id ?? ''}`} title="Commit the fix to Git" />}</article>}</div>}
  </section>;
}
