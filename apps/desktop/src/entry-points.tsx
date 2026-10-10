import { useEffect, useState, type FormEvent } from 'react';
import { validateEntryPoints, type CodingAgentProviderId, type ProjectEntryPoint, type ProjectEntryPoints } from '@sayspec/contracts';
import { AiProviderLogo } from './ai-provider-logo';
import { SetupAgentDialog } from './machine-setup';
import { Button, Field } from './ui';

const messageOf = (error: unknown) => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error:\s*/, '') : String(error));

/** The project's saved entry points on this machine, kept current when the setup agent writes new ones. */
export function useProjectEntryPoints(projectId: string | undefined, targetType: 'web' | 'flutter') {
  const [value, setValue] = useState<ProjectEntryPoints | null>(null);
  useEffect(() => {
    setValue(null);
    if (!projectId) return;
    let current = true;
    void window.sayspec!.getProjectEntryPoints({ projectId, targetType }).then((next) => { if (current) setValue(next); }).catch(() => undefined);
    const unsubscribe = window.sayspec!.onProjectEntryPointsChanged((next) => { if (next.projectId === projectId && next.targetType === targetType) setValue(next); });
    return () => { current = false; unsubscribe(); };
  }, [projectId, targetType]);
  return value;
}

/** The default Coding AI and whether it can start a session now. */
export function useCodingAgent() {
  const [agent, setAgent] = useState<{ provider?: CodingAgentProviderId; name?: string; ready: boolean }>({ ready: false });
  useEffect(() => {
    let current = true;
    const load = () => void Promise.all([window.sayspec!.getCodingAgentPreference(), window.sayspec!.checkCodingAgentReadiness()]).then(([preference, readiness]) => {
      if (!current) return;
      const provider = preference.provider ?? undefined;
      const status = readiness.providers.find((item) => item.id === provider);
      setAgent({ provider, name: status?.displayName ?? (provider === 'codex' ? 'Codex' : provider === 'claude-code' ? 'Claude Code' : undefined), ready: status?.state === 'ready' });
    }).catch(() => undefined);
    load(); window.addEventListener('sayspec:coding-agent-changed', load);
    return () => { current = false; window.removeEventListener('sayspec:coding-agent-changed', load); };
  }, []);
  return agent;
}

type Row = { key: string; name: string; command: string; url: string; appId: string };
const toRows = (entryPoints: readonly ProjectEntryPoint[]): Row[] => entryPoints.map((item) => ({ key: crypto.randomUUID(), name: item.name, command: item.command, url: item.url ?? '', appId: item.appId ?? '' }));
const sameRows = (rows: Row[], entryPoints: readonly ProjectEntryPoint[]) => rows.length === entryPoints.length && rows.every((row, index) => row.name === entryPoints[index]!.name && row.command === entryPoints[index]!.command && row.url === (entryPoints[index]!.url ?? '') && row.appId === (entryPoints[index]!.appId ?? ''));

/** Settings editor. The setup agent fills this in; the first entry is the recording default. */
export function EntryPointsCard({ projectId, targetType, sourceHandle }: { projectId: string; targetType: 'web' | 'flutter'; sourceHandle?: string }) {
  const saved = useProjectEntryPoints(projectId, targetType);
  const agent = useCodingAgent();
  const agentName = agent.name;
  const [agentOpen, setAgentOpen] = useState(false);
  const agentBlocked = !sourceHandle ? 'Choose source code first.' : !agent.provider ? 'Choose a Coding AI in Settings first.' : !agent.ready ? `${agentName} must be installed and authenticated.` : '';
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [incoming, setIncoming] = useState<ProjectEntryPoints | null>(null);
  const [adopted, setAdopted] = useState<ProjectEntryPoints | null>(null);
  const dirty = Boolean(adopted) && !sameRows(rows, adopted!.entryPoints);

  useEffect(() => { setAdopted(null); setRows([]); setIncoming(null); setStatus(''); setError(''); setAgentOpen(false); }, [projectId, targetType]);
  useEffect(() => {
    if (!saved || saved === adopted) return;
    // Unsaved edits are never overwritten by an agent write; the user chooses.
    if (adopted && dirty && saved.updatedBy === 'agent') { setIncoming(saved); return; }
    setAdopted(saved); setRows(toRows(saved.entryPoints)); setIncoming(null);
    if (adopted && saved.updatedBy === 'agent') setStatus(`${agentName ?? 'The setup agent'} saved ${saved.entryPoints.length} entry point${saved.entryPoints.length === 1 ? '' : 's'}.`);
  }, [saved]);

  const update = (key: string, patch: Partial<Row>) => { setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row)); setStatus(''); setError(''); };
  const move = (index: number) => setRows((current) => { const next = [...current]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; });
  const add = () => setRows((current) => [...current, { key: crypto.randomUUID(), name: current.length ? '' : 'Development', command: targetType === 'flutter' ? 'flutter run' : 'npm run dev', url: targetType === 'web' ? 'http://localhost:3000' : '', appId: '' }]);

  async function save(event: FormEvent) {
    event.preventDefault(); setError(''); setStatus('');
    try {
      const entryPoints = validateEntryPoints(targetType, rows.map(({ name, command, url, appId }) => ({ name, command, ...(targetType === 'web' ? { url } : { appId }) })));
      setSaving(true);
      const next = await window.sayspec!.saveProjectEntryPoints({ projectId, targetType, entryPoints });
      setAdopted(next); setRows(toRows(next.entryPoints)); setIncoming(null); setStatus('Entry points saved on this machine.');
    } catch (reason) { setError(messageOf(reason)); }
    finally { setSaving(false); }
  }

  return <section className="settings-card entry-points" aria-labelledby="entry-points-heading" data-testid="entry-points">
    <h2 id="entry-points-heading">Entry points</h2>
    <p className="entry-points__intro">{targetType === 'flutter'
      ? <>How SaySpec launches the app: <code>flutter run</code> or a custom command.</>
      : <>The URL a recording opens, and the command that serves it locally.</>}</p>
    {incoming && <div className="entry-points__incoming" role="status"><span>{agentName ?? 'The setup agent'} saved new entry points while you were editing.</span><Button type="button" onClick={() => { setAdopted(incoming); setRows(toRows(incoming.entryPoints)); setIncoming(null); }}>Use detected entry points</Button></div>}
    <form className="entry-points__form" onSubmit={save}>
      {rows.length === 0 ? <p className="entry-points__empty">{targetType === 'flutter' ? 'No entry points yet. Recording uses plain flutter run until you add one.' : 'No entry points yet. Recording uses the project base URL until you add one.'}</p>
        : <ol className="entry-points__list">{rows.map((row, index) => <li key={row.key} className="entry-point-row">
          <div className="entry-point-row__head"><strong>{index === 0 ? 'Default' : `Entry point ${index + 1}`}</strong>
            <span className="entry-point-row__actions">
              <Button type="button" variant="quiet" disabled={index === 0} onClick={() => move(index)} aria-label={`Move ${row.name || `entry point ${index + 1}`} up`} title={index === 1 ? 'Make default' : 'Move up'}>↑</Button>
              <Button type="button" variant="quiet" onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))} aria-label={`Remove ${row.name || `entry point ${index + 1}`}`}>Remove</Button>
            </span></div>
          <div className="entry-point-row__fields">
            <Field id={`entry-point-name-${row.key}`} label="Name" value={row.name} placeholder="Development" onChange={(event) => update(row.key, { name: event.target.value })} required />
            <Field id={`entry-point-command-${row.key}`} className="entry-point-row__command" label={targetType === 'flutter' ? 'Run command' : 'Start command (optional)'} value={row.command} spellCheck={false} autoCapitalize="off" autoCorrect="off"
              placeholder={targetType === 'flutter' ? 'fvm flutter run --flavor dev' : 'npm run dev'} onChange={(event) => update(row.key, { command: event.target.value })} required={targetType === 'flutter'} />
            {targetType === 'web' ? <Field id={`entry-point-url-${row.key}`} label="URL" type="url" value={row.url} placeholder="http://localhost:5173" onChange={(event) => update(row.key, { url: event.target.value })} required />
              : <Field id={`entry-point-app-id-${row.key}`} className="entry-point-row__command" label="Application ID" value={row.appId} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder="From Gradle when empty"
                title="The ID this entry point installs as, such as com.example.shop.dev. SaySpec uses it to restart the app between tests." onChange={(event) => update(row.key, { appId: event.target.value })} />}
          </div>
        </li>)}</ol>}
      <div className="entry-points__actions">
        <Button type="button" onClick={add} disabled={rows.length >= 12}>Add entry point</Button>
        <Button type="button" className="setup-ai-button" disabled={Boolean(agentBlocked)} title={agentBlocked || undefined} onClick={() => setAgentOpen(true)}>{agent.provider && <AiProviderLogo provider={agent.provider} />}<span>Add with {agentName ?? 'Coding AI'}</span></Button>
        <Button type="submit" variant="primary" disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save entry points'}</Button>
        {adopted?.updatedAt && !dirty && <span className="entry-points__meta">{adopted.updatedBy === 'agent' ? 'Detected by AI' : 'Edited'} · {new Date(adopted.updatedAt).toLocaleString()}</span>}
      </div>
      {agentBlocked && <p className="entry-points__empty">{agentBlocked}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {status && <p className="settings-inline-status" role="status">{status}</p>}
    </form>
    {sourceHandle && agentName && <SetupAgentDialog open={agentOpen} onOpenChange={setAgentOpen} projectId={projectId} targetType={targetType} sourceHandle={sourceHandle} agentName={agentName} scope="entry-points" onFinished={() => undefined} />}
  </section>;
}

/** Recording picker; the first saved entry point is selected by default. */
export function EntryPointSelect({ entryPoints, value, onChange, fallback, disabled }: { entryPoints: readonly ProjectEntryPoint[]; value: string; onChange: (name: string) => void; fallback: string; disabled?: boolean }) {
  const selected = entryPoints.find((item) => item.name === value);
  return <div className="entry-point-select">
    <label className="select-field">Entry point<select aria-label="Entry point" value={selected ? value : ''} disabled={disabled || entryPoints.length === 0} onChange={(event) => onChange(event.target.value)}>
      {entryPoints.length === 0 ? <option value="">{fallback}</option> : entryPoints.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
    </select></label>
    {selected ? <span className="entry-point-select__details"><code className="entry-point-select__command">{selected.command || selected.url}</code>{selected.appId && <code className="entry-point-select__command">{selected.appId}</code>}</span>
      : <span className="control-help">Add flavors or environments in Settings → Entry points.</span>}
  </div>;
}
