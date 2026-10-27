import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { JoinResult } from './cloud/backend';
import { useCloud } from './cloud/context';
import { formatJoinCode, normalizeJoinCode, type JoinFailure } from './join-code';
import { Button, Field, StatePanel } from './ui';
import type { useWorkspaceScope } from './workspace';

type Scope = ReturnType<typeof useWorkspaceScope>;
type RedeemResult = JoinResult;

export type JoinState =
  | { status: 'idle' }
  | { status: 'joining'; code: string }
  | { status: 'joined'; code: string; result: RedeemResult }
  | ({ status: 'failed'; code: string } & JoinFailure);

/**
 * Company-code joining. Lives at the app level so a join started from the
 * account-creation dialog survives the switch to the signed-in screens. The
 * code is kept only in memory for a retry.
 */
export function useJoinWorkspace(workspace: Scope) {
  const cloud = useCloud();
  const [state, setState] = useState<JoinState>({ status: 'idle' });
  async function join(raw: string) {
    const code = normalizeJoinCode(raw);
    if (!code) { setState({ status: 'failed', code: raw.trim(), kind: 'invalid-format', message: 'Enter the 8-letter company code, for example ABCD-EFGH.' }); return; }
    if (!cloud) { setState({ status: 'failed', code, kind: 'unknown', message: 'This build has no cloud backend to join.' }); return; }
    setState({ status: 'joining', code });
    try {
      const data = await cloud.workspaces.redeemJoinCode(code);
      workspace.preferOrganization(data.organizationId);
      setState({ status: 'joined', code, result: data });
    } catch (error) { setState({ status: 'failed', code, ...cloud.workspaces.describeJoinError(error) }); }
  }
  return { state, join, reset: () => setState({ status: 'idle' }) };
}
export type JoinFlow = ReturnType<typeof useJoinWorkspace>;

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', reviewer: 'Reviewer', viewer: 'Viewer' };

export function JoinWorkspaceForm({ flow, autoFocus = false }: { flow: JoinFlow; autoFocus?: boolean }) {
  const [code, setCode] = useState(flow.state.status === 'failed' || flow.state.status === 'joining' ? flow.state.code : '');
  const state = flow.state;
  const formatError = code.trim() && !normalizeJoinCode(code) ? 'Enter the 8-letter company code, for example ABCD-EFGH.' : undefined;
  function submit(event: FormEvent) { event.preventDefault(); if (!formatError && code.trim()) void flow.join(code); }
  return <form className="join-form" onSubmit={submit} data-testid="join-workspace-form">
    <Field label="Company code" value={code} onChange={(event) => { setCode(event.target.value); if (state.status === 'failed' || state.status === 'joined') flow.reset(); }} placeholder="ABCD-EFGH" autoComplete="off" spellCheck={false} autoFocus={autoFocus} error={formatError} hint="Your workspace owner or admin can find it in the SaySpec account portal." />
    {state.status === 'joining' && <p role="status" className="join-progress">Joining with {formatJoinCode(state.code)}…</p>}
    {state.status === 'failed' && <div className="inline-error" role="alert" data-join-failure={state.kind}><p>{state.message}</p>{state.kind !== 'invalid-format' && state.kind !== 'signed-out' && <Button type="button" onClick={() => void flow.join(state.code)}>Try again</Button>}</div>}
    {state.status === 'joined' && <p role="status" data-testid="join-success">{state.result.joined ? `Joined ${state.result.name} as ${ROLE_LABEL[state.result.role] ?? state.result.role}.` : `You are already a member of ${state.result.name} (${ROLE_LABEL[state.result.role] ?? state.result.role}).`} Opening the workspace…</p>}
    <Button type="submit" variant="primary" disabled={state.status === 'joining' || !code.trim() || Boolean(formatError)}>{state.status === 'joining' ? 'Joining…' : 'Join workspace'}</Button>
  </form>;
}

export function OpenAccountPortal({ label = 'Open account portal', page = 'portal' }: { label?: string; page?: 'portal' | 'billing' }) {
  const [error, setError] = useState('');
  return <><Button type="button" variant="quiet" onClick={() => { setError(''); void window.sayspec?.openAccountPortal({ page }).catch(() => setError('The account portal could not be opened.')); }}>{label}</Button>{error && <span className="inline-error" role="alert">{error}</span>}</>;
}

/** Signed in, but no workspace is selected: join with a code, pick another membership, or set one up in the portal. */
export function NoWorkspacePanel({ workspace, flow }: { workspace: Scope; flow: JoinFlow }) {
  const title = workspace.organizationStatus === 'error' ? 'Workspace unavailable'
    : workspace.organizationStatus === 'revoked' ? 'Workspace access changed'
    : workspace.organizations.length ? 'Choose a workspace' : 'Join your team';
  return <section className="welcome-card join-card" data-testid="no-workspace">
    <h1>{title}</h1>
    {workspace.message && <p role="status">{workspace.message}</p>}
    {workspace.organizations.length > 0 && <ul className="workspace-choices" aria-label="Your workspaces">
      {workspace.organizations.map((organization) => <li key={organization.id}><Button onClick={() => workspace.selectOrganization(organization.id)}>{organization.name} · {ROLE_LABEL[organization.role] ?? organization.role}</Button></li>)}
    </ul>}
    <h2>{workspace.organizations.length ? 'Join another workspace' : 'Enter your company code'}</h2>
    <p>Testers join right away as Editor while the workspace has free seats. Guest projects on this Mac stay local and are not uploaded.</p>
    <JoinWorkspaceForm flow={flow} autoFocus />
    <div className="owner-hint"><p>Setting up a team? Create your workspace and company code in the account portal with this same account.</p><OpenAccountPortal /></div>
  </section>;
}

/** "Join workspace" from the signed-in shell, for people on several teams. */
export function JoinWorkspaceDialog({ flow }: { flow: JoinFlow }) {
  const [open, setOpen] = useState(false);
  return <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next && flow.state.status !== 'joining') flow.reset(); }}>
    <Dialog.Trigger asChild><Button variant="quiet">Join workspace</Button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content" aria-describedby="join-workspace-description">
      <Dialog.Title>Join another workspace</Dialog.Title>
      <Dialog.Description id="join-workspace-description">Enter the company code from that workspace's owner. You keep your other workspaces.</Dialog.Description>
      <JoinWorkspaceForm flow={flow} autoFocus />
      <div className="dialog-actions"><Dialog.Close asChild><Button type="button">Close</Button></Dialog.Close></div>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}

/**
 * Members without owner/admin rights cannot create projects. Every project is
 * shared with the whole workspace, so this shows only while it has none.
 */
export function NoProjectAccess({ workspace }: { workspace: Scope }) {
  const organization = workspace.organizations.find((item) => item.id === workspace.organizationId);
  return <div data-testid="no-project-access"><StatePanel tone="empty" title="No projects yet">
    You are {organization?.role === 'editor' ? 'an Editor' : `a ${ROLE_LABEL[organization?.role ?? ''] ?? 'member'}`} in {organization?.name ?? 'this workspace'}. Its projects appear here as soon as an owner or admin creates one.
  </StatePanel></div>;
}
