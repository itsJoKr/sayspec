import { useEffect, useRef, useState } from 'react';
import type { PlanKind } from '@sayspec/contracts';
import type { AuthState } from './auth';
import type { OrganizationScope, ProjectScope } from './cloud/backend';
import { useCloud } from './cloud/context';
import { StatusLabel } from './ui';

export type { OrganizationScope, ProjectScope };

export function useWorkspaceScope(authState: AuthState) {
  const cloud = useCloud();
  const uid = authState.user?.uid;
  const [organizations, setOrganizations] = useState<OrganizationScope[]>([]);
  const [projects, setProjects] = useState<ProjectScope[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [organizationStatus, setOrganizationStatus] = useState<'signed-out' | 'loading' | 'ready' | 'empty' | 'error' | 'revoked'>('signed-out');
  const [projectStatus, setProjectStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'revoked'>('idle');
  const [status, setStatus] = useState<'signed-out' | 'loading' | 'ready' | 'empty' | 'error' | 'revoked'>('signed-out');
  const [message, setMessage] = useState('');
  // The selected workspace's plan; null while it loads. Beta includes Pro features.
  const [plan, setPlan] = useState<PlanKind | null>(null);
  const selectedOrganization = useRef('');
  const selectedProject = useRef('');
  // Project this user is deleting; its disappearance moves the selection on instead of reporting revoked access.
  const deletingProject = useRef('');
  // Organization to select once it appears in the live scope list: the last
  // one used on this Mac (restart persistence) or one just joined.
  const preferredOrganization = useRef('');
  const switchToPreferred = useRef(false);

  useEffect(() => { selectedOrganization.current = organizationId; }, [organizationId]);
  useEffect(() => { selectedProject.current = projectId; }, [projectId]);

  useEffect(() => {
    setOrganizations([]); setProjects([]); setOrganizationId(''); setProjectId(''); setMessage('');
    if (!uid || !cloud) { setStatus('signed-out'); setOrganizationStatus('signed-out'); setProjectStatus('idle'); return undefined; }
    preferredOrganization.current = readLastOrganization(uid); switchToPreferred.current = false;
    setStatus('loading'); setOrganizationStatus('loading'); setProjectStatus('idle');
    return cloud.workspaces.subscribeOrganizations(uid, (organizations) => {
      const next = [...organizations].sort((a, b) => a.name.localeCompare(b.name));
      const previous = selectedOrganization.current;
      const preferred = next.some((organization) => organization.id === preferredOrganization.current) ? preferredOrganization.current : '';
      setOrganizations(next);
      if (preferred && switchToPreferred.current && preferred !== previous) {
        switchToPreferred.current = false; selectedOrganization.current = preferred; selectedProject.current = '';
        setOrganizationId(preferred); setProjectId(''); setProjects([]); setStatus('ready'); setOrganizationStatus('ready'); setMessage('');
        writeLastOrganization(uid, preferred);
      } else if (previous && !next.some((organization) => organization.id === previous)) {
        // Cleared synchronously so a late project snapshot for the removed
        // organization cannot replace this message with a project-level one.
        selectedOrganization.current = ''; selectedProject.current = '';
        setOrganizationId(''); setProjectId(''); setProjects([]); setStatus('revoked'); setOrganizationStatus('revoked'); setProjectStatus('idle');
        setMessage('Access to the active organization was revoked. Scoped data and selections were cleared.');
      } else if (!previous && next.length && !switchToPreferred.current) {
        setOrganizationId(preferred || next[0].id); setStatus('ready'); setOrganizationStatus('ready');
      } else {
        setStatus(next.length ? 'ready' : 'empty'); setOrganizationStatus(next.length ? 'ready' : 'empty');
        if (!next.length) setMessage('This account is not in a workspace yet. Enter a company code from your workspace owner to join.');
      }
    }, () => {
      setOrganizations([]); setProjects([]); setOrganizationId(''); setProjectId(''); setStatus('error'); setOrganizationStatus('error'); setProjectStatus('idle');
      setMessage('Workspace access could not be loaded. Try again after checking your connection.');
    });
  }, [uid, cloud]);

  useEffect(() => {
    setProjects([]); setProjectId('');
    if (!uid || !organizationId || !cloud) { setProjectStatus('idle'); return undefined; }
    setStatus('loading'); setProjectStatus('loading');
    return cloud.workspaces.subscribeProjects(uid, organizationId, (projectList) => {
      if (selectedOrganization.current !== organizationId) return;
      const next = [...projectList].sort((a, b) => a.name.localeCompare(b.name));
      const previous = selectedProject.current;
      setProjects(next);
      if (previous && previous === deletingProject.current && !next.some((project) => project.id === previous)) {
        deletingProject.current = '';
        setProjectId(next[0]?.id ?? ''); setStatus(next.length ? 'ready' : 'empty'); setProjectStatus(next.length ? 'ready' : 'empty');
        setMessage(next.length ? '' : 'This organization has no projects yet.');
      } else if (previous && !next.some((project) => project.id === previous)) {
        setProjectId(''); setStatus('revoked'); setProjectStatus('revoked');
        setMessage('Access to the active project was revoked. Its data and selections were cleared.');
      } else if (!previous && next.length) {
        setProjectId(next[0].id); setStatus('ready'); setProjectStatus('ready'); setMessage('');
      } else {
        setStatus(next.length ? 'ready' : 'empty'); setProjectStatus(next.length ? 'ready' : 'empty');
        if (!next.length) setMessage('This organization has no projects yet.');
      }
    }, () => {
      if (selectedOrganization.current !== organizationId) return;
      setProjects([]); setProjectId(''); setStatus('error'); setProjectStatus('error');
      setMessage('Projects could not be loaded. Check your workspace access and try again.');
    });
  }, [uid, organizationId, cloud]);

  useEffect(() => {
    setPlan(null);
    if (!uid || !organizationId || !cloud) return undefined;
    return cloud.workspaces.subscribePlan(organizationId, setPlan);
  }, [uid, organizationId, cloud]);

  return {
    organizations, projects, organizationId, projectId, organizationStatus, projectStatus, status, message, plan,
    selectOrganization(next: string) {
      if (next === organizationId) return;
      if (uid) writeLastOrganization(uid, next);
      setOrganizationId(next); setProjectId(''); setProjects([]); setProjectStatus('loading'); setMessage('');
    },
    /** Selects the organization as soon as the live scope list contains it (for example right after joining). */
    preferOrganization(next: string) {
      preferredOrganization.current = next;
      if (uid) writeLastOrganization(uid, next);
      if (organizations.some((organization) => organization.id === next)) {
        if (next !== organizationId) { setOrganizationId(next); setProjectId(''); setProjects([]); setProjectStatus('loading'); setMessage(''); }
      } else switchToPreferred.current = true;
    },
    /** Marks the selected project as being deleted by this user (pass '' to clear after a failed delete). */
    expectProjectDeletion(next: string) { deletingProject.current = next; },
    selectProject(next: string) {
      if (next === projectId) return;
      setProjectId(next); setMessage('');
    },
  };
}

// The last selected organization ID per account (not a secret; no tokens or
// profile data are stored). Storage failures only lose the preference.
const lastOrganizationKey = (uid: string) => `sayspec.lastOrganization.${uid}`;
function readLastOrganization(uid: string) { try { return window.localStorage.getItem(lastOrganizationKey(uid)) ?? ''; } catch { return ''; } }
function writeLastOrganization(uid: string, organizationId: string) { try { window.localStorage.setItem(lastOrganizationKey(uid), organizationId); } catch { /* preference only */ } }

export function WorkspaceSwitcher({ scope }: { scope: ReturnType<typeof useWorkspaceScope> }) {
  if (scope.status === 'signed-out') return <div className="workspace-switcher"><span>Sign in to load organizations.</span></div>;
  return <section className="workspace-switcher" aria-label="Active workspace">
    <label>Organization<select aria-label="Organization" value={scope.organizationId} onChange={(event) => scope.selectOrganization(event.target.value)} disabled={!scope.organizations.length}>
      {!scope.organizationId && <option value="">{scope.organizations.length ? 'Choose organization' : 'No organization'}</option>}
      {scope.organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name} · {organization.role}</option>)}
    </select></label>
    <label>Project<select aria-label="Project" value={scope.projectId} onChange={(event) => scope.selectProject(event.target.value)} disabled={!scope.organizationId || !scope.projects.length}>
      {!scope.projectId && <option value="">{scope.projects.length ? 'Choose project' : 'No project'}</option>}
      {scope.projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.targetType}</option>)}
    </select></label>
    {scope.status === 'loading' && <StatusLabel status="running">Loading scope</StatusLabel>}
    {scope.status === 'revoked' && <StatusLabel status="failed">Access revoked</StatusLabel>}
    {scope.status === 'error' && <StatusLabel status="warning">Workspace unavailable</StatusLabel>}
    {scope.message && <p className="workspace-message" role="status">{scope.message}</p>}
  </section>;
}
