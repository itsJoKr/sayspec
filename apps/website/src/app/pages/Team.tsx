import { useEffect, useState, type FormEvent } from 'react';
import { JOIN_CODE_ROLE, NotConnectedError, OperationError, type JoinCodeState, type Loadable, type Member } from '../adapters/types.ts';
import { assignableRoles, canChangeRole, canManageTeam, canRemoveMember, ROLE_LABELS, ROLE_SUMMARIES, type ActorContext, type Role } from '../permissions.ts';
import { PLAN_NAMES } from '../plan.ts';
import { formatJoinCode } from '../validation.ts';
import { useServices } from '../ui/context.tsx';
import { Badge, Dialog, formatDate, Loading, Notice, PageTitle, shortId, SubmitButton } from '../ui/components.tsx';
import { Link } from '../ui/router.tsx';
import { useWorkspace } from '../ui/workspace-context.tsx';
import { SeatMeter, useSeatUsage } from './Billing.tsx';

type Action = { kind: 'role' | 'remove'; member: Member };

function errorText(error: unknown, fallback: string) {
  return error instanceof NotConnectedError || error instanceof OperationError ? error.message : fallback;
}

export function TeamPage() {
  const data = useWorkspace();
  const services = useServices();
  const [action, setAction] = useState<Action | null>(null);
  const [flash, setFlash] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);
  const manager = canManageTeam(data.role);
  const actor: ActorContext = { uid: data.user.uid, role: data.role, ownerUids: data.ownerUids };

  const members = data.members.status === 'ready' ? [...data.members.data].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || roleOrder(a.role) - roleOrder(b.role)) : [];
  const seats = useSeatUsage();

  const close = (message?: string) => { setAction(null); if (message) setFlash({ tone: 'success', text: message }); };

  return (
    <>
      <PageTitle title="Team"><p>People in {data.scope.name}. Testers create their own SaySpec account and join with your company code. Removing someone here does not delete their SaySpec account.</p></PageTitle>

      {manager && <CompanyCodePanel onFlash={setFlash} />}

      <section className="panel seat-summary" aria-labelledby="seats-heading">
        <div className="panel-head">
          <h2 id="seats-heading">Seats</h2>
          <Link className="text-link" to="/portal/billing">{data.billing.status === 'ready' ? PLAN_NAMES[data.billing.data.kind] : 'Plan'}</Link>
        </div>
        <SeatMeter />
        {seats?.full && (
          <Notice tone="warning" title={seats.over ? 'Over the seat limit.' : `All ${seats.limit} seats are in use.`}>
            New testers cannot join until {seats.over ? 'enough members are' : 'a member is'} removed. Nobody is removed automatically.
          </Notice>
        )}
      </section>

      {flash && <Notice tone={flash.tone}>{flash.text}</Notice>}

      <section className="panel" aria-labelledby="members-heading">
        <div className="panel-head"><h2 id="members-heading">Members</h2></div>
        {data.members.status === 'loading' && <Loading label="Loading members…" />}
        {data.members.status === 'error' && (
          <Notice tone="error" title="Members could not be loaded.">
            <p>{data.members.message}</p>
            <button type="button" className="button button-small" onClick={() => window.location.reload()}>Reload</button>
          </Notice>
        )}
        {data.members.status === 'ready' && members.length <= 1 && (
          <p className="empty-state">You are the only member of this workspace. Share the company code so testers can join from the desktop app.</p>
        )}
        {data.members.status === 'ready' && members.length > 0 && (
          <div className="table-wrap">
            <table className="members-table">
              <caption className="visually-hidden">Workspace members</caption>
              <thead><tr><th scope="col">Member</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Seat</th>{manager && <th scope="col"><span className="visually-hidden">Actions</span></th>}</tr></thead>
              <tbody>
                {members.map((member) => <MemberRow key={member.uid} member={member} actor={actor} manager={manager} onAction={(kind) => { setFlash(null); setAction({ kind, member }); }} />)}
              </tbody>
            </table>
          </div>
        )}
        {!services.workspace.capabilities.memberDirectory && data.members.status === 'ready' && members.length > 1 && (
          <p className="muted small">Names and emails of other members are not available yet: membership records do not include them.</p>
        )}
      </section>

      {action?.kind === 'role' && <ChangeRoleDialog member={action.member} actor={actor} onClose={close} />}
      {action?.kind === 'remove' && <RemoveDialog member={action.member} actor={actor} onClose={close} />}
    </>
  );
}

const roleOrder = (role: Role) => ['owner', 'admin', 'editor', 'reviewer', 'viewer'].indexOf(role);

export function memberName(member: Member, selfUid: string, selfName: string | null) {
  if (member.displayName) return member.displayName;
  if (member.uid === selfUid && selfName) return selfName;
  return 'Name unavailable';
}

function CompanyCodePanel({ onFlash }: { onFlash: (flash: { tone: 'success' | 'info'; text: string } | null) => void }) {
  const services = useServices();
  const data = useWorkspace();
  const connected = services.workspace.capabilities.joinCodes;
  const [state, setState] = useState<Loadable<JoinCodeState>>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => (connected ? services.workspace.subscribeJoinCode(data.scope.id, setState) : undefined), [services, connected, data.scope.id]);

  async function run(operation: () => Promise<void>, success: string) {
    setBusy(true); setError(null); onFlash(null);
    try { await operation(); onFlash({ tone: 'success', text: success }); }
    catch (failure) { setError(errorText(failure, 'The company code could not be changed. Try again.')); }
    finally { setBusy(false); }
  }

  const joinCode = state.status === 'ready' ? state.data : null;
  const rotate = () => run(() => services.workspace.rotateJoinCode(data.scope.id), 'A new company code is ready. The previous code no longer works.');

  return (
    <section className="panel" aria-labelledby="code-heading">
      <h2 id="code-heading">Company code</h2>
      <p className="muted">Testers enter this code in the SaySpec desktop app, when they create their account or later from the app. They join {data.scope.name} right away as {ROLE_LABELS[JOIN_CODE_ROLE]}, while free seats are left.</p>
      {!connected && (
        <Notice tone="unavailable" title="Company codes are not connected yet.">No code can be generated, and testers cannot join this workspace until the SaySpec backend supports it.</Notice>
      )}
      {connected && state.status === 'loading' && <Loading label="Loading company code…" />}
      {connected && state.status === 'error' && <Notice tone="error">{state.message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {joinCode && !joinCode.code && (
        <div className="button-row">
          <button type="button" className="button button-small" disabled={busy} onClick={rotate}>{busy ? 'Generating…' : 'Generate company code'}</button>
        </div>
      )}
      {joinCode?.code && (
        <>
          <div className="join-code-row">
            <output className={`join-code${joinCode.enabled ? '' : ' join-code-off'}`} aria-label={`Company code ${joinCode.code.split('').join(' ')}`}>{formatJoinCode(joinCode.code)}</output>
            <button type="button" className="button-quiet" disabled={!joinCode.enabled} onClick={async () => { try { await navigator.clipboard.writeText(joinCode.code!); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Copied' : 'Copy'}</button>
            {joinCode.enabled ? <Badge tone="success">Joining on</Badge> : <Badge>Joining off</Badge>}
          </div>
          <p className="muted small">{joinCode.enabled ? 'Anyone with this code can join. Share it only with your team.' : 'Joining is off. The code is rejected until you turn joining back on.'} {joinCode.rotatedAt && `Generated ${formatDate(joinCode.rotatedAt)}.`}</p>
          <div className="button-row">
            <button type="button" className="button-quiet" disabled={busy} onClick={() => setConfirmRotate(true)}>Generate new code</button>
            {joinCode.enabled
              ? <button type="button" className="button-quiet" disabled={busy} onClick={() => run(() => services.workspace.setJoinCodeEnabled(data.scope.id, false), 'Joining is off. The company code no longer works.')}>Turn off joining</button>
              : <button type="button" className="button-quiet" disabled={busy} onClick={() => run(() => services.workspace.setJoinCodeEnabled(data.scope.id, true), 'Joining is on again.')}>Turn on joining</button>}
          </div>
        </>
      )}
      <Dialog open={confirmRotate} title="Generate a new company code?" onClose={() => setConfirmRotate(false)} description={
        <ul className="plain-list bullets">
          <li>The current code stops working immediately.</li>
          <li>People who already joined stay in the workspace.</li>
          <li>Anyone who has not joined yet needs the new code.</li>
        </ul>
      }>
        <div className="button-row">
          <button type="button" className="button" disabled={busy} onClick={async () => { await rotate(); setConfirmRotate(false); }}>{busy ? 'Generating…' : 'Generate new code'}</button>
          <button type="button" className="button-quiet" onClick={() => setConfirmRotate(false)}>Cancel</button>
        </div>
      </Dialog>
    </section>
  );
}

function MemberRow({ member, actor, manager, onAction }: { member: Member; actor: ActorContext; manager: boolean; onAction: (kind: 'role' | 'remove') => void }) {
  const data = useWorkspace();
  const self = member.uid === actor.uid;
  const name = memberName(member, actor.uid, data.user.displayName ?? data.user.email);
  const email = member.email ?? (self ? data.user.email : null);
  const active = member.status === 'active';
  const lastOwner = member.role === 'owner' && active && actor.ownerUids.length <= 1;
  const removal = canRemoveMember(actor, member);
  const roleChange = assignableRoles(actor.role).some((role) => role !== member.role && canChangeRole(actor, member, role).allowed);
  return (
    <tr className={active ? undefined : 'row-inactive'}>
      <th scope="row">
        <span className="member-name">{name}{self && <Badge tone="accent">You</Badge>}</span>
        <span className="member-sub">{member.joinedVia === 'join-code' ? `Joined with company code · ${formatDate(member.joinedAt)}` : `ID ${shortId(member.uid)}`}</span>
      </th>
      <td>{email ?? <span className="muted">Unavailable</span>}</td>
      <td>{ROLE_LABELS[member.role]}</td>
      <td>{active ? <Badge tone="success">Active</Badge> : member.status === 'revoked' ? <Badge>Removed</Badge> : <Badge>{member.status}</Badge>}</td>
      <td>{active ? '1 seat' : 'No seat'}</td>
      {manager && (
        <td><div className="row-actions">
          {active && roleChange && <button type="button" className="button-quiet" onClick={() => onAction('role')}>Change role<span className="visually-hidden"> for {name}</span></button>}
          {active && !self && removal.allowed && <button type="button" className="button-quiet danger" onClick={() => onAction('remove')}>Remove<span className="visually-hidden"> {name}</span></button>}
          {lastOwner && <span className="protected-note" title="The last owner cannot be removed or demoted.">Last owner · protected</span>}
        </div></td>
      )}
    </tr>
  );
}

function ChangeRoleDialog({ member, actor, onClose }: { member: Member; actor: ActorContext; onClose: (message?: string) => void }) {
  const services = useServices();
  const data = useWorkspace();
  const options = assignableRoles(actor.role);
  const [role, setRole] = useState<Role>(member.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decision = role === member.role ? { allowed: false as const, reason: 'Choose a different role.' } : canChangeRole(actor, member, role);
  const name = memberName(member, actor.uid, data.user.displayName);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!decision.allowed) return;
    setBusy(true); setError(null);
    try { await services.workspace.changeMember({ organizationId: data.scope.id, uid: member.uid, role }); onClose(`${name} is now ${ROLE_LABELS[role]}.`); }
    catch (failure) { setError(failure instanceof OperationError && failure.kind === 'failed-precondition' ? 'That change is not allowed. The workspace must keep at least one owner.' : errorText(failure, 'The role could not be changed. Try again.')); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open title={`Change role for ${name}`} onClose={() => onClose()}>
      <form className="stack" onSubmit={submit}>
        <fieldset className="role-options">
          <legend>Role</legend>
          {options.map((option) => (
            <label key={option} className="radio"><input type="radio" name="role" value={option} checked={role === option} onChange={() => setRole(option)} /><span><strong>{ROLE_LABELS[option]}</strong><small>{ROLE_SUMMARIES[option]}</small></span></label>
          ))}
        </fieldset>
        {(role === 'owner' || role === 'admin') && member.role !== role && <Notice tone="warning">{role === 'owner' ? 'Owners have full control of the workspace, including billing.' : 'Admins can use this portal to manage members and the company code.'}</Notice>}
        {!decision.allowed && role !== member.role && <Notice tone="warning">{decision.reason}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="button-row">
          <SubmitButton busy={busy} busyLabel="Saving…" disabled={!decision.allowed}>Save role</SubmitButton>
          <button type="button" className="button-quiet" onClick={() => onClose()}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}

function RemoveDialog({ member, actor, onClose }: { member: Member; actor: ActorContext; onClose: (message?: string) => void }) {
  const services = useServices();
  const data = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotate, setRotate] = useState(false);
  const decision = canRemoveMember(actor, member);
  const name = memberName(member, actor.uid, data.user.displayName);
  const codes = services.workspace.capabilities.joinCodes;

  async function confirm() {
    setBusy(true); setError(null);
    try {
      await services.workspace.changeMember({ organizationId: data.scope.id, uid: member.uid, status: 'revoked' });
    } catch (failure) {
      setError(failure instanceof OperationError && failure.kind === 'failed-precondition' ? 'The last owner cannot be removed.' : errorText(failure, 'The member could not be removed. Try again.'));
      setBusy(false);
      return;
    }
    let suffix = '';
    if (rotate) {
      try { await services.workspace.rotateJoinCode(data.scope.id); suffix = ' A new company code was generated.'; }
      catch { suffix = ' The company code could not be changed; generate a new one from Company code.'; }
    }
    setBusy(false);
    onClose(`${name} was removed from ${data.scope.name}.${suffix}`);
  }

  return (
    <Dialog open title={`Remove ${name}?`} onClose={() => onClose()} description={
      <ul className="plain-list bullets">
        <li>They lose access to {data.scope.name} and its projects right away.</li>
        <li>Their SaySpec account and any other workspaces they belong to are not affected.</li>
        <li>Their seat becomes free for someone else.</li>
        {codes && <li>They could join again with the current company code.</li>}
      </ul>
    }>
      {codes && <label className="checkbox"><input type="checkbox" checked={rotate} onChange={(event) => setRotate(event.target.checked)} /> Also generate a new company code so they cannot rejoin</label>}
      {!decision.allowed && <Notice tone="warning">{decision.reason}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="button-row">
        <button type="button" className="button button-danger" disabled={busy || !decision.allowed} onClick={confirm}>{busy ? 'Removing…' : `Remove from ${data.scope.name}`}</button>
        <button type="button" className="button-quiet" onClick={() => onClose()}>Cancel</button>
      </div>
    </Dialog>
  );
}
