import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { CodingAgentPreference, CodingAgentReadinessReport, MachineSetupGroup, MachineSetupItem, MachineSetupReport, MachineSetupState } from '@sayspec/contracts';
import { Button, StatusLabel } from './ui';
import { AiProviderLogo } from './ai-provider-logo';
import { GitSummary } from './git-changes';

const messageOf = (error: unknown) => (error instanceof Error ? error.message.replace(/^Error:\s*/, '') : String(error));
const STATE_LABEL: Record<MachineSetupState, string> = { checking: 'Checking', missing: 'Missing', incompatible: 'Incompatible', installing: 'Installing', 'waiting-for-user': 'Waiting for you', failed: 'Failed', canceled: 'Canceled', installed: 'Installed', verified: 'Verified', unsupported: 'Not supported here' };

function statusFor(state: MachineSetupState) {
  if (state === 'installed' || state === 'verified') return 'passed' as const;
  if (state === 'incompatible' || state === 'failed') return 'blocked' as const;
  return 'warning' as const;
}

function groupCounts(group: MachineSetupGroup) {
  const relevant = group.items.filter((item) => item.state !== 'unsupported');
  return { satisfied: relevant.filter((item) => item.state === 'installed' || item.state === 'verified').length, total: relevant.length };
}

/** A selected project never sees setup lanes for another technology. */
export function groupsForProject(report: MachineSetupReport, targetType: 'web' | 'flutter') {
  return report.groups.filter((group) => targetType === 'web' ? group.workflow === 'web' : group.workflow === 'flutter-android' || group.workflow === 'flutter-ios');
}

function ItemRow({ item }: { item: MachineSetupItem }) {
  const [open, setOpen] = useState(item.state === 'missing' || item.state === 'incompatible' || item.state === 'failed');
  return <li className="setup-item" data-item-id={item.id} data-state={item.state}>
    <div className="setup-item__head">
      <button type="button" className="setup-item__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><span aria-hidden="true">{open ? '▾' : '▸'}</span><strong>{item.label}</strong></button>
      <StatusLabel status={statusFor(item.state)}>{STATE_LABEL[item.state]}</StatusLabel>
      {item.manual && !['installed', 'verified', 'unsupported'].includes(item.state) && <span className="setup-item__manual">Needs you</span>}
    </div>
    {open && <div className="setup-item__body"><p>{item.purpose}</p><p>{item.detail}</p><dl className="setup-item__meta">
      {item.detected && <div><dt>Detected</dt><dd>{item.detected}</dd></div>}{item.detectedPath && <div><dt>Path</dt><dd className="setup-path">{item.detectedPath}</dd></div>}{item.requirement && <div><dt>Required</dt><dd>{item.requirement}</dd></div>}
      {item.resolution && <div><dt>Found via</dt><dd>{item.resolution === 'login-shell' ? 'login shell PATH' : item.resolution === 'common-path' ? 'known install location' : item.resolution === 'environment' ? 'app environment' : item.resolution === 'project' ? 'project files' : 'not found'}</dd></div>}{item.expectation && <div><dt>Expect</dt><dd>{item.expectation}</dd></div>}
    </dl>{item.recovery && !['installed', 'verified'].includes(item.state) && <p className="setup-item__recovery" role="note">{item.recovery}</p>}</div>}
  </li>;
}

function WorkflowGroup({ group, open }: { group: MachineSetupGroup; open: boolean }) {
  const counts = groupCounts(group);
  return <details className="setup-group" open={open} data-workflow={group.workflow}><summary><div><strong>{group.title}</strong><span>{group.summary}</span></div><span className="setup-group__counts" data-ready={group.ready ? 'true' : 'false'}>{group.ready ? 'Ready' : `${counts.satisfied}/${counts.total} ready`}{group.unknown && !group.ready ? ' · needs you' : ''}</span></summary><ul className="setup-items">{group.items.map((item) => <ItemRow key={`${group.workflow}:${item.id}`} item={item} />)}</ul></details>;
}

const SCOPE_TEXT = {
  setup: { label: 'setup', terminal: 'machine setup', exited: 'Re-check Settings to confirm the machine state.', description: 'The AI is inspecting this project and the current checks. Installs, prompts, and project changes stay visible here.' },
  'entry-points': { label: 'entry points', terminal: 'entry points', exited: 'Saved entry points appear in Settings → Entry points.', description: 'The AI is reading this project to find how it launches. It only saves entry points and does not change the project.' },
  'test-instructions': { label: 'test instructions', terminal: 'test instructions', exited: 'Your test instructions are saved in SAYSPEC.md.', description: 'The AI looks at this project, asks how its tests could be better, and writes the answers into SAYSPEC.md. It does not change the project or its tests.' },
} as const;

/** Interactive agent terminal: full machine setup, only detecting entry points, or writing test instructions. */
export function SetupAgentDialog({ open, onOpenChange, projectId, organizationId, targetType, sourceHandle, agentName, scope = 'setup', onFinished }: { open: boolean; onOpenChange: (open: boolean) => void; projectId: string; organizationId?: string; targetType: 'web' | 'flutter'; sourceHandle?: string; agentName: string; scope?: keyof typeof SCOPE_TEXT; onFinished: () => void }) {
  const text = SCOPE_TEXT[scope];
  // State, not a ref: the dialog portal mounts its content after `open` flips, so the effect must re-run once the node exists.
  const [mount, setMount] = useState<HTMLDivElement | null>(null); const [state, setState] = useState<'starting' | 'running' | 'exited'>('starting'); const [error, setError] = useState('');
  useEffect(() => {
    if (!open || !mount) return;
    setState('starting'); setError('');
    const terminal = new Terminal({ cursorBlink: true, convertEol: true, scrollback: 10_000, fontFamily: 'SFMono-Regular, Menlo, monospace', fontSize: 13, theme: { background: '#17211d', foreground: '#e9eee9', cursor: '#e9eee9' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(mount);
    const input = terminal.onData((data) => { void window.sayspec!.writeMachineSetupAgent({ projectId, data }).catch(() => undefined); });
    const unsubscribe = window.sayspec!.onMachineSetupAgentEvent((event) => { if (event.projectId !== projectId) return; if (event.kind === 'data' && event.data) terminal.write(event.data); if (event.kind === 'started') setState('running'); if (event.kind === 'exit') { setState('exited'); terminal.write(`\r\n${agentName} exited (${event.exitCode ?? 'unknown'}). ${text.exited}\r\n`); onFinished(); } });
    const observer = new ResizeObserver(() => { if (mount.offsetWidth > 0 && mount.offsetHeight > 0) { fit.fit(); void window.sayspec!.resizeMachineSetupAgent({ projectId, cols: terminal.cols, rows: terminal.rows }); } }); observer.observe(mount);
    const launch = requestAnimationFrame(() => { fit.fit(); terminal.write(`$ ${agentName} · SaySpec ${text.label} for ${targetType}\r\n`); void window.sayspec!.startMachineSetupAgent({ projectId, organizationId, targetType, sourceHandle, scope, cols: terminal.cols, rows: terminal.rows }).then(() => { setState('running'); terminal.focus(); }).catch((reason) => { setError(messageOf(reason)); setState('exited'); }); });
    return () => { cancelAnimationFrame(launch); observer.disconnect(); unsubscribe(); input.dispose(); terminal.dispose(); void window.sayspec!.closeMachineSetupAgent({ projectId }).catch(() => undefined); };
  }, [open, mount, projectId, organizationId, targetType, sourceHandle, agentName, scope]);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content setup-agent-dialog" aria-describedby="setup-agent-description"><div className="setup-agent-dialog__head"><div><Dialog.Title>{scope === 'test-instructions' ? `Improve tests with ${agentName}` : scope === 'entry-points' ? `Add entry points with ${agentName}` : `Setup with ${agentName}`}</Dialog.Title><Dialog.Description id="setup-agent-description">{text.description}</Dialog.Description></div><Dialog.Close asChild><Button>Close</Button></Dialog.Close></div><div ref={setMount} className="setup-agent-terminal" role="region" aria-label={`Interactive ${agentName} ${text.terminal} terminal`} />{state === 'starting' && !error && <p className="settings-inline-status" role="status">Starting {agentName}…</p>}{error && <p className="inline-error" role="alert">{error}</p>}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function MachineSetupCard({ projectId, targetType, sourceHandle, onSourceRequired }: { projectId?: string; targetType?: 'web' | 'flutter'; sourceHandle?: string; onSourceRequired?: () => void }) {
  const selectedType = targetType ?? 'web'; const checkRevision = useRef(0); const [report, setReport] = useState<MachineSetupReport | null>(null); const [preference, setPreference] = useState<CodingAgentPreference>({ schemaVersion: 1 }); const [agentReadiness, setAgentReadiness] = useState<CodingAgentReadinessReport | null>(null); const [terminalOpen, setTerminalOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function check() { const revision = ++checkRevision.current; setBusy(true); setError(''); try { const [next, nextPreference, nextAgents] = await Promise.all([window.sayspec!.checkMachineSetup({ projectId, targetType: selectedType, sourceHandle }), window.sayspec!.getCodingAgentPreference(), window.sayspec!.checkCodingAgentReadiness()]); if (revision !== checkRevision.current) return; setReport(next); setPreference(nextPreference); setAgentReadiness(nextAgents); } catch (reason) { if (revision !== checkRevision.current) return; setError(messageOf(reason)); } finally { if (revision === checkRevision.current) setBusy(false); } }
  useEffect(() => { setReport(null); setTerminalOpen(false); void check(); }, [projectId, selectedType, sourceHandle]);
  useEffect(() => { const refresh = () => { void check(); }; window.addEventListener('sayspec:coding-agent-changed', refresh); return () => window.removeEventListener('sayspec:coding-agent-changed', refresh); }, [projectId, selectedType, sourceHandle]);
  const groups = report ? groupsForProject(report, selectedType) : []; const selectedAgent = agentReadiness?.providers.find((item) => item.id === preference.provider); const agentName = selectedAgent?.displayName ?? (preference.provider === 'codex' ? 'Codex' : preference.provider === 'claude-code' ? 'Claude Code' : 'Coding AI'); const canStartAgent = Boolean(projectId && sourceHandle && selectedAgent?.state === 'ready');
  return <section className="settings-card machine-setup" aria-labelledby="machine-setup-heading" data-testid="machine-setup">
    <div className="machine-setup__head"><h2 id="machine-setup-heading">Machine setup</h2><Button disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Re-check'}</Button></div>
    <section className="setup-purpose" aria-labelledby="setup-testing-heading"><div className="setup-purpose__head"><div><h3 id="setup-testing-heading">Run tests on this machine</h3></div>{selectedType === 'flutter' && <p>Flutter testing needs the source project plus a ready Android or iOS toolchain. Recording and Patrol runs work on Android devices and emulators and on iOS simulators.</p>}</div>
      {selectedType === 'flutter' && <div className="setup-requirements"><div><span><strong>Source code</strong><small>Required to build, record, and run this Flutter project</small>{sourceHandle && <GitSummary target={{ kind: 'source', sourceHandle }} />}</span><StatusLabel status={sourceHandle ? 'passed' : 'warning'}>{sourceHandle ? 'Selected' : 'Required'}</StatusLabel>{onSourceRequired && <Button onClick={onSourceRequired}>{sourceHandle ? 'Change folder' : 'Choose folder'}</Button>}</div></div>}
      {selectedType === 'flutter' && <div className="setup-stages">{([['projectBuild', 'Project build'], ['device', 'Device'], ['recordingIntegration', 'Recording integration']] as const).map(([key, label]) => { const value = report?.stages[key] ?? 'unknown'; const tone = value === 'ready' ? 'passed' : value === 'incomplete' ? 'blocked' : 'warning'; return <span className="setup-stage" key={key}><StatusLabel status={tone}>{label}: {value === 'not-required' ? 'not required' : value}</StatusLabel></span>; })}</div>}
      <div className="setup-groups">{groups.map((group, index) => <WorkflowGroup key={group.workflow} group={group} open={index === 0} />)}</div></section>
    <section className="setup-purpose" aria-labelledby="setup-fixing-heading"><div className="setup-purpose__head"><div><h3 id="setup-fixing-heading">Let AI diagnose and prepare the project</h3></div><p>Fixing requires the source code and the Coding AI selected above.</p></div>
      <div className="setup-requirements">{selectedType === 'web' && <div><span><strong>Source code</strong><small>Required for Web fixes</small>{sourceHandle && <GitSummary target={{ kind: 'source', sourceHandle }} />}</span><StatusLabel status={sourceHandle ? 'passed' : 'warning'}>{sourceHandle ? 'Selected' : 'Required'}</StatusLabel>{onSourceRequired && <Button onClick={onSourceRequired}>{sourceHandle ? 'Change folder' : 'Choose folder'}</Button>}</div>}<div><span><strong>Coding AI</strong><small>Uses your default Coding AI</small></span><StatusLabel status={selectedAgent?.state === 'ready' ? 'passed' : selectedAgent?.state === 'missing' ? 'warning' : 'blocked'}>{selectedAgent ? `${selectedAgent.displayName}: ${selectedAgent.state.replaceAll('-', ' ')}` : 'Choose AI above'}</StatusLabel></div></div>
      <div className="setup-ai-action"><Button className="setup-ai-button" variant="primary" disabled={!canStartAgent} onClick={() => setTerminalOpen(true)}>{preference.provider && <AiProviderLogo provider={preference.provider} />}<span>Setup with {agentName}</span></Button><span>{!sourceHandle ? 'Choose source code first.' : !preference.provider ? 'Choose a Coding AI above first.' : selectedAgent?.state !== 'ready' ? `${agentName} must be installed and authenticated.` : `${agentName} will inspect the source, propose setup, install approved dependencies, detect the app's entry points, and verify the result.`}</span></div></section>
    {projectId && sourceHandle && <SetupAgentDialog open={terminalOpen} onOpenChange={setTerminalOpen} projectId={projectId} targetType={selectedType} sourceHandle={sourceHandle} agentName={agentName} onFinished={() => void check()} />}{error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
