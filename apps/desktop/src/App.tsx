import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { AppInfo, FailureAnalysis, LocalSourceSelection, PatrolAttempt, SavedWebTestAttempt } from '@sayspec/contracts';
import { useCloud } from './cloud/context';
import { AccountPage, AccountPanel, useAuthSession } from './auth';
import { DebugLoginsBrand, debugLoginsEnabled } from './debug-logins';
import { ProjectTestLibrary } from './library';
import { useCloudPatrolTestSync } from './cloud-patrol-tests';
import { useProjectTestStorage } from './test-repository';
import { useCloudTestInstructionsSync } from './test-instructions';
import { ChooseStorageFolderPanel } from './test-storage-settings';
import { ProjectOnboarding, ProjectSettings } from './project-settings';
import { RecordPage } from './record';
import { Button, StatePanel, TopbarSlotContext } from './ui';
import { WorkspaceSwitcher, useWorkspaceScope } from './workspace';
import { JoinWorkspaceDialog, NoWorkspacePanel, useJoinWorkspace } from './workspace-onboarding';
import { LocalProjectOnboarding, LocalProjectSettings, LocalWorkspaceSwitcher, useLocalWorkspace } from './guest-workspace';
import { SavedWebRuns } from './saved-web-runs';
import { PatrolRuns } from './patrol-runs';
import { FixesPage, PatrolTestFixesPage } from './fixes';
import { ApplicationFixesPage } from './application-fixes';
import navRecord from './assets/nav/nav-record.png?inline';
import navTests from './assets/nav/nav-tests.png?inline';
import navRuns from './assets/nav/nav-runs.png?inline';
import navFixes from './assets/nav/nav-fixes.png?inline';
import navSettings from './assets/nav/nav-settings.png?inline';

const sections = ['Record', 'Tests', 'Runs', 'Fixes', 'Settings'] as const;
/** Account is not in the nav; it opens from the person's name in the sidebar. */
type Section = typeof sections[number] | 'Account';
type FixTarget = { target: 'web'; attempt: SavedWebTestAttempt; analysis: FailureAnalysis } | { target: 'flutter'; attempt: PatrolAttempt; analysis: FailureAnalysis };

export function App() {
  // Without a cloud backend the app is local-only: it opens straight into the local workspace.
  const cloud = useCloud();
  const [section, setSection] = useState<Section>('Record');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [localSources, setLocalSources] = useState<Record<string, LocalSourceSelection>>({});
  const [guest, setGuest] = useState(!cloud);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [importRequest, setImportRequest] = useState(0);
  const [fixTarget, setFixTarget] = useState<FixTarget | null>(null);
  const [selectedRunId, setSelectedRunId] = useState('');
  // Tests picked in the library for a Flutter run; Patrol runs them one after another on one device.
  const [patrolRunTestIds, setPatrolRunTestIds] = useState<string[]>([]);
  // A project created from onboarding keeps the user there until they finish.
  const [onboardingProjectId, setOnboardingProjectId] = useState('');
  const authSession = useAuthSession();
  const signedIn = Boolean(authSession.state.user);
  // The Account page belongs to a signed-in person; leave it after signing out.
  useEffect(() => { if (!signedIn) setSection((current) => current === 'Account' ? 'Record' : current); }, [signedIn]);
  const workspace = useWorkspaceScope(authSession.state);
  const joinFlow = useJoinWorkspace(workspace);
  const localWorkspace = useLocalWorkspace();
  const selectedProject = workspace.projects.find((project) => project.id === workspace.projectId);
  const selectedLocalProject = localWorkspace.projects.find((project) => project.id === localWorkspace.projectId);

  useEffect(() => {
    window.sayspec?.getAppInfo().then(setAppInfo).catch(() => setAppInfo(null));
  }, []);

  function chooseSourceFor(projectId: string, source: LocalSourceSelection) {
    setLocalSources((current) => ({ ...current, [projectId]: source }));
    void window.sayspec?.rememberSourceDirectory({ projectId, handle: source.handle }).catch(() => undefined);
  }

  const activeProjectId = guest ? localWorkspace.projectId : workspace.projectId;
  // Where the active project's tests live. Folder storage keeps them out of Firebase, so cloud-only
  // test bookkeeping (run anchors, attempt sync, drafts, reviews) is skipped for it.
  const testStorageSettings = useProjectTestStorage(guest
    ? { organizationId: 'local', projectId: localWorkspace.projectId, targetType: selectedLocalProject?.targetType }
    : { organizationId: workspace.organizationId, projectId: workspace.projectId, targetType: selectedProject?.targetType, sharedMode: selectedProject ? selectedProject.testStorage ?? 'cloud' : undefined });
  const testStorage = testStorageSettings?.mode ?? null;
  // Until the storage is known a signed-in project is treated as SaySpec Cloud, as before the choice existed.
  const cloudTests = !guest && testStorage !== 'local' && testStorage !== 'folder';
  const missingFolder = testStorage === 'folder' && !testStorageSettings?.folder;
  useCloudTestInstructionsSync({ enabled: !guest && testStorage === 'cloud', organizationId: workspace.organizationId, projectId: workspace.projectId });
  useCloudPatrolTestSync({ enabled: !guest && testStorage === 'cloud' && selectedProject?.targetType === 'flutter', organizationId: workspace.organizationId, projectId: workspace.projectId });
  const signedInUser = authSession.state.user;
  useEffect(() => {
    void window.sayspec?.setTestAuthor(signedInUser ? { name: signedInUser.displayName ?? undefined, email: signedInUser.email ?? undefined } : null).catch(() => undefined);
  }, [signedInUser?.uid, signedInUser?.displayName, signedInUser?.email]);
  useEffect(() => {
    if (!activeProjectId || localSources[activeProjectId]) return;
    let cancelled = false;
    window.sayspec?.getRememberedSourceDirectory({ projectId: activeProjectId }).then((source) => {
      if (!cancelled && source) setLocalSources((current) => current[activeProjectId] ? current : { ...current, [activeProjectId]: source });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeProjectId]);

  useEffect(() => {
    if (section !== 'Settings') setCreateProjectOpen(false);
  }, [section]);
  useEffect(() => { if (section !== 'Fixes') setFixTarget(null); }, [section]);
  // A Flutter fix started from a run issue: a test bug opens a test fix, an app bug an application fix.
  const flutterFix = fixTarget?.target === 'flutter' ? fixTarget : null;
  const flutterTestFix = flutterFix?.analysis.category === 'test' ? flutterFix : null;
  const flutterAppFix = flutterFix?.analysis.category === 'application' ? flutterFix : null;
  useEffect(() => { if (section !== 'Runs') setPatrolRunTestIds([]); }, [section]);
  function runPatrolTests(testIds: string[]) { setPatrolRunTestIds(testIds); setSection('Runs'); }
  useEffect(() => { setOnboardingProjectId(''); }, [authSession.state.user?.uid, guest]);
  function finishOnboarding() { setOnboardingProjectId(''); setSection('Record'); }

  useEffect(() => { if (section === 'Tests' && guest) void localWorkspace.refresh(); }, [section, guest]);

  async function resolveTestRunBaseUrl(input: { organizationId: string; projectId: string; testIds: string[]; fallbackBaseUrl?: string }) {
    const versions = await window.sayspec!.listProjectWebTestVersions({ organizationId: input.organizationId, projectId: input.projectId });
    const latest = new Map<string, typeof versions[number]>();
    for (const version of [...versions].sort((left, right) => right.version - left.version)) if (!latest.has(version.testId)) latest.set(version.testId, version);
    const recordedUrls = (await Promise.all(input.testIds.map(async (testId) => {
      const recordingId = latest.get(testId)?.recordingId;
      if (!recordingId) return undefined;
      try { return (await window.sayspec!.getLocalRecording({ projectId: input.projectId, recordingId })).startUrl; }
      catch { return undefined; }
    }))).filter((url): url is string => Boolean(url));
    const distinctRecordedUrls = [...new Set(recordedUrls)];
    return distinctRecordedUrls.length === 1 ? distinctRecordedUrls[0] : input.fallbackBaseUrl ?? distinctRecordedUrls[0] ?? '';
  }

  async function createTestRun(input: { organizationId: string; projectId: string; baseUrl: string; cloud: boolean; testIds: string[]; name: string }) {
    if (!input.baseUrl.trim()) throw new Error('Enter a Web base URL before creating a test run.');
    const versions = await window.sayspec!.listProjectWebTestVersions({ organizationId: input.organizationId, projectId: input.projectId });
    const latest = new Map<string, typeof versions[number]>();
    for (const version of [...versions].sort((left, right) => right.version - left.version)) if (!latest.has(version.testId)) latest.set(version.testId, version);
    const items = input.testIds.map((testId) => {
      const version = latest.get(testId);
      if (!version) throw new Error(`“${testId}” has no saved Web test version on this machine.`);
      return { testId, versionId: version.id, contentHash: version.contentHash };
    });
    if (input.cloud) {
      if (!cloud) throw new Error('This build has no cloud backend.');
      await cloud.runs.authorize({ organizationId: input.organizationId, projectId: input.projectId, items });
    }
    const run = await window.sayspec!.createSavedWebRun({ organizationId: input.organizationId, projectId: input.projectId, name: input.name, baseUrl: input.baseUrl, testIds: input.testIds });
    setSelectedRunId(run.id);
    setSection('Runs');
  }

  if (authSession.state.status === 'loading' && !guest) return <EntryFrame><div className="entry-status" role="status">Opening SaySpec…</div></EntryFrame>;
  if (!authSession.state.user && !guest) return <EntryFrame debugAuthSession={authSession}><section className="welcome-card welcome-card--choices"><h1>Welcome to SaySpec</h1><div className="entry-choices"><AccountPanel authSession={authSession} pro entry onJoinCode={(code) => void joinFlow.join(code)} /><button className="entry-choice" data-testid="continue-guest" onClick={() => setGuest(true)}><span className="entry-choice-title">Continue as guest</span><span className="entry-choice-subtitle">Projects and generated tests stay local on this device</span><span className="entry-choice-arrow" aria-hidden="true">→</span></button></div></section></EntryFrame>;
  if (!authSession.state.user && guest) {
    if (localWorkspace.status === 'loading') return <EntryFrame><div className="entry-status" role="status">Opening local workspace…</div></EntryFrame>;
    if (localWorkspace.status === 'error') return <EntryFrame><section className="welcome-card"><h1>Local workspace unavailable</h1><p>{localWorkspace.message}</p></section></EntryFrame>;
    if (!localWorkspace.projectId || onboardingProjectId === localWorkspace.projectId) {
      return <EntryFrame><LocalProjectOnboarding project={localWorkspace.projectId ? selectedLocalProject : undefined} projectPending={Boolean(onboardingProjectId) && !selectedLocalProject} source={localSources[localWorkspace.projectId]} onChooseSource={(source) => chooseSourceFor(localWorkspace.projectId, source)} onUsePro={cloud ? () => setGuest(false) : undefined} onFinish={finishOnboarding} onCreated={(project, source) => {
        setOnboardingProjectId(project.id);
        if (source) chooseSourceFor(project.id, source);
        void localWorkspace.refresh(project.id);
      }} /></EntryFrame>;
    }
    return <AppShell section={section} setSection={setSection} topbarActions={section === 'Settings' ? <Button type="button" variant="primary" onClick={() => setCreateProjectOpen(true)}>Create project</Button> : section === 'Runs' && selectedLocalProject?.targetType === 'web' ? <Button type="button" onClick={() => setImportRequest((value) => value + 1)}>Import bundle</Button> : undefined} bare={section === 'Record' || (section === 'Runs' && selectedLocalProject?.targetType === 'flutter')} account={cloud ? <AccountPanel authSession={authSession} pro onOpen={() => setSection('Account')} current={section === 'Account'} /> : null} switcher={<LocalWorkspaceSwitcher projects={localWorkspace.projects} projectId={localWorkspace.projectId} onSelect={localWorkspace.selectProject} />}>
      <RecordKeepAlive visible={section === 'Record'}><RecordPage project={selectedLocalProject} source={localSources[localWorkspace.projectId]} visible={section === 'Record'} onChooseSource={(source) => chooseSourceFor(localWorkspace.projectId, source)} /></RecordKeepAlive>
      {section === 'Record' ? null
        : section === 'Tests' ? (testStorage ? missingFolder && selectedLocalProject ? <ChooseStorageFolderPanel organizationId="local" projectId={localWorkspace.projectId} targetType={selectedLocalProject.targetType} /> : <ProjectTestLibrary key={`${localWorkspace.projectId}:${testStorage}`} source={{ organizationId: 'local', projectId: localWorkspace.projectId, signedIn: false, mode: testStorage, targetType: selectedLocalProject?.targetType }} canManage canCreateRun={Boolean(selectedLocalProject)} onCreateDeviceRun={selectedLocalProject?.targetType === 'flutter' ? runPatrolTests : undefined} defaultBaseUrl={selectedLocalProject?.baseUrl ?? ''} resolveRunBaseUrl={(testIds) => resolveTestRunBaseUrl({ organizationId: 'local', projectId: localWorkspace.projectId, testIds, fallbackBaseUrl: selectedLocalProject?.baseUrl })} onRecord={() => setSection('Record')} onCreateRun={(testIds, name, baseUrl) => createTestRun({ organizationId: 'local', projectId: localWorkspace.projectId, baseUrl, cloud: false, testIds, name })} /> : <div className="library-loading" role="status">Loading tests…</div>)
        : section === 'Runs' && selectedLocalProject?.targetType === 'web' ? <SavedWebRuns key={`local:${localWorkspace.projectId}`} organizationId="local" projectId={localWorkspace.projectId} cloud={false} importRequest={importRequest} onLocalChanged={localWorkspace.refresh} initialRunId={selectedRunId} onOpenFix={(attempt, analysis) => { setFixTarget({ target: 'web', attempt, analysis }); setSection('Fixes'); }} />
        : section === 'Runs' && selectedLocalProject?.targetType === 'flutter' ? <PatrolRuns key={`local:${localWorkspace.projectId}`} queuedTestIds={patrolRunTestIds} organizationId="local" projectId={localWorkspace.projectId} source={localSources[localWorkspace.projectId]} onChooseSource={(next) => chooseSourceFor(localWorkspace.projectId, next)} onOpenFix={(target) => { setFixTarget({ target: 'flutter', ...target }); setSection('Fixes'); }} />
        : section === 'Fixes' && selectedLocalProject?.targetType === 'web' ? <><FixesPage key={`local:${localWorkspace.projectId}`} organizationId="local" projectId={localWorkspace.projectId} cloud={false} baseUrl={selectedLocalProject.baseUrl} target={fixTarget?.target === 'web' && fixTarget.analysis.category === 'test' ? fixTarget : null} onUpdated={localWorkspace.refresh} /><ApplicationFixesPage organizationId="local" projectId={localWorkspace.projectId} targetType="web" cloud={false} source={localSources[localWorkspace.projectId]} onChooseSource={(next) => chooseSourceFor(localWorkspace.projectId, next)} target={fixTarget?.target === 'web' && fixTarget.analysis.category === 'application' ? fixTarget : null} /></>
        : section === 'Fixes' && selectedLocalProject?.targetType === 'flutter' ? (flutterAppFix ? <><ApplicationFixesPage organizationId="local" projectId={localWorkspace.projectId} targetType="flutter" cloud={false} source={localSources[localWorkspace.projectId]} onChooseSource={(next) => chooseSourceFor(localWorkspace.projectId, next)} target={flutterAppFix} /><PatrolTestFixesPage key={`local:${localWorkspace.projectId}`} organizationId="local" projectId={localWorkspace.projectId} cloudStorage={false} source={localSources[localWorkspace.projectId]} onChooseSource={(next) => chooseSourceFor(localWorkspace.projectId, next)} target={flutterTestFix} /></> : <><PatrolTestFixesPage key={`local:${localWorkspace.projectId}`} organizationId="local" projectId={localWorkspace.projectId} cloudStorage={false} source={localSources[localWorkspace.projectId]} onChooseSource={(next) => chooseSourceFor(localWorkspace.projectId, next)} target={flutterTestFix} /><ApplicationFixesPage organizationId="local" projectId={localWorkspace.projectId} targetType="flutter" cloud={false} source={localSources[localWorkspace.projectId]} onChooseSource={(next) => chooseSourceFor(localWorkspace.projectId, next)} target={flutterAppFix} /></>)
        : section === 'Settings' && selectedLocalProject ? <LocalProjectSettings testStorage={testStorageSettings} about={<AboutCard appInfo={appInfo} runtime={cloud ? 'Guest workspace · local' : 'Local workspace'} />} project={selectedLocalProject} source={localSources[localWorkspace.projectId]} createProjectOpen={createProjectOpen} onCreateProjectOpenChange={setCreateProjectOpen} onSource={(source) => chooseSourceFor(localWorkspace.projectId, source)} onCreated={(project, source) => { if (source) chooseSourceFor(project.id, source); void localWorkspace.refresh(project.id); }} onDeleted={() => void localWorkspace.refresh()} />
        : section === 'Account' ? <AccountPage authSession={authSession} />
        : <FuturePage section={section as 'Runs' | 'Fixes'} />}
    </AppShell>;
  }
  if (workspace.organizationStatus === 'loading' || (workspace.organizationId && workspace.projectStatus === 'loading')) {
    return <EntryFrame><section className="loading-card"><div className="entry-status" role="status">Loading your workspace…</div><AccountPanel authSession={authSession} /></section></EntryFrame>;
  }
  if (!workspace.organizationId) {
    return <EntryFrame><NoWorkspacePanel workspace={workspace} flow={joinFlow} /><AccountPanel authSession={authSession} /></EntryFrame>;
  }
  if (workspace.projectStatus === 'error') {
    return <EntryFrame><section className="welcome-card"><h1>Projects unavailable</h1><p>{workspace.message || 'SaySpec could not load the projects in this workspace. Check your connection and try again.'}</p><AccountPanel authSession={authSession} /></section></EntryFrame>;
  }
  if (workspace.projectStatus === 'revoked' && workspace.projects.length) {
    return <EntryFrame><section className="welcome-card"><h1>Choose another project</h1><p>{workspace.message}</p><WorkspaceSwitcher scope={workspace} /><AccountPanel authSession={authSession} /></section></EntryFrame>;
  }
  if (!workspace.projectId || onboardingProjectId === workspace.projectId) {
    return <EntryFrame><ProjectOnboarding scope={workspace} authSession={authSession} joinAction={<JoinWorkspaceDialog flow={joinFlow} />} project={workspace.projectId ? selectedProject : undefined} projectPending={Boolean(onboardingProjectId) && !selectedProject} source={localSources[workspace.projectId]} onChooseSource={(source) => chooseSourceFor(workspace.projectId, source)} onFinish={finishOnboarding} onCreated={(projectId, source) => {
      setOnboardingProjectId(projectId);
      if (source) chooseSourceFor(projectId, source);
      workspace.selectProject(projectId);
    }} /></EntryFrame>;
  }

  return <AppShell section={section} setSection={setSection} topbarActions={section === 'Settings' ? <Button type="button" variant="primary" onClick={() => setCreateProjectOpen(true)}>Create project</Button> : section === 'Runs' && selectedProject?.targetType === 'web' ? <Button type="button" onClick={() => setImportRequest((value) => value + 1)}>Import bundle</Button> : undefined} bare={section === 'Record' || (section === 'Runs' && selectedProject?.targetType === 'flutter')} account={<AccountPanel authSession={authSession} onOpen={() => setSection('Account')} current={section === 'Account'} />} switcher={<WorkspaceSwitcher scope={workspace} />}>
    <RecordKeepAlive visible={section === 'Record'}><RecordPage project={selectedProject} source={localSources[workspace.projectId]} visible={section === 'Record'} cloudScope={{ organizationId: workspace.organizationId, createdByUid: authSession.state.user!.uid }} cloudTests={cloudTests} cloudPlan={workspace.plan} onChooseSource={(source) => chooseSourceFor(workspace.projectId, source)} /></RecordKeepAlive>
    {section === 'Record' ? null
      : section === 'Tests' ? (testStorage ? missingFolder && selectedProject ? <ChooseStorageFolderPanel organizationId={workspace.organizationId} projectId={workspace.projectId} targetType={selectedProject.targetType} /> : <ProjectTestLibrary key={`${authSession.state.user!.uid}:${workspace.organizationId}:${workspace.projectId}:${testStorage}`} source={{ organizationId: workspace.organizationId, projectId: workspace.projectId, signedIn: true, mode: testStorage, targetType: selectedProject?.targetType }} currentUser={{ uid: authSession.state.user!.uid, displayName: authSession.state.user!.displayName, email: authSession.state.user!.email }} canManage={testStorage === 'folder' || ['owner', 'admin', 'editor'].includes(workspace.organizations.find((organization) => organization.id === workspace.organizationId)?.role ?? '')} canCreateRun={Boolean(selectedProject)} onCreateDeviceRun={selectedProject?.targetType === 'flutter' ? runPatrolTests : undefined} defaultBaseUrl={selectedProject?.baseUrl ?? ''} resolveRunBaseUrl={(testIds) => resolveTestRunBaseUrl({ organizationId: workspace.organizationId, projectId: workspace.projectId, testIds, fallbackBaseUrl: selectedProject?.baseUrl })} onRecord={() => setSection('Record')} onCreateRun={(testIds, name, baseUrl) => createTestRun({ organizationId: workspace.organizationId, projectId: workspace.projectId, baseUrl, cloud: cloudTests, testIds, name })} /> : <div className="library-loading" role="status">Loading tests…</div>)
      : section === 'Runs' && selectedProject?.targetType === 'web' ? <SavedWebRuns key={`${authSession.state.user!.uid}:${workspace.organizationId}:${workspace.projectId}:${cloudTests}`} organizationId={workspace.organizationId} projectId={workspace.projectId} cloud={cloudTests} importRequest={importRequest} initialRunId={selectedRunId} onOpenFix={(attempt, analysis) => { setFixTarget({ target: 'web', attempt, analysis }); setSection('Fixes'); }} />
      : section === 'Runs' && selectedProject?.targetType === 'flutter' ? <PatrolRuns key={`${authSession.state.user!.uid}:${workspace.organizationId}:${workspace.projectId}`} queuedTestIds={patrolRunTestIds} cloudStorage={testStorage === 'cloud'} organizationId={workspace.organizationId} projectId={workspace.projectId} source={localSources[workspace.projectId]} onChooseSource={(next) => chooseSourceFor(workspace.projectId, next)} onOpenFix={(target) => { setFixTarget({ target: 'flutter', ...target }); setSection('Fixes'); }} />
      : section === 'Fixes' && selectedProject?.targetType === 'web' ? <><FixesPage key={`${authSession.state.user!.uid}:${workspace.organizationId}:${workspace.projectId}:${cloudTests}`} organizationId={workspace.organizationId} projectId={workspace.projectId} cloud={cloudTests} baseUrl={selectedProject.baseUrl} target={fixTarget?.target === 'web' && fixTarget.analysis.category === 'test' ? fixTarget : null} /><ApplicationFixesPage organizationId={workspace.organizationId} projectId={workspace.projectId} targetType="web" cloud source={localSources[workspace.projectId]} onChooseSource={(next) => chooseSourceFor(workspace.projectId, next)} target={fixTarget?.target === 'web' && fixTarget.analysis.category === 'application' ? fixTarget : null} /></>
      : section === 'Fixes' && selectedProject?.targetType === 'flutter' ? (flutterAppFix ? <><ApplicationFixesPage organizationId={workspace.organizationId} projectId={workspace.projectId} targetType="flutter" cloud source={localSources[workspace.projectId]} onChooseSource={(next) => chooseSourceFor(workspace.projectId, next)} target={flutterAppFix} /><PatrolTestFixesPage key={`${authSession.state.user!.uid}:${workspace.organizationId}:${workspace.projectId}:${testStorage}`} organizationId={workspace.organizationId} projectId={workspace.projectId} cloudStorage={testStorage === 'cloud'} canManage={testStorage !== 'cloud' || ['owner', 'admin', 'editor'].includes(workspace.organizations.find((organization) => organization.id === workspace.organizationId)?.role ?? '')} source={localSources[workspace.projectId]} onChooseSource={(next) => chooseSourceFor(workspace.projectId, next)} target={flutterTestFix} /></> : <><PatrolTestFixesPage key={`${authSession.state.user!.uid}:${workspace.organizationId}:${workspace.projectId}:${testStorage}`} organizationId={workspace.organizationId} projectId={workspace.projectId} cloudStorage={testStorage === 'cloud'} canManage={testStorage !== 'cloud' || ['owner', 'admin', 'editor'].includes(workspace.organizations.find((organization) => organization.id === workspace.organizationId)?.role ?? '')} source={localSources[workspace.projectId]} onChooseSource={(next) => chooseSourceFor(workspace.projectId, next)} target={flutterTestFix} /><ApplicationFixesPage organizationId={workspace.organizationId} projectId={workspace.projectId} targetType="flutter" cloud source={localSources[workspace.projectId]} onChooseSource={(next) => chooseSourceFor(workspace.projectId, next)} target={flutterAppFix} /></>)
      : section === 'Account' ? <AccountPage authSession={authSession} joinAction={<JoinWorkspaceDialog flow={joinFlow} />} />
      : section === 'Settings' ? <ProjectSettings testStorage={testStorageSettings} about={<AboutCard appInfo={appInfo} runtime="Cloud workspace" />} scope={workspace} source={localSources[workspace.projectId]} onSource={(source) => chooseSourceFor(workspace.projectId, source)} createProjectOpen={createProjectOpen} onCreateProjectOpenChange={setCreateProjectOpen} onProjectCreated={(projectId, source) => {
        if (source) chooseSourceFor(projectId, source);
        workspace.selectProject(projectId);
      }} />
      : <FuturePage section={section as 'Runs' | 'Fixes'} />}
  </AppShell>;
}

function AppShell({ section, setSection, topbarActions, account, switcher, bare = section === 'Record', children }: { section: Section; setSection: (section: Section) => void; topbarActions?: ReactNode; account: ReactNode; switcher: ReactNode; bare?: boolean; children: ReactNode }) {
  // Record (and Flutter Runs) draw their own header so their sidebar can run the full page height.
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  return <div className="shell">
    <aside className="sidebar">
      <div className="wordmark"><span aria-hidden="true" className="mark">[<i />]</span> SaySpec</div>
      {switcher}
      <nav aria-label="Main navigation">
        {sections.map((item) => <button key={item} aria-current={section === item ? 'page' : undefined} onClick={() => setSection(item)}><NavIcon section={item} />{item}</button>)}
      </nav>
      {account}
    </aside>
    <div className="body">
      <main className={bare ? 'main--bare' : undefined}>
        {!bare && <header className="page-header"><h1 className="page-title">{section}</h1><div className="topbar-actions" ref={setActionsSlot}>{topbarActions}</div></header>}
        <TopbarSlotContext.Provider value={bare ? null : actionsSlot}>{children}</TopbarSlotContext.Provider>
      </main>
    </div>
  </div>;
}

/** Version and runtime details, shown under Settings instead of the sidebar. */
function AboutCard({ appInfo, runtime }: { appInfo: AppInfo | null; runtime: string }) {
  return <section className="settings-card about-settings" aria-labelledby="about-heading"><h2 id="about-heading">About</h2>
    <dl><div><dt>Version</dt><dd>{appInfo ? `${appInfo.name} ${appInfo.version}` : 'SaySpec'}</dd></div><div><dt>Workspace</dt><dd>{runtime}</dd></div><div><dt>Platform</dt><dd>{appInfo?.platform ?? 'desktop'}</dd></div></dl>
  </section>;
}

/** Record stays mounted while other sections are open so a running coding agent and its terminal survive navigation. */
function RecordKeepAlive({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <div className="record-keepalive" hidden={!visible}>{children}</div>;
}

function EntryFrame({ children, debugAuthSession }: { children: ReactNode; debugAuthSession?: ReturnType<typeof useAuthSession> }) {
  const brand = <><span aria-hidden="true" className="mark">[<i />]</span> SaySpec</>;
  return <main className="entry-shell" data-testid="entry-gate">{debugLoginsEnabled && debugAuthSession ? <DebugLoginsBrand authSession={debugAuthSession}>{brand}</DebugLoginsBrand> : <div className="entry-brand">{brand}</div>}{children}</main>;
}

function FuturePage({ section }: { section: 'Runs' | 'Fixes' }) {
  return <StatePanel tone="empty" title={section === 'Runs' ? 'No runs yet' : 'No fixes yet'}>
    {section === 'Runs' ? 'Generated tests and their run history will appear here.' : 'When a run fails, any suggested fix will appear here before it can be applied.'}
  </StatePanel>;
}

const navIcons: Record<typeof sections[number], string> = { Record: navRecord, Tests: navTests, Runs: navRuns, Fixes: navFixes, Settings: navSettings };

/** Icons are alpha masks painted with currentColor, so they follow the button's idle, hover, and active colours. */
function NavIcon({ section }: { section: typeof sections[number] }) {
  return <span className="nav-icon" style={{ '--icon': `url(${navIcons[section]})` } as CSSProperties} aria-hidden="true" />;
}
