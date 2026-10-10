import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { FailureAnalysis, ManagedTestFixProposal, SavedWebTestAttempt } from '@sayspec/contracts';
import type { CloudBackend } from './cloud/backend';
import { useCloud } from './cloud/context';
import { Button, StatePanel } from './ui';

export type FixTarget = { attempt: SavedWebTestAttempt; analysis: FailureAnalysis };
const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error:\s*/, '') : String(error);
/** The bearer token the main process forwards to the cloud backend for a cloud project's fix decisions; none for local projects. */
async function tokenFor(backend: CloudBackend | null, cloud: boolean) { const token = cloud ? await backend?.auth.idToken() : undefined; if (cloud && !token) throw new Error('Sign in again to review this Pro fix.'); return token; }

function FixTerminal({ target, cloud, onProposal }: { target: FixTarget; cloud: boolean; onProposal: (proposal: ManagedTestFixProposal) => void }) {
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
        const started = await window.sayspec!.startManagedFixSession({ organizationId: attempt.organizationId, projectId: attempt.projectId, testId: attempt.testId, attemptId: attempt.id, analysisId: target.analysis.id, cols: terminal.cols, rows: terminal.rows, idToken });
        if (disposed) { await window.sayspec!.closeManagedFixSession({ attemptId: attempt.id, sessionToken: started.sessionToken }); return; }
        session.current = started.sessionToken; setState('running'); terminal.focus();
      } catch (reason) { if (!disposed) { setError(messageOf(reason)); setState('error'); } }
    })();
    return () => { disposed = true; observer.disconnect(); unsubscribe(); input.dispose(); terminal.dispose(); if (session.current) void window.sayspec!.closeManagedFixSession({ attemptId: attempt.id, sessionToken: session.current }); session.current = ''; };
  }, [target.attempt.id, target.analysis.id, cloud]);
  return <section className="fix-terminal" aria-label="Interactive AI fix session"><p>Your selected coding agent proposes changes in an isolated session with read-only access to the project test library. Review the diff below before approving a new version.</p><div ref={mount} className="fix-terminal__screen" role="region" aria-label="Coding-agent fix terminal" />{state === 'starting' && <p role="status">Preparing the fix session…</p>}{state === 'running' && <Button onClick={() => { if (session.current) void window.sayspec!.closeManagedFixSession({ attemptId: target.attempt.id, sessionToken: session.current }); }}>End session</Button>}{error && <p className="inline-error" role="alert">{error}</p>}</section>;
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
          <div className="fix-actions">{selected.status === 'proposed' && <><Button variant="primary" disabled={busy} onClick={() => void decide('approve')}>Approve exact patch</Button><Button disabled={busy} onClick={() => void decide('reject')}>Reject</Button></>}{selected.status === 'approved' && <Button variant="primary" disabled={busy} onClick={() => void apply()}>Apply approved patch</Button>}{selected.status === 'applied' && <><p>Applied as version {selected.appliedVersionId}. The original failure remains in Runs.</p><Button disabled={busy} onClick={() => void apply()}>Retry sync and validation</Button></>}{selected.status === 'rejected' && <p>Rejected. No managed test was changed.</p>}</div></article>}</div>}
  </section>;
}
