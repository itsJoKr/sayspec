import { useState, type FormEvent } from 'react';
import type { WorkspaceScope } from '../adapters/types.ts';
import { RESET_SENT_MESSAGE, toAuthFailure } from '../auth-errors.ts';
import { ROLE_LABELS, ROLE_SUMMARIES } from '../permissions.ts';
import { accountPasswordError, displayNameError } from '../validation.ts';
import { useServices } from '../ui/context.tsx';
import { Badge, Field, Notice, PageTitle, PasswordField, shortId, SubmitButton } from '../ui/components.tsx';
import { SignOutButton } from '../ui/frame.tsx';
import { useWorkspace } from '../ui/workspace-context.tsx';

export function AccountPage({ scopes, onSelect }: { scopes: WorkspaceScope[]; onSelect: (id: string) => void }) {
  const data = useWorkspace();
  const { user, role } = data;
  const owners = data.ownerUids;
  const isOwner = owners.includes(user.uid);
  return (
    <>
      <PageTitle title="Account"><p>Your sign-in details and your place in {data.scope.name}.</p></PageTitle>
      <div className="panel-grid">
        <ProfilePanel />
        <section className="panel" aria-labelledby="workspace-heading">
          <h2 id="workspace-heading">Workspace</h2>
          <dl className="details">
            <div><dt>Selected workspace</dt><dd>{data.scope.name}</dd></div>
            <div><dt>Your role</dt><dd><Badge tone={role === 'owner' ? 'accent' : 'neutral'}>{ROLE_LABELS[role]}</Badge> <span className="muted small">{ROLE_SUMMARIES[role]}</span></dd></div>
            <div><dt>Workspace owner</dt><dd>{data.workspace.status !== 'ready' ? 'Loading…' : isOwner ? (owners.length > 1 ? `You and ${owners.length - 1} other owner${owners.length > 2 ? 's' : ''}` : 'You') : <OwnerLabel ownerUids={owners} />}</dd></div>
          </dl>
          {!isOwner && data.workspace.status === 'ready' && <p className="muted small">The owner manages this workspace’s plan. You sign in with your own account and never share the owner’s login or billing details.</p>}
          {scopes.length > 1 && (
            <div className="field">
              <label htmlFor="account-workspace">Switch workspace</label>
              <select id="account-workspace" value={data.scope.id} onChange={(event) => onSelect(event.target.value)}>
                {scopes.map((scope) => <option key={scope.id} value={scope.id}>{scope.name} · {ROLE_LABELS[scope.role]}</option>)}
              </select>
              <p className="field-hint">Switching clears the data shown for the previous workspace.</p>
            </div>
          )}
        </section>
        <SecurityPanel />
      </div>
    </>
  );
}

function OwnerLabel({ ownerUids }: { ownerUids: string[] }) {
  const data = useWorkspace();
  const members = data.members.status === 'ready' ? data.members.data : [];
  const labels = ownerUids.map((uid) => {
    const member = members.find((item) => item.uid === uid);
    return member?.displayName ?? member?.email ?? `Owner account ${shortId(uid)}`;
  });
  return <>{labels.join(', ') || 'Unavailable'}</>;
}

function ProfilePanel() {
  const services = useServices();
  const { user } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('displayName') ?? '');
    const problem = displayNameError(name);
    setFieldError(problem); setResult(null);
    if (problem) return;
    setBusy(true);
    try { await services.auth.updateDisplayName(name); setResult({ tone: 'success', text: 'Name saved.' }); }
    catch (error) { setResult({ tone: 'error', text: toAuthFailure(error).message }); }
    finally { setBusy(false); }
  }

  return (
    <section className="panel" aria-labelledby="profile-heading">
      <h2 id="profile-heading">Profile</h2>
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Name" name="displayName" defaultValue={user.displayName ?? ''} key={user.displayName ?? ''} autoComplete="name" maxLength={80} error={fieldError} />
        <div className="field">
          <span className="field-label" id="email-label">Email</span>
          <p className="field-static" aria-labelledby="email-label">{user.email ?? 'No email on this account'}</p>
          <p className="field-hint">Changing your email is not available in the portal yet.</p>
        </div>
        {result && <Notice tone={result.tone}>{result.text}</Notice>}
        <SubmitButton busy={busy} busyLabel="Saving…" className="button button-small">Save name</SubmitButton>
      </form>
      <p className="muted small">Account ID <code>{user.uid}</code></p>
    </section>
  );
}

function SecurityPanel() {
  const services = useServices();
  const { user } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const current = String(values.get('current') ?? ''); const next = String(values.get('next') ?? ''); const confirm = String(values.get('confirm') ?? '');
    const nextErrors = {
      current: current ? null : 'Enter your current password.',
      next: accountPasswordError(next) ?? (next === current ? 'Choose a password different from your current one.' : null),
      confirm: next === confirm ? null : 'The passwords do not match.',
    };
    setErrors(nextErrors); setResult(null);
    if (Object.values(nextErrors).some(Boolean)) return;
    setBusy(true);
    try { await services.auth.changePassword(current, next); setResult({ tone: 'success', text: 'Password changed. Other signed-in sessions, including the desktop app, may ask you to sign in again.' }); }
    catch (error) { setResult({ tone: 'error', text: toAuthFailure(error).message }); }
    finally { form.reset(); setBusy(false); }
  }

  async function sendReset() {
    if (!user.email) return;
    setResetBusy(true); setResult(null);
    try { await services.auth.sendPasswordReset(user.email); setResult({ tone: 'success', text: RESET_SENT_MESSAGE }); }
    catch (error) { setResult({ tone: 'error', text: toAuthFailure(error).message }); }
    finally { setResetBusy(false); }
  }

  return (
    <section className="panel" aria-labelledby="security-heading">
      <h2 id="security-heading">Security</h2>
      <form className="stack" onSubmit={changePassword} noValidate aria-describedby="password-help">
        <p id="password-help" className="muted small">To change your password, confirm your current one first.</p>
        {/* Hidden username helps password managers associate the new password. */}
        <input type="text" name="username" autoComplete="username" value={user.email ?? ''} readOnly hidden />
        <PasswordField label="Current password" name="current" autoComplete="current-password" error={errors.current} />
        <PasswordField label="New password" name="next" autoComplete="new-password" error={errors.next} hint="At least 8 characters." />
        <PasswordField label="Confirm new password" name="confirm" autoComplete="new-password" error={errors.confirm} />
        {result && <Notice tone={result.tone}>{result.text}</Notice>}
        <div className="button-row">
          <SubmitButton busy={busy} busyLabel="Changing…" className="button button-small">Change password</SubmitButton>
          <button type="button" className="button-quiet" onClick={sendReset} disabled={resetBusy || !user.email}>{resetBusy ? 'Sending…' : 'Email me a reset link instead'}</button>
        </div>
      </form>
      <hr />
      <div className="sign-out-row">
        <div><strong>Sign out of the portal</strong><p className="muted small">The desktop app keeps its own session and stays signed in.</p></div>
        <SignOutButton className="button button-small button-outline" />
      </div>
    </section>
  );
}
