import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { LocalSourceSelection, TestStorageMode, TestStorageSettings } from '@sayspec/contracts';
import type { useAuthSession } from './auth';
import { useRequiredCloud } from './cloud/context';
import { WorkspaceSwitcher, type useWorkspaceScope } from './workspace';
import { NoProjectAccess } from './workspace-onboarding';
import { NarrationSettings } from './transcription-settings';
import { Button, Field, StatePanel } from './ui';
import { AiProviderSettings } from './ai-provider-settings';
import { MachineSetupCard } from './machine-setup';
import { EntryPointsCard } from './entry-points';
import { OnboardingPage, type OnboardingProject } from './onboarding';
import { DeleteProjectButton } from './delete-project';
import { StorageChoice, TestStorageSettingsCard, cloudUnavailableReason, defaultStorage } from './test-storage-settings';
import { TestInstructionsCard } from './test-instructions';

function messageOf(error: unknown) { return error instanceof Error ? error.message.replace(/^FirebaseError:\s*/, '') : 'The request failed.'; }
function baseUrlError(value: string) { return value && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(value) ? 'Enter a complete HTTP(S) URL.' : undefined; }
type Scope = ReturnType<typeof useWorkspaceScope>;

export function ProjectOnboarding({ scope, authSession, joinAction, project, projectPending, source, onChooseSource, onCreated, onFinish }: { scope: Scope; authSession: ReturnType<typeof useAuthSession>; joinAction?: ReactNode; project?: OnboardingProject; projectPending: boolean; source?: LocalSourceSelection | null; onChooseSource: (source: LocalSourceSelection) => void; onCreated: (projectId: string, source: LocalSourceSelection | null) => void; onFinish: () => void }) {
  const organization = scope.organizations.find((item) => item.id === scope.organizationId);
  const canManage = organization?.role === 'owner' || organization?.role === 'admin';
  const switcher = scope.organizations.length > 1 && <WorkspaceSwitcher scope={scope} />;
  return <OnboardingPage testId="project-gate" account={<AccountSummary authSession={authSession} joinAction={joinAction} />}
    project={project} projectPending={projectPending} source={source} onChooseSource={onChooseSource} onFinish={onFinish}
    waitingHint={canManage ? 'Create a project to continue.' : 'SaySpec opens once an owner or admin shares a project with you.'}
    projectStep={canManage
      ? <section className="settings-card"><h2>Project</h2><ProjectCreationForm compact scope={scope} onCreated={onCreated} /><p className="gate-org">Creating in <strong>{organization?.name}</strong></p>{switcher}</section>
      : <><NoProjectAccess workspace={scope} />{switcher}</>} />;
}

function AccountSummary({ authSession, joinAction }: { authSession: ReturnType<typeof useAuthSession>; joinAction?: ReactNode }) {
  return <div className="gate-account"><span>{authSession.state.user?.email}</span>{joinAction}<Button variant="quiet" onClick={() => void authSession.signOut()}>Sign out</Button></div>;
}

function ProjectCreationForm({ scope, onCreated, compact = false }: { scope: Scope; onCreated: (projectId: string, source: LocalSourceSelection | null) => void; compact?: boolean }) {
  const cloud = useRequiredCloud();
  const organization = scope.organizations.find((item) => item.id === scope.organizationId);
  const canManage = organization?.role === 'owner' || organization?.role === 'admin';
  const [name, setName] = useState('');
  const [technology, setTechnology] = useState<'web' | 'flutter'>('web');
  const [baseUrl, setBaseUrl] = useState('');
  const [source, setSource] = useState<LocalSourceSelection | null>(null);
  const [storageChoice, setStorageChoice] = useState<TestStorageMode | null>(null);
  const [storageFolder, setStorageFolder] = useState<LocalSourceSelection | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const cloudReason = cloudUnavailableReason({ signedIn: true, plan: scope.plan, targetType: technology });
  const storage = storageChoice === 'cloud' && cloudReason ? 'local' : storageChoice ?? defaultStorage(cloudReason);

  async function chooseSource() {
    setError('');
    try { setSource(await window.sayspec!.chooseSourceDirectory()); }
    catch (reason) { setError(messageOf(reason)); }
  }

  async function create(event: FormEvent) {
    event.preventDefault(); setError(''); setCreating(true);
    try {
      if (technology === 'flutter') {
        if (!source) throw new Error('Choose the Flutter source folder before creating the project.');
        const report = await window.sayspec!.checkReadiness({ targetType: technology, task: 'configure', sourceHandle: source.handle });
        if (report.items.find((item) => item.id === 'source')?.state !== 'ready') throw new Error('Choose a Flutter project folder containing pubspec.yaml.');
      }
      if (storage === 'folder' && !storageFolder) throw new Error('Choose the folder where this project’s tests will be kept.');
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 64) || 'project';
      const projectId = `project_${slug}_${crypto.randomUUID().slice(0, 6)}`;
      await cloud.projects.create({ organizationId: scope.organizationId, projectId, name, targetType: technology, ...(technology === 'web' ? { baseUrl } : {}), access: 'restricted', testStorage: storage });
      await window.sayspec!.configureTestStorage({ organizationId: scope.organizationId, projectId, targetType: technology, mode: storage, ...(storage === 'folder' && storageFolder ? { folderHandle: storageFolder.handle } : {}) });
      onCreated(projectId, source); setName(''); setBaseUrl(''); setSource(null); setStorageChoice(null); setStorageFolder(null);
    } catch (reason) { setError(messageOf(reason)); }
    finally { setCreating(false); }
  }

  return <form className={`project-create-form${compact ? ' project-create-form--compact' : ''}`} onSubmit={create}>
    <Field label="Project name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Storefront" autoFocus={!compact} required />
    <label className="select-field">Technology<select aria-label="Project technology" value={technology} onChange={(event) => { setTechnology(event.target.value as 'web' | 'flutter'); setError(''); }}><option value="web">Web · Playwright tests</option><option value="flutter">Flutter · Patrol tests</option></select></label>
    {technology === 'web' && <Field label="Base URL" type="url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setError(''); }} placeholder="https://example.com" error={baseUrlError(baseUrl)} required />}
    <div className="source-picker"><div><strong>Source code folder</strong><span>{technology === 'flutter' ? 'Required for Flutter' : 'Optional for Web'}</span></div><Button type="button" onClick={() => void chooseSource()}>{source ? 'Change folder' : 'Choose folder'}</Button><span className="source-name">{source?.label ?? 'No folder selected'}</span></div>
    <fieldset className="storage-fieldset"><legend>Test storage</legend><StorageChoice name="new-project-storage" value={storage} onChange={setStorageChoice} folder={storageFolder} onFolder={setStorageFolder} cloudReason={cloudReason} disabled={creating} /></fieldset>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <Button data-testid="project-create" type="submit" variant="primary" disabled={!canManage || !name.trim() || (technology === 'web' && (!baseUrl.trim() || Boolean(baseUrlError(baseUrl)))) || (technology === 'flutter' && !source) || (storage === 'folder' && !storageFolder) || creating}>{creating ? 'Creating…' : 'Create project'}</Button>
    {!canManage && <p className="control-help">Only an organization owner or admin can create a project.</p>}
  </form>;
}

export function ProjectSettings({ scope, source: selectedSource, onSource, onProjectCreated, createProjectOpen, onCreateProjectOpenChange, about, testStorage }: { about?: ReactNode; scope: Scope; testStorage: TestStorageSettings | null; source?: LocalSourceSelection | null; onSource: (source: LocalSourceSelection) => void; onProjectCreated: (projectId: string, source: LocalSourceSelection | null) => void; createProjectOpen: boolean; onCreateProjectOpenChange: (open: boolean) => void }) {
  const cloud = useRequiredCloud();
  const selectedProject = scope.projects.find((project) => project.id === scope.projectId);
  const selectedOrganization = scope.organizations.find((organization) => organization.id === scope.organizationId);
  const targetType = selectedProject?.targetType ?? 'web';
  const [environmentName, setEnvironmentName] = useState('Local acceptance');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:4173');
  const [appId, setAppId] = useState('dev.sayspec.fixture');
  const [flavor, setFlavor] = useState('development');
  const [source, setSource] = useState<LocalSourceSelection | null>(selectedSource ?? null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { setSource(selectedSource ?? null); setStatus(''); setError(''); setBaseUrl(selectedProject?.baseUrl ?? 'http://127.0.0.1:4173'); }, [scope.organizationId, scope.projectId, selectedProject?.baseUrl, selectedSource]);
  const canManage = selectedOrganization?.role === 'owner' || selectedOrganization?.role === 'admin';

  async function configure(event: FormEvent) {
    event.preventDefault(); setError(''); setStatus('Saving project settings…');
    try {
      await cloud.projects.configure({ organizationId: scope.organizationId, projectId: scope.projectId, targetType, environment: { id: 'environment_local', name: environmentName, ...(targetType === 'web' ? { baseUrl } : { appId, flavor }) } });
      setStatus('Project settings saved.');
    } catch (reason) { setStatus(''); setError(messageOf(reason)); }
  }
  async function chooseSource() {
    setError('');
    try { const next = await window.sayspec!.chooseSourceDirectory(); if (next) { setSource(next); onSource(next); } } catch (reason) { setError(messageOf(reason)); }
  }

  async function deleteProject() {
    scope.expectProjectDeletion(scope.projectId);
    try { await cloud.projects.remove({ organizationId: scope.organizationId, projectId: scope.projectId }); }
    catch (reason) { scope.expectProjectDeletion(''); throw new Error(messageOf(reason)); }
  }

  if (!selectedProject) return null;
  return <div className="settings-stack">
    <section className="settings-card project-settings-summary" aria-labelledby="environment-heading"><div className="settings-card__header"><div><h2 id="environment-heading">{selectedProject.name}</h2><p className="technology-label">{targetType === 'web' ? 'Web · Playwright tests' : 'Flutter · Patrol tests'}</p></div><DeleteProjectButton key={selectedProject.id} projectName={selectedProject.name} consequence="Deletes the project for everyone in this workspace, with its tests, versions, runs and shared recordings. Tests kept in a storage folder stay on disk." disabledReason={canManage ? undefined : 'Only an organization owner or admin can delete a project.'} onDelete={deleteProject} /></div>
      <form className="settings-form" onSubmit={configure}>
        <Field label="Environment name" value={environmentName} onChange={(event) => setEnvironmentName(event.target.value)} required />
        {targetType === 'web' ? <Field label="Base URL" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} error={baseUrl && !/^https?:\/\//.test(baseUrl) ? 'Enter a complete HTTP(S) URL.' : undefined} required /> : <><Field label="Application ID" value={appId} onChange={(event) => setAppId(event.target.value)} required /><Field label="Build flavor" value={flavor} onChange={(event) => setFlavor(event.target.value)} /></>}
        <Button variant="primary" disabled={!canManage}>Save project settings</Button>
      </form>
    </section>
    <AiProviderSettings />
    <MachineSetupCard projectId={selectedProject.id} targetType={targetType} sourceHandle={source?.handle} onSourceRequired={() => void chooseSource()} />
    <EntryPointsCard projectId={selectedProject.id} targetType={targetType} sourceHandle={source?.handle} />
    <NarrationSettings plan={scope.plan} />
    <TestStorageSettingsCard organizationId={scope.organizationId} projectId={selectedProject.id} targetType={targetType} signedIn plan={scope.plan} canManage={canManage} settings={testStorage} />
    <TestInstructionsCard organizationId={scope.organizationId} projectId={selectedProject.id} targetType={targetType} sourceHandle={source?.handle} storage={testStorage?.mode} />
    {about}
    {error && <StatePanel tone="error" title="Settings were not saved">{error} Check the values and try again.</StatePanel>}
    {status && <p className="settings-status" role="status">{status}</p>}
    <Dialog.Root open={createProjectOpen} onOpenChange={onCreateProjectOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content" aria-describedby="create-project-description"><Dialog.Title>Create project</Dialog.Title><Dialog.Description id="create-project-description">Add another Web or Flutter project to this workspace.</Dialog.Description><ProjectCreationForm scope={scope} compact onCreated={(projectId, source) => { onProjectCreated(projectId, source); onCreateProjectOpenChange(false); }} /><div className="dialog-actions"><Dialog.Close asChild><Button type="button">Cancel</Button></Dialog.Close></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
