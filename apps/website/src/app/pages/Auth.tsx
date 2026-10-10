import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AuthFailure, RESET_SENT_MESSAGE, toAuthFailure } from '../auth-errors.ts';
import { OperationError } from '../adapters/types.ts';
import { safeReturnPath } from '../routes.ts';
import { provisionWorkspace, setSetupMessage } from '../setup.ts';
import { accountPasswordError, displayNameError, emailError, workspaceNameError } from '../validation.ts';
import { useAuth, useServices } from '../ui/context.tsx';
import { Field, Loading, Notice, PageTitle, PasswordField, SubmitButton } from '../ui/components.tsx';
import { AppFrame } from '../ui/frame.tsx';
import { Link, navigate, useLocation } from '../ui/router.tsx';
import { DemoAccounts } from '../ui/demo.tsx';

function useReturnPath() {
  const { search } = useLocation();
  return safeReturnPath(search.get('next'), window.location.origin);
}

/** Signed-in visitors on auth pages continue to their (validated) destination. */
function useRedirectWhenSignedIn(target: string, paused: () => boolean) {
  const auth = useAuth();
  useEffect(() => {
    if (auth.status === 'signed-in' && !paused()) navigate(target, { replace: true });
  }, [auth.status, target, paused]);
  return auth;
}

function AuthCard({ title, children, lede }: { title: string; lede?: string; children: React.ReactNode }) {
  return (
    <AppFrame>
      <div className="auth-layout">
        <div className="auth-card">
          <PageTitle title={title}>{lede && <p>{lede}</p>}</PageTitle>
          {children}
        </div>
      </div>
    </AppFrame>
  );
}

export function SignInPage() {
  const services = useServices();
  const next = useReturnPath();
  const { search } = useLocation();
  const busyRef = useRef(false);
  const auth = useRedirectWhenSignedIn(next ?? '/portal/account', () => busyRef.current);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ email?: string | null; password?: string | null; form?: string | null }>({});
  const reason = search.get('reason');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email') ?? '');
    const password = String(data.get('password') ?? '');
    const nextErrors = { email: emailError(email), password: password ? null : 'Enter your password.' };
    setErrors(nextErrors);
    if (nextErrors.email || nextErrors.password) return;
    setBusy(true); busyRef.current = true;
    try {
      await services.auth.signIn(email, password);
      (form.elements.namedItem('password') as HTMLInputElement).value = '';
      navigate(next ?? '/portal/account', { replace: true });
    } catch (error) {
      (form.elements.namedItem('password') as HTMLInputElement).value = '';
      setErrors({ form: toAuthFailure(error).message });
    } finally { setBusy(false); busyRef.current = false; }
  }

  if (auth.status === 'initializing') return <AuthCard title="Sign in"><Loading label="Checking your session…" /></AuthCard>;
  return (
    <AuthCard title="Sign in" lede="Use the email and password for your SaySpec account.">
      {reason === 'expired' && <Notice tone="warning" title="Your session ended.">Sign in again to continue.</Notice>}
      {reason === 'signed-out' && <Notice tone="success">You are signed out of the portal. The desktop app keeps its own session.</Notice>}
      {errors.form && <Notice tone="error">{errors.form}</Notice>}
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Email" name="email" type="email" autoComplete="username" inputMode="email" required error={errors.email} />
        <PasswordField label="Password" name="password" autoComplete="current-password" error={errors.password} />
        <SubmitButton busy={busy} busyLabel="Signing in…">Sign in</SubmitButton>
      </form>
      <p className="auth-links"><Link to="/reset-password">Forgot password?</Link><span aria-hidden="true">·</span><Link to={next ? `/sign-up?next=${encodeURIComponent(next)}` : '/sign-up'}>Create account</Link></p>
      <p className="muted small">The portal is for workspace owners and admins. Testers sign in to the SaySpec desktop app.</p>
      <DemoAccounts />
    </AuthCard>
  );
}

export function SignUpPage() {
  const services = useServices();
  const next = useReturnPath();
  const busyRef = useRef(false);
  const auth = useRedirectWhenSignedIn(next ?? '/portal/account', () => busyRef.current);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const displayName = String(data.get('name') ?? '');
    const email = String(data.get('email') ?? '');
    const password = String(data.get('password') ?? '');
    const workspace = String(data.get('workspace') ?? '');
    const nextErrors = { name: displayNameError(displayName), email: emailError(email), password: accountPasswordError(password), workspace: workspaceNameError(workspace) };
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    setBusy(true); busyRef.current = true;
    const passwordInput = form.elements.namedItem('password') as HTMLInputElement;
    let user;
    try {
      user = await services.auth.signUp({ email, password, displayName });
    } catch (error) {
      passwordInput.value = '';
      const failure = error instanceof AuthFailure ? error : toAuthFailure(error);
      setErrors({ form: failure.message, ...(failure.code === 'weak-password' ? { password: failure.message } : {}) });
      setBusy(false); busyRef.current = false;
      return;
    }
    passwordInput.value = '';
    try {
      await provisionWorkspace(services, user.uid, workspace);
    } catch (error) {
      // The account exists; keep a recoverable finish-setup state instead of
      // retrying sign-up or claiming the workspace exists.
      setSetupMessage(`Your account was created, but the workspace could not be set up. ${error instanceof OperationError ? error.message : 'Try again.'}`);
    }
    setBusy(false); busyRef.current = false;
    navigate(next ?? '/portal/account', { replace: true });
  }

  if (auth.status === 'initializing') return <AuthCard title="Create account"><Loading label="Checking your session…" /></AuthCard>;
  return (
    <AuthCard title="Create account" lede="Create your SaySpec account and a workspace for your team. No payment is needed to create an account.">
      <Notice tone="info">Joining your team as a tester? Create your account in the SaySpec desktop app and enter the company code your admin gave you.</Notice>
      {errors.form && <Notice tone="error">{errors.form}</Notice>}
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Your name" name="name" autoComplete="name" maxLength={80} error={errors.name} hint="Optional. Shown to people in your workspace." />
        <Field label="Email" name="email" type="email" autoComplete="email" inputMode="email" required error={errors.email} />
        <PasswordField label="Password" name="password" autoComplete="new-password" minLength={8} error={errors.password} hint="At least 8 characters." />
        <Field label="Workspace name" name="workspace" autoComplete="organization" required maxLength={120} error={errors.workspace} hint="Usually your company or team. You will be its owner." />
        <SubmitButton busy={busy} busyLabel="Creating account…">Create account</SubmitButton>
      </form>
      <p className="auth-links">Already have an account? <Link to={next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in'}>Sign in</Link></p>
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const services = useServices();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [errors, setErrors] = useState<{ email?: string | null; form?: string | null }>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '');
    const problem = emailError(email);
    setErrors({ email: problem });
    if (problem) return;
    setBusy(true);
    try { await services.auth.sendPasswordReset(email); setSent(true); }
    catch (error) {
      const failure = toAuthFailure(error);
      // Only transport/format problems surface; account existence never does.
      setErrors(failure.code === 'network' || failure.code === 'too-many-requests' || failure.code === 'invalid-email' ? { form: failure.message } : {});
      if (!['network', 'too-many-requests', 'invalid-email'].includes(failure.code)) setSent(true);
    } finally { setBusy(false); }
  }

  return (
    <AuthCard title="Reset password" lede="Enter your account email and we will send a link to choose a new password.">
      {sent ? (
        <>
          <Notice tone="success">{RESET_SENT_MESSAGE}</Notice>
          <p className="auth-links"><Link to="/sign-in">Back to sign in</Link></p>
        </>
      ) : (
        <>
          {errors.form && <Notice tone="error">{errors.form}</Notice>}
          <form className="stack" onSubmit={submit} noValidate>
            <Field label="Email" name="email" type="email" autoComplete="username" inputMode="email" required error={errors.email} />
            <SubmitButton busy={busy} busyLabel="Sending…">Send reset link</SubmitButton>
          </form>
          <p className="auth-links"><Link to="/sign-in">Back to sign in</Link></p>
        </>
      )}
    </AuthCard>
  );
}
