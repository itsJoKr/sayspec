import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { LocalProject, LocalSourceSelection, LocalWorkspaceSnapshot, TestStorageMode, TestStorageSettings } from '@sayspec/contracts';
import { NarrationSettings } from './transcription-settings';
import { Button, Field, StatePanel } from './ui';
import { AiProviderSettings } from './ai-provider-settings';
import { MachineSetupCard } from './machine-setup';
import { EntryPointsCard } from './entry-points';
import { OnboardingPage } from './onboarding';
import { DeleteProjectButton } from './delete-project';
import { StorageChoice, TestStorageSettingsCard, cloudUnavailableReason } from './test-storage-settings';
import { TestInstructionsCard } from './test-instructions';

const empty: LocalWorkspaceSnapshot = { projects: [], tests: [], suites: [] };
function messageOf(error: unknown) { return error instanceof Error ? error.message.replace(/^Error:\s*/, '') : 'The local workspace could not be updated.'; }

export function useLocalWorkspace() {
  const [snapshot, setSnapshot] = useState(empty);
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  async function refresh(preferredProjectId?: string) {
    try {
      const next = await window.sayspec!.getLocalWorkspace();
      setSnapshot(next); setStatus('ready'); setMessage('');
      setProjectId((current) => {
        const preferred = preferredProjectId ?? current;
        return next.projects.some((item) => item.id === preferred) ? preferred : next.projects[0]?.id ?? '';
      });
    } catch (error) { setStatus('error'); setMessage(messageOf(error)); }
  }
  useEffect(() => { void refresh(); }, []);
  return { ...snapshot, projectId, status, message, selectProject: setProjectId, refresh };
}

export function LocalProjectOnboarding({ project, projectPending, source, onChooseSource, onCreated, onUsePro, onFinish }: { project?: LocalProject; projectPending: boolean; source?: LocalSourceSelection | null; onChooseSource: (source: LocalSourceSelection) => void; onCreated: (project: LocalProject, source: LocalSourceSelection | null) => void; onUsePro?: () => void; onFinish: () => void }) {
  return <OnboardingPage testId="local-project-gate" account={onUsePro && <div className="gate-account"><Button variant="quiet" onClick={onUsePro}>Sign in</Button></div>}
    project={project} projectPending={projectPending} source={source} onChooseSource={onChooseSource} onFinish={onFinish} waitingHint="Create a project to continue."
    projectStep={<section className="settings-card"><h2>Project</h2><LocalProjectCreationForm compact onCreated={onCreated} /></section>} />;
}

export function LocalProjectCreationForm({ onCreated, compact = false }: { onCreated: (project: LocalProject, source: LocalSourceSelection | null) => void; compact?: boolean }) {
  const [name, setName] = useState(''); const [technology, setTechnology] = useState<'web' | 'flutter'>('web');
  const [baseUrl, setBaseUrl] = useState('');
  const [source, setSource] = useState<LocalSourceSelection | null>(null); const [creating, setCreating] = useState(false); const [error, setError] = useState('');
  const [storage, setStorage] = useState<TestStorageMode>('local'); const [storageFolder, setStorageFolder] = useState<LocalSourceSelection | null>(null);
  const baseUrlError = technology === 'web' && baseUrl && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(baseUrl) ? 'Enter a complete HTTP(S) URL.' : undefined;
  async function chooseSource() { setError(''); try { setSource(await window.sayspec!.chooseSourceDirectory()); } catch (reason) { setError(messageOf(reason)); } }
  async function create(event: FormEvent) {
    event.preventDefault(); setCreating(true); setError('');
    try {
      if (technology === 'flutter') {
        if (!source) throw new Error('Choose the Flutter source folder before creating the project.');
        const report = await window.sayspec!.checkReadiness({ targetType: technology, task: 'configure', sourceHandle: source.handle });
        if (report.items.find((item) => item.id === 'source')?.state !== 'ready') throw new Error('Choose a Flutter project folder containing pubspec.yaml.');
      }
      if (storage === 'folder' && !storageFolder) throw new Error('Choose the folder where this project’s tests will be kept.');
      const project = await window.sayspec!.createLocalProject({ name, targetType: technology, ...(technology === 'web' ? { baseUrl } : {}), sourceLabel: source?.label });
      await window.sayspec!.configureTestStorage({ organizationId: 'local', projectId: project.id, targetType: technology, mode: storage, ...(storage === 'folder' && storageFolder ? { folderHandle: storageFolder.handle } : {}) });
      onCreated(project, source); setName(''); setBaseUrl(''); setSource(null); setStorage('local'); setStorageFolder(null);
    } catch (reason) { setError(messageOf(reason)); } finally { setCreating(false); }
  }
  return <form className={`project-create-form${compact ? ' project-create-form--compact' : ''}`} onSubmit={create}>
    <Field label="Project name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Storefront" autoFocus={!compact} required />
    <label className="select-field">Technology<select aria-label="Project technology" value={technology} onChange={(event) => { setTechnology(event.target.value as 'web' | 'flutter'); setError(''); }}><option value="web">Web · Playwright tests</option><option value="flutter">Flutter · Patrol tests</option></select></label>
    {technology === 'web' && <Field label="Base URL" type="url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setError(''); }} placeholder="https://example.com" error={baseUrlError} required />}
    <div className="source-picker"><div><strong>Source code folder</strong><span>{technology === 'flutter' ? 'Required for Flutter' : 'Optional for Web'}</span></div><Button type="button" onClick={() => void chooseSource()}>{source ? 'Change folder' : 'Choose folder'}</Button><span className="source-name">{source?.label ?? 'No folder selected'}</span></div>
    <fieldset className="storage-fieldset"><legend>Test storage</legend><StorageChoice name="new-local-project-storage" value={storage} onChange={setStorage} folder={storageFolder} onFolder={setStorageFolder} cloudReason={cloudUnavailableReason({ signedIn: false, plan: null, targetType: technology })} disabled={creating} /></fieldset>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <Button data-testid="local-project-create" type="submit" variant="primary" disabled={!name.trim() || (technology === 'web' && (!baseUrl.trim() || Boolean(baseUrlError))) || (technology === 'flutter' && !source) || (storage === 'folder' && !storageFolder) || creating}>{creating ? 'Creating…' : 'Create project'}</Button>
  </form>;
}

export function LocalWorkspaceSwitcher({ projects, projectId, onSelect }: { projects: LocalProject[]; projectId: string; onSelect: (id: string) => void }) {
  return <section className="workspace-switcher" aria-label="Local workspace"><label>Project<select aria-label="Local project" value={projectId} onChange={(event) => onSelect(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.targetType}</option>)}</select></label></section>;
}

export function LocalProjectSettings({ project, source: selectedSource, onCreated, onSource, createProjectOpen, onCreateProjectOpenChange, onDeleted, about, testStorage }: { about?: ReactNode; project: LocalProject; testStorage: TestStorageSettings | null; source?: LocalSourceSelection | null; onCreated: (project: LocalProject, source: LocalSourceSelection | null) => void; onDeleted: () => void; onSource: (source: LocalSourceSelection) => void; createProjectOpen: boolean; onCreateProjectOpenChange: (open: boolean) => void }) {
  const [source, setSource] = useState<LocalSourceSelection | null>(selectedSource ?? null); const [error, setError] = useState('');
  useEffect(() => { setSource(selectedSource ?? null); }, [project.id, selectedSource]);
  async function chooseSource() { setError(''); try { const next = await window.sayspec!.chooseSourceDirectory(); if (next) { setSource(next); onSource(next); } } catch (reason) { setError(messageOf(reason)); } }
  return <div className="settings-stack"><section className="settings-card project-settings-summary"><div className="settings-card__header"><div><h2>{project.name}</h2><p className="technology-label">{project.targetType === 'web' ? 'Web · Playwright tests' : 'Flutter · Patrol tests'}</p></div><DeleteProjectButton key={project.id} projectName={project.name} consequence="Removes the project and its SaySpec tests and suites from this Mac. Tests kept in a storage folder stay on disk." onDelete={async () => { await window.sayspec!.deleteLocalProject({ projectId: project.id }); onDeleted(); }} /></div></section>
    <AiProviderSettings />
    <MachineSetupCard projectId={project.id} targetType={project.targetType} sourceHandle={source?.handle} onSourceRequired={() => void chooseSource()} />
    <EntryPointsCard projectId={project.id} targetType={project.targetType} sourceHandle={source?.handle} />
    <NarrationSettings />
    <TestStorageSettingsCard organizationId="local" projectId={project.id} targetType={project.targetType} signedIn={false} plan={null} canManage settings={testStorage} />
    <TestInstructionsCard organizationId="local" projectId={project.id} targetType={project.targetType} sourceHandle={source?.handle} storage={testStorage?.mode} />
    {about}
    {error && <StatePanel tone="error" title="Local settings unavailable">{error}</StatePanel>}
    <Dialog.Root open={createProjectOpen} onOpenChange={onCreateProjectOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content" aria-describedby="create-local-project-description"><Dialog.Title>Create project</Dialog.Title><Dialog.Description id="create-local-project-description">Add another Web or Flutter project to this Mac.</Dialog.Description><LocalProjectCreationForm compact onCreated={(createdProject, source) => { onCreated(createdProject, source); onCreateProjectOpenChange(false); }} /><div className="dialog-actions"><Dialog.Close asChild><Button type="button">Cancel</Button></Dialog.Close></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
