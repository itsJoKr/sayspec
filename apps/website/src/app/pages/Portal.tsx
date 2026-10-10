import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { OperationError, type AuthUser, type Loadable, type WorkspaceScope } from '../adapters/types.ts';
import { canUsePortal, ROLE_LABELS } from '../permissions.ts';
import type { RouteName } from '../routes.ts';
import { provisionWorkspace, readPendingWorkspace, takeSetupMessage } from '../setup.ts';
import { workspaceNameError } from '../validation.ts';
import { useAuth, useServices } from '../ui/context.tsx';
import { Field, Loading, Notice, PageTitle, SubmitButton } from '../ui/components.tsx';
import { DemoPanel } from '../ui/demo.tsx';
import { AppFrame, SignOutButton } from '../ui/frame.tsx';
import { Link, navigate } from '../ui/router.tsx';
import { WorkspaceProvider } from '../ui/workspace-context.tsx';
import { AccountPage } from './Account.tsx';
import { BillingPage } from './Billing.tsx';
import { TeamPage } from './Team.tsx';

type PortalPage = 'portal-account' | 'portal-billing' | 'portal-team';
const NAV: Array<[PortalPage, string, string]> = [
  ['portal-account', 'Account', '/portal/account'],
  ['portal-billing', 'Plan', '/portal/billing'],
  ['portal-team', 'Team', '/portal/team'],
];

const selectionKey = (uid: string) => `sayspec.portal.workspace.${uid}`;
function readSelection(uid: string) { try { return sessionStorage.getItem(selectionKey(uid)); } catch { return null; } }
function writeSelection(uid: string, id: string | null) { try { if (id) sessionStorage.setItem(selectionKey(uid), id); else sessionStorage.removeItem(selectionKey(uid)); } catch { /* ignore */ } }

/** Auth gate: nothing protected renders until Firebase has restored the session. */
export function PortalRoute({ route }: { route: RouteName }) {
  const auth = useAuth();
  const page: PortalPage = route === 'portal-billing' || route === 'portal-team' ? route : 'portal-account';
  useEffect(() => {
    if (route === 'portal') navigate('/portal/account', { replace: true });
  }, [route]);
  useEffect(() => {
    if (auth.status !== 'signed-out') return;
    const path = NAV.find(([name]) => name === page)?.[2] ?? '/portal/account';
    navigate(`/sign-in?next=${encodeURIComponent(path)}${auth.reason === 'session-expired' ? '&reason=expired' : ''}`, { replace: true });
  }, [auth, page]);
  if (auth.status !== 'signed-in') {
    return <AppFrame><div className="gate"><Loading label={auth.status === 'initializing' ? 'Checking your session…' : 'Redirecting to sign in…'} /></div></AppFrame>;
  }
  return <PortalWorkspaces key={auth.user.uid} user={auth.user} page={page} />;
}

function PortalWorkspaces({ user, page }: { user: AuthUser; page: PortalPage }) {
  const services = useServices();
  const [scopes, setScopes] = useState<Loadable<WorkspaceScope[]>>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(() => readSelection(user.uid));
  const [revoked, setRevoked] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const known = useRef(new Map<string, string>());

  useEffect(() => services.workspace.subscribeWorkspaces(user.uid, setScopes), [services, user.uid, attempt]);

  const all = useMemo(() => (scopes.status === 'ready' ? scopes.data : []), [scopes]);
  // The portal manages only workspaces where the user is an owner or admin.
  // Testers (editor, reviewer, viewer) use the desktop app.
  const managed = useMemo(() => all.filter((scope) => canUsePortal(scope.role)), [all]);

  // Keep the stored/explicit selection while it is still manageable; if it
  // disappears, say so instead of silently swapping data underneath the user.
  useEffect(() => {
    if (scopes.status !== 'ready') return;
    if (selectedId && !managed.some((scope) => scope.id === selectedId)) {
      const name = known.current.get(selectedId);
      if (name) setRevoked(name);
      setSelectedId(null); writeSelection(user.uid, null);
      if (name) return;
    }
    managed.forEach((scope) => known.current.set(scope.id, scope.name));
    if (!selectedId && managed.length && !revoked) { setSelectedId(managed[0].id); writeSelection(user.uid, managed[0].id); }
  }, [scopes.status, managed, selectedId, revoked, user.uid]);

  const select = useCallback((id: string) => {
    setRevoked(null); setSelectedId(id); writeSelection(user.uid, id);
  }, [user.uid]);

  const handleRevoked = useCallback(() => {
    setSelectedId((current) => {
      if (current) setRevoked(known.current.get(current) ?? 'this workspace');
      writeSelection(user.uid, null);
      return null;
    });
  }, [user.uid]);

  const selected = managed.find((scope) => scope.id === selectedId) ?? null;

  const switcher = managed.length > 1 && selected && (
    <div className="workspace-switcher">
      <label htmlFor="workspace-switcher">Workspace</label>
      <select id="workspace-switcher" value={selected.id} onChange={(event) => select(event.target.value)}>
        {managed.map((scope) => <option key={scope.id} value={scope.id}>{scope.name} · {ROLE_LABELS[scope.role]}</option>)}
      </select>
    </div>
  );

  let body: ReactNode;
  if (scopes.status === 'loading') body = <Loading label="Loading your workspaces…" />;
  else if (scopes.status === 'error') body = (
    <Notice tone="error" title="Workspaces could not be loaded.">
      <p>{scopes.message}</p>
      <button type="button" className="button button-small" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
    </Notice>
  );
  else if (!selected && managed.length === 0 && all.length > 0) body = <TesterOnly user={user} scopes={all} revoked={revoked} />;
  else if (!selected) body = <NoWorkspace user={user} scopes={managed} revoked={revoked} onSelect={select} />;
  else body = (
    <WorkspaceProvider key={selected.id} user={user} scope={selected} onRevoked={handleRevoked}>
      {page === 'portal-account' && <AccountPage scopes={managed} onSelect={select} />}
      {page === 'portal-billing' && <BillingPage />}
      {page === 'portal-team' && <TeamPage />}
    </WorkspaceProvider>
  );

  return (
    <AppFrame wide headerExtra={<><span className="header-user" title={user.email ?? undefined}>{user.displayName || user.email}</span><SignOutButton /></>}>
      <div className={selected ? 'portal-layout' : 'portal-layout portal-layout-single'}>
        {selected && (
          <nav className="portal-nav" aria-label="Portal">
            {NAV.map(([name, label, href]) => <Link key={name} to={href} aria-current={page === name ? 'page' : undefined}>{label}</Link>)}
          </nav>
        )}
        <div className="portal-content">
          {switcher && <div className="portal-toolbar">{switcher}</div>}
          {revoked && selected && <Notice tone="warning" title="Access changed">You no longer manage {revoked}.</Notice>}
          {body}
          <DemoPanel organizationId={selected?.id ?? null} uid={user.uid} />
        </div>
      </div>
    </AppFrame>
  );
}

/** Signed-in testers: the portal is not for them; point them to the desktop app. */
function TesterOnly({ user, scopes, revoked }: { user: AuthUser; scopes: WorkspaceScope[]; revoked: string | null }) {
  return (
    <section className="tester-only">
      <PageTitle title="Use the SaySpec desktop app">
        <p>The portal is for workspace owners and admins. As a tester you record and run tests in the SaySpec desktop app. Sign in there with this same email and password.</p>
      </PageTitle>
      {revoked && <Notice tone="warning">You no longer manage {revoked}.</Notice>}
      <div className="panel">
        <h2>Your workspaces</h2>
        <ul className="plain-list membership-list">
          {scopes.map((scope) => <li key={scope.id}><strong>{scope.name}</strong><span className="muted"> · {ROLE_LABELS[scope.role]}</span></li>)}
        </ul>
        <p className="muted small">Joining another team? Enter its company code in the desktop app.</p>
        <div className="button-row">
          <Link className="button button-small" to="/get-app">Get the desktop app</Link>
          <SignOutButton className="button button-small button-outline" />
        </div>
      </div>
      <details className="panel quiet-details">
        <summary>Want to run your own workspace instead?</summary>
        <CreateWorkspaceForm user={user} />
      </details>
      <p className="muted small">Signed in as {user.email}.</p>
    </section>
  );
}

/** First-account, no-workspace, finish-setup and access-changed states. */
function NoWorkspace({ user, scopes, revoked, onSelect }: { user: AuthUser; scopes: WorkspaceScope[]; revoked: string | null; onSelect: (id: string) => void }) {
  const [message] = useState(() => takeSetupMessage());
  const pending = readPendingWorkspace(user.uid);
  return (
    <section aria-labelledby="setup-title">
      {revoked ? (
        <PageTitle title="Access changed"><p>You no longer manage <strong>{revoked}</strong>. Data from that workspace has been cleared from this page.</p></PageTitle>
      ) : (
        <PageTitle title={pending || message ? 'Finish setting up' : 'Set up your workspace'}><p>You are signed in, but this account does not belong to a workspace yet.</p></PageTitle>
      )}
      {message && <Notice tone="warning">{message}</Notice>}
      {scopes.length > 0 && (
        <div className="panel">
          <h2 id="setup-title">Choose a workspace</h2>
          <ul className="plain-list">{scopes.map((scope) => (
            <li key={scope.id}><button type="button" className="button button-outline" onClick={() => onSelect(scope.id)}>{scope.name} · {ROLE_LABELS[scope.role]}</button></li>
          ))}</ul>
        </div>
      )}
      <div className="panel">
        <h2 id={scopes.length ? undefined : 'setup-title'}>Create a workspace</h2>
        <p className="muted">You will be its owner. Creating a workspace does not start a subscription. Joining your team instead? Enter your company code in the SaySpec desktop app.</p>
        <CreateWorkspaceForm user={user} />
      </div>
    </section>
  );
}

function CreateWorkspaceForm({ user }: { user: AuthUser }) {
  const services = useServices();
  const pending = readPendingWorkspace(user.uid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('workspace') ?? '');
    const problem = workspaceNameError(name);
    setFieldError(problem);
    if (problem) return;
    setBusy(true); setError(null);
    try { await provisionWorkspace(services, user.uid, name); }
    catch (failure) { setError(failure instanceof OperationError ? failure.message : 'The workspace could not be created. Try again.'); }
    finally { setBusy(false); }
  }

  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      <form className="stack narrow" onSubmit={submit} noValidate>
        <Field label="Workspace name" name="workspace" defaultValue={pending?.name ?? ''} maxLength={120} required autoComplete="organization" error={fieldError} />
        <SubmitButton busy={busy} busyLabel="Creating workspace…">{pending ? 'Finish setup' : 'Create workspace'}</SubmitButton>
      </form>
    </>
  );
}
