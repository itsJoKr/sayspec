import { useEffect, useState } from 'react';
import type { TestInstructionsView, TestStorageMode } from '@sayspec/contracts';
import { useCloud } from './cloud/context';
import { AiProviderLogo } from './ai-provider-logo';
import { useCodingAgent } from './entry-points';
import { SetupAgentDialog } from './machine-setup';
import { Button } from './ui';

/** Something on this Mac may have changed SAYSPEC.md (the instructions session ended). */
const EDITED = 'sayspec:test-instructions-edited';
/** This Mac's copy was reconciled with SaySpec Cloud. */
const SYNCED = 'sayspec:test-instructions-synced';

function messageOf(reason: unknown) { return reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^(Firebase)?Error:\s*/, '') : 'The request failed.'; }

/**
 * Keeps this Mac's SAYSPEC.md and a SaySpec Cloud project's shared copy in step:
 * a teammate's change is written to the file, and an edit made here (in Finder
 * or by the instructions session) is uploaded when SaySpec regains focus or the
 * session ends. Generation always reads the file, so it sees the latest text.
 */
export function useCloudTestInstructionsSync(input: { enabled: boolean; organizationId: string; projectId: string }) {
  const { enabled, organizationId, projectId } = input;
  const cloud = useCloud();
  useEffect(() => {
    if (!enabled || !projectId || !cloud) return;
    const backend = cloud;
    const scope = { organizationId, projectId };
    let cloudText: string | null | undefined; let running = false; let again = false; let active = true;
    async function sync() {
      if (cloudText === undefined) return;
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          const { upload } = await window.sayspec!.syncCloudTestInstructions({ ...scope, cloudText: cloudText ?? null });
          if (upload !== undefined && active) { await backend.projects.setTestInstructions({ ...scope, text: upload }); cloudText = upload; again = true; }
        } while (again && active);
        window.dispatchEvent(new Event(SYNCED));
      } catch { /* Retried on the next focus or edit. */ }
      finally { running = false; }
    }
    const unsubscribe = backend.projects.subscribeTestInstructions(scope, (text) => { cloudText = text; void sync(); });
    const onChange = () => void sync();
    window.addEventListener('focus', onChange); window.addEventListener(EDITED, onChange);
    return () => { active = false; unsubscribe(); window.removeEventListener('focus', onChange); window.removeEventListener(EDITED, onChange); };
  }, [cloud, enabled, organizationId, projectId]);
}

const WHERE: Record<TestStorageMode, string> = {
  local: 'Kept next to your tests on this Mac.',
  folder: 'Kept next to your tests in the storage folder, so it can be committed with them.',
  cloud: 'Shared with your team through SaySpec Cloud; this Mac keeps a copy in sync.',
};

/** Settings card for the project's SAYSPEC.md: what the AI should know to write better tests here. */
export function TestInstructionsCard({ organizationId, projectId, targetType, sourceHandle, storage }: { organizationId: string; projectId: string; targetType: 'web' | 'flutter'; sourceHandle?: string; storage?: TestStorageMode }) {
  const [view, setView] = useState<TestInstructionsView | null>(null);
  const [error, setError] = useState('');
  const [agentOpen, setAgentOpen] = useState(false);
  const agent = useCodingAgent();
  useEffect(() => {
    let active = true; setView(null); setError(''); setAgentOpen(false);
    const load = () => void window.sayspec!.getTestInstructions({ organizationId, projectId }).then((next) => { if (active) setView(next); }).catch((reason) => { if (active) setError(messageOf(reason)); });
    load();
    for (const name of ['focus', EDITED, SYNCED, 'sayspec:test-storage-changed']) window.addEventListener(name, load);
    return () => { active = false; for (const name of ['focus', EDITED, SYNCED, 'sayspec:test-storage-changed']) window.removeEventListener(name, load); };
  }, [organizationId, projectId, storage]);
  const missingFolder = view?.state === 'missing-folder';
  const agentBlocked = missingFolder ? 'Choose the test storage folder first.' : !agent.provider ? 'Choose a Coding AI in Settings first.' : !agent.ready ? `${agent.name} must be installed and authenticated.` : '';

  async function reveal() {
    setError('');
    try { await window.sayspec!.revealTestInstructions({ organizationId, projectId, targetType }); window.dispatchEvent(new Event(EDITED)); }
    catch (reason) { setError(messageOf(reason)); }
  }

  return <section className="settings-card test-instructions" aria-labelledby="test-instructions-heading" data-testid="test-instructions">
    <h2 id="test-instructions-heading">Test instructions</h2>
    <p className="entry-points__intro">What the AI should know to write better tests for this project. SaySpec gives <code>SAYSPEC.md</code> to the AI every time it writes or fixes a test.</p>
    {!view ? <p className="control-help" role="status">{error ? '' : 'Checking test instructions…'}</p> : <div className="storage-current" data-testid="test-instructions-current">
      <strong>{missingFolder ? 'No folder on this Mac yet' : view.written ? 'Written' : 'Not written yet'}</strong>
      <span>{missingFolder ? 'Choose where this project’s test folder is under Test storage.' : storage ? WHERE[storage] : ''}</span>
      {view.displayPath && <span title={view.displayPath}>{view.displayPath}{view.written && view.updatedAt ? ` · updated ${new Date(view.updatedAt).toLocaleString()}` : ''}</span>}
      <div className="storage-current__actions">
        <Button type="button" variant="quiet" disabled={missingFolder} onClick={() => void reveal()}>Show in Finder</Button>
        <Button type="button" className="setup-ai-button" disabled={Boolean(agentBlocked)} title={agentBlocked || undefined} onClick={() => setAgentOpen(true)}>{agent.provider && <AiProviderLogo provider={agent.provider} />}<span>{view.written ? 'Improve' : 'Write'} with {agent.name ?? 'Coding AI'}</span></Button>
      </div>
    </div>}
    {view && agentBlocked && <p className="control-help">{agentBlocked}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {agent.name && <SetupAgentDialog open={agentOpen} onOpenChange={(open) => { setAgentOpen(open); if (!open) window.dispatchEvent(new Event(EDITED)); }} projectId={projectId} organizationId={organizationId} targetType={targetType} sourceHandle={sourceHandle} agentName={agent.name} scope="test-instructions" onFinished={() => window.dispatchEvent(new Event(EDITED))} />}
  </section>;
}
