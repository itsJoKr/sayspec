import { useEffect, useState } from 'react';
import type { CodingAgentPreference, CodingAgentProviderId, CodingAgentReadinessReport } from '@sayspec/contracts';
import { Button, StatusLabel } from './ui';
import { AiProviderLogo } from './ai-provider-logo';

function messageOf(error: unknown) { return error instanceof Error ? error.message.replace(/^Error:\s*/, '') : 'The AI preference could not be updated.'; }

export function AiProviderSettings() {
  const [preference, setPreference] = useState<CodingAgentPreference>({ schemaVersion: 1 });
  const [readiness, setReadiness] = useState<CodingAgentReadinessReport | null>(null);
  const [checking, setChecking] = useState<CodingAgentProviderId | null>(null);
  const [message, setMessage] = useState(''); const [error, setError] = useState('');

  async function refresh() {
    const [nextPreference, nextReadiness] = await Promise.all([
      window.sayspec!.getCodingAgentPreference(),
      window.sayspec!.checkCodingAgentReadiness(),
    ]);
    setPreference(nextPreference); setReadiness(nextReadiness);
  }

  useEffect(() => { void refresh().catch((reason) => setError(messageOf(reason))); }, []);

  async function choose(provider: CodingAgentProviderId) {
    setChecking(provider); setMessage('Checking your terminal…'); setError('');
    try {
      const result = await window.sayspec!.selectCodingAgentProvider({ provider });
      setPreference(result.preference);
      await refresh();
      window.dispatchEvent(new CustomEvent('sayspec:coding-agent-changed'));
      if (result.installPageOpened) setMessage(`${result.readiness.displayName} was not found. Its official installation guide is open. Install it, then check again.`);
      else if (result.readiness.state === 'ready') setMessage(`${result.readiness.displayName} is installed, authenticated, and selected.`);
      else setMessage(`${result.readiness.displayName} is installed and selected. ${result.readiness.detail}`);
    } catch (reason) { setMessage(''); setError(messageOf(reason)); }
    finally { setChecking(null); }
  }

  const selectedReadiness = readiness?.providers.find((item) => item.id === preference.provider);
  return <section className="settings-card ai-provider-settings" aria-labelledby="ai-provider-heading" data-testid="ai-provider-settings">
    <h2 id="ai-provider-heading">Coding AI</h2>
    <div className="ai-default-row">
      <label className="select-field">Default AI<span className="provider-select"><AiProviderLogo provider={preference.provider} /><select aria-label="Default AI" data-testid="default-ai-select" value={preference.provider ?? ''} disabled={checking !== null} onChange={(event) => void choose(event.target.value as CodingAgentProviderId)}><option value="" disabled>Choose AI</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option></select></span></label>
      <Button variant="quiet" onClick={() => void refresh().catch((reason) => setError(messageOf(reason)))} disabled={checking !== null}>Check connection</Button>
    </div>
    {selectedReadiness && <div className="ai-default-status">{selectedReadiness.state !== 'ready' && <StatusLabel status={selectedReadiness.state === 'missing' ? 'warning' : 'blocked'}>{selectedReadiness.state.replaceAll('-', ' ')}</StatusLabel>}{selectedReadiness.state === 'ready' && selectedReadiness.qualification === 'untested-version' ? <><StatusLabel status="passed">Detected</StatusLabel><span className="ai-version-note" title={`SaySpec tested ${selectedReadiness.displayName} ${selectedReadiness.testedVersion ?? 'a different version'}`}>{selectedReadiness.displayName} {selectedReadiness.version} detected, this version was not tested by SaySpec</span></> : <span>{selectedReadiness.detail}</span>}</div>}
    {!readiness && !error && <p className="settings-inline-status" role="status">Checking connection…</p>}
    {message && <p className="settings-inline-status" role="status">{message}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
