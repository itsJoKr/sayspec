import { useEffect, useState, type ReactNode } from 'react';
import type { CodingAgentProviderId, LocalTranscriptionSetup } from '@sayspec/contracts';
import { AiProviderLogo } from './ai-provider-logo';
import { CLOUD_NARRATION, cloudNarrationLabel, type NarrationChoice } from './narration-model-preference';

export type RecordingsSidebarItem = { id: string; title: string; meta: string; detail?: string; status?: ReactNode };

/**
 * Record page frame: the content area on the left (new recording or a
 * recording's detail) and a full-height Recordings sidebar on the right.
 * Runs uses the same frame with its test runs in the sidebar.
 */
export function RecordLayout({ title = 'Record', sidebar, children }: { title?: string; sidebar: ReactNode; children: ReactNode }) {
  return <div className="record-layout">
    <div className="record-layout__content">
      <header className="page-header"><h1 className="page-title">{title}</h1></header>
      {children}
    </div>
    {sidebar}
  </div>;
}

export function RecordingsSidebar({ title = 'Recordings', newLabel = title === 'Sessions' ? 'New session' : 'New recording', empty = 'Finished recordings appear here.', items, selectedId, onSelect, onNew, live }: {
  title?: string;
  /** Tooltip of the New button. */
  newLabel?: string;
  empty?: string;
  items: readonly RecordingsSidebarItem[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Shown on the New button while a recording session keeps running behind a detail view. */
  live?: string;
}) {
  return <aside className="recordings-sidebar" aria-labelledby="recordings-title">
    <div className="recordings-sidebar__head">
      <h2 id="recordings-title">{title}</h2>
      {items.length > 0 && <span className="recordings-sidebar__count">{items.length}</span>}
      <button type="button" className="recordings-sidebar__new" aria-pressed={!selectedId} onClick={onNew} title={newLabel}>
        {live ? <><span className="capture-dot" aria-hidden="true" />{live}</> : <><span aria-hidden="true">+</span>New</>}
      </button>
    </div>
    {items.length ? <div className="recording-list">{items.map((item) => <button key={item.id} type="button" data-selected={selectedId === item.id} aria-pressed={selectedId === item.id} onClick={() => onSelect(item.id)}>
      <strong>{item.title}</strong><span>{item.meta}</span>{item.detail && <small>{item.detail}</small>}{item.status}
    </button>)}</div>
      : <div className="recordings-empty"><span className="recording-glyph" aria-hidden="true">●</span><h3>No {title.toLowerCase()} yet</h3><p>{empty}</p></div>}
  </aside>;
}

/** The selected coding AI, shared with Settings; changing it here changes the default. */
export function useCodingAgent() {
  const [provider, setProvider] = useState<CodingAgentProviderId | undefined>();
  const [choosing, setChoosing] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const load = () => void window.sayspec!.getCodingAgentPreference().then((preference) => setProvider(preference.provider)).catch(() => undefined);
    load(); window.addEventListener('sayspec:coding-agent-changed', load);
    return () => window.removeEventListener('sayspec:coding-agent-changed', load);
  }, []);
  async function choose(next: CodingAgentProviderId) {
    setChoosing(true); setNotice('');
    try {
      const result = await window.sayspec!.selectCodingAgentProvider({ provider: next });
      setProvider(result.preference.provider);
      window.dispatchEvent(new CustomEvent('sayspec:coding-agent-changed'));
      if (result.installPageOpened) setNotice(`${result.readiness.displayName} was not found. Its installation guide is open.`);
      else if (result.readiness.state !== 'ready') setNotice(result.readiness.detail);
    } catch (reason) { setNotice(reason instanceof Error ? reason.message.replace(/^Error:\s*/, '') : 'The AI could not be changed.'); }
    finally { setChoosing(false); }
  }
  const name = provider === 'codex' ? 'Codex' : provider === 'claude-code' ? 'Claude Code' : 'coding agent';
  return { provider, name, choose, choosing, notice };
}

/** Compact narration-model and AI pickers that sit next to Generate tests. */
export function GenerationPickers({ setup, narration, agent, disabled }: {
  setup: LocalTranscriptionSetup | null;
  narration: NarrationChoice;
  agent: ReturnType<typeof useCodingAgent>;
  disabled?: boolean;
}) {
  return <div className="generation-pickers">
    <label className="compact-select"><span>Narration</span>
      <select aria-label="Transcription model" value={narration.engine === 'cloud' ? CLOUD_NARRATION : setup?.model.id ?? ''} disabled={disabled} onChange={(event) => narration.select(event.target.value)}>
        {setup ? <option value={setup.model.id}>{setup.model.displayName}</option> : <option value="">Checking…</option>}
        {narration.offered && <option value={CLOUD_NARRATION} disabled={!narration.available}>{cloudNarrationLabel(narration.available)}</option>}
      </select>
    </label>
    <label className="compact-select"><span>AI</span>
      <span className="provider-select"><AiProviderLogo provider={agent.provider} /><select aria-label="AI" value={agent.provider ?? ''} disabled={disabled || agent.choosing} onChange={(event) => void agent.choose(event.target.value as CodingAgentProviderId)}>
        <option value="" disabled>Choose AI</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option>
      </select></span>
    </label>
  </div>;
}
