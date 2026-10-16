import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { isProPlan, type LocalSourceSelection, type PlanKind, type TestStorageCopyResult, type TestStorageMode, type TestStorageSettings } from '@sayspec/contracts';
import { useCloud } from './cloud/context';
import { announceTestStorageChange } from './test-repository';
import { countTests, switchTestStorage } from './test-storage-transfer';
import { Button } from './ui';
import { GitSummary } from './git-changes';

function messageOf(reason: unknown) { return reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^(Firebase)?Error:\s*/, '') : 'Test storage could not be changed.'; }

export const STORAGE_LABELS: Record<TestStorageMode, { title: string; detail: string }> = {
  local: { title: 'Local', detail: 'Kept by SaySpec on your Mac.' },
  cloud: { title: 'SaySpec Cloud', detail: 'Easily sync with colleagues.' },
  folder: { title: 'Folder location', detail: 'A folder of your choice, such as a git repository.' },
};

/** Why SaySpec Cloud cannot be chosen, or undefined when it can. The server enforces the same rules. */
export function cloudUnavailableReason(input: { signedIn: boolean; plan: PlanKind | null }) {
  if (!input.signedIn) return 'Sign in to a workspace on the Pro plan to use SaySpec Cloud.';
  if (!isProPlan(input.plan)) return 'Available on the Pro plan.';
  return undefined;
}

/** The storage to preselect for a new project: SaySpec Cloud when it is allowed, otherwise Local. */
export const defaultStorage = (cloudReason: string | undefined): TestStorageMode => cloudReason ? 'local' : 'cloud';

/** Local, SaySpec Cloud or Folder location, with a folder picker for Folder location. */
export function StorageChoice({ name, value, onChange, folder, onFolder, cloudReason, current, disabled }: { name: string; value: TestStorageMode; onChange: (mode: TestStorageMode) => void; folder: LocalSourceSelection | null; onFolder: (folder: LocalSourceSelection) => void; cloudReason?: string; current?: TestStorageMode; disabled?: boolean }) {
  const [error, setError] = useState('');
  // A local-only build has no SaySpec Cloud to offer.
  const modes: TestStorageMode[] = useCloud() ? ['local', 'cloud', 'folder'] : ['local', 'folder'];
  async function chooseFolder() {
    setError('');
    try { const next = await window.sayspec!.chooseTestStorageFolder(); if (next) { onFolder(next); onChange('folder'); } }
    catch (reason) { setError(messageOf(reason)); }
  }
  return <div className="storage-options" role="radiogroup" aria-label="Where tests are stored">
    {modes.map((mode) => {
      const unavailable = mode === 'cloud' ? cloudReason : undefined;
      return <label key={mode} className="storage-option" data-selected={value === mode} data-disabled={Boolean(unavailable) || undefined}>
        <input type="radio" name={name} value={mode} checked={value === mode} disabled={disabled || Boolean(unavailable)} onChange={() => { onChange(mode); if (mode === 'folder' && !folder) void chooseFolder(); }} />
        <span>
          <strong>{STORAGE_LABELS[mode].title}{mode === 'cloud' && <em className="plan-badge">Pro</em>}{current === mode && <em className="current-badge">Current</em>}</strong>
          <small>{unavailable ?? STORAGE_LABELS[mode].detail}</small>
          {mode === 'folder' && value === 'folder' && <span className="storage-option__folder"><span>{folder ? folder.label : 'No folder chosen'}</span><Button type="button" variant="quiet" disabled={disabled} onClick={(event) => { event.preventDefault(); void chooseFolder(); }}>{folder ? 'Change folder' : 'Choose folder'}</Button></span>}
        </span>
      </label>;
    })}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}

/** Settings card showing where the project's tests live, with a way to switch that copies the tests over. */
export function TestStorageSettingsCard({ organizationId, projectId, targetType, signedIn, plan, canManage, settings }: { organizationId: string; projectId: string; targetType: 'web' | 'flutter'; signedIn: boolean; plan: PlanKind | null; canManage: boolean; settings: TestStorageSettings | null }) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const mode = settings?.mode;
  async function relinkFolder() {
    setError('');
    try {
      const folder = await window.sayspec!.chooseTestStorageFolder();
      if (folder) { await window.sayspec!.configureTestStorage({ organizationId, projectId, targetType, mode: 'folder', folderHandle: folder.handle }); announceTestStorageChange(); }
    } catch (reason) { setError(messageOf(reason)); }
  }
  return <section className="settings-card test-storage-settings" aria-labelledby="test-storage-heading" data-testid="test-storage-settings">
    <h2 id="test-storage-heading">Test storage</h2>
    {!mode ? <p className="control-help" role="status">Checking test storage…</p> : <div className="storage-current" data-testid="test-storage-current">
      <strong>{STORAGE_LABELS[mode].title}</strong>
      <span>{mode === 'folder' ? settings.folder ? <span title={settings.folder.displayPath}>{settings.folder.displayPath}</span> : 'This Mac does not know where the folder is yet.' : STORAGE_LABELS[mode].detail}</span>
      {mode === 'folder' && <div className="storage-current__actions">
        {settings.folder && <Button type="button" variant="quiet" disabled={!settings.folder.available} onClick={() => void window.sayspec!.revealTestStorageFolder({ projectId }).catch((reason) => setError(messageOf(reason)))}>Show in Finder</Button>}
        {/* Each teammate points at their own checkout, so anyone can set the folder for this Mac. */}
        {(!settings.folder || !settings.folder.available) && <Button type="button" onClick={() => void relinkFolder()}>Choose folder on this Mac</Button>}
      </div>}
    </div>}
    {mode === 'folder' && settings?.folder?.available && <p className="control-help"><GitSummary key={settings.folder.displayPath} target={{ kind: 'tests', organizationId, projectId }} /></p>}
    {settings?.folder && !settings.folder.available && mode === 'folder' && <p className="inline-error" role="alert">The folder is missing. Reconnect the drive or choose the folder again.</p>}
    <button type="button" className="text-button" data-testid="switch-test-storage" disabled={!mode || !canManage} onClick={() => setSwitching(true)}>Switch storage</button>
    {!canManage && <p className="control-help">Only an organization owner or admin can switch where this project’s tests are stored.</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {mode && switching && <SwitchStorageDialog organizationId={organizationId} projectId={projectId} targetType={targetType} signedIn={signedIn} current={mode} cloudReason={cloudUnavailableReason({ signedIn, plan })} onClose={() => setSwitching(false)} />}
  </section>;
}

function SwitchStorageDialog({ organizationId, projectId, targetType, signedIn, current, cloudReason, onClose }: { organizationId: string; projectId: string; targetType: 'web' | 'flutter'; signedIn: boolean; current: TestStorageMode; cloudReason?: string; onClose: () => void }) {
  const [target, setTarget] = useState<TestStorageMode>(current);
  const [folder, setFolder] = useState<LocalSourceSelection | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [held, setHeld] = useState<TestStorageCopyResult | null>(null);
  const cloud = useCloud();
  useEffect(() => { let active = true; countTests(cloud, { organizationId, projectId }, current).then((value) => { if (active) setCount(value); }).catch(() => { if (active) setCount(null); }); return () => { active = false; }; }, [cloud, organizationId, projectId, current]);
  useEffect(() => { setHeld(null); setError(''); }, [target, folder]);
  const ready = target !== current && (target !== 'folder' || Boolean(folder)) && !(target === 'cloud' && cloudReason);
  async function submit(switchDespiteFailures = false) {
    if (!ready) return;
    setBusy(true); setError('');
    try {
      const result = await switchTestStorage(cloud, { organizationId, projectId, targetType, from: current, to: target, signedIn, switchDespiteFailures, ...(folder && target === 'folder' ? { folderHandle: folder.handle } : {}) });
      if (result.switched) onClose(); else setHeld(result);
    } catch (reason) { setError(messageOf(reason)); }
    finally { setBusy(false); }
  }
  const tests = count === null ? 'All tests' : count === 1 ? 'The 1 test' : `All ${count} tests`;
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content switch-storage-dialog" aria-describedby="switch-storage-description">
    <Dialog.Title>Switch test storage</Dialog.Title>
    <Dialog.Description id="switch-storage-description">{tests} in {STORAGE_LABELS[current].title} will be copied to the new storage, keeping their suites and authors. SaySpec then uses only the new storage{signedIn ? ' for everyone on this project' : ''}; the copies in {STORAGE_LABELS[current].title} stay where they are.</Dialog.Description>
    <StorageChoice name={`switch-storage-${projectId}`} value={target} onChange={setTarget} folder={folder} onFolder={setFolder} cloudReason={cloudReason} current={current} disabled={busy} />
    {held && <div className="storage-copy-failures" role="alert"><strong>{held.copied} copied, {held.failed.length} could not be copied:</strong><ul>{held.failed.slice(0, 8).map((item, index) => <li key={index}>{item.title}: {item.reason}</li>)}</ul>{held.failed.length > 8 && <p>…and {held.failed.length - 8} more.</p>}<p>If you switch anyway, these tests stay only in {STORAGE_LABELS[current].title}.</p></div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="dialog-actions"><Dialog.Close asChild><Button type="button" disabled={busy}>Cancel</Button></Dialog.Close>
      {held ? <Button type="button" variant="primary" disabled={busy} onClick={() => void submit(true)}>{busy ? 'Switching…' : 'Switch anyway'}</Button>
        : <Button type="button" variant="primary" data-testid="switch-test-storage-confirm" disabled={busy || !ready} onClick={() => void submit()}>{busy ? 'Copying tests…' : 'Switch and copy tests'}</Button>}
    </div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

/** Shown instead of the library when the project uses Folder storage and this Mac has not been told where the folder is. */
export function ChooseStorageFolderPanel({ organizationId, projectId, targetType }: { organizationId: string; projectId: string; targetType: 'web' | 'flutter' }) {
  const [error, setError] = useState('');
  async function choose() {
    setError('');
    try {
      const folder = await window.sayspec!.chooseTestStorageFolder();
      if (folder) { await window.sayspec!.configureTestStorage({ organizationId, projectId, targetType, mode: 'folder', folderHandle: folder.handle }); announceTestStorageChange(); }
    } catch (reason) { setError(messageOf(reason)); }
  }
  return <section className="state-panel state-panel--empty" aria-label="Choose test folder">
    <span className="state-panel__icon" aria-hidden="true">○</span>
    <div><h3>Where is this project’s test folder?</h3><p>This project keeps its tests in a folder, such as a git repository. Choose your copy of that folder on this Mac.</p><Button variant="primary" onClick={() => void choose()}>Choose folder</Button>{error && <p className="inline-error" role="alert">{error}</p>}</div>
  </section>;
}
