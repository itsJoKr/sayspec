import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { CloudUser } from './cloud/backend';
import { useCloud, useRequiredCloud } from './cloud/context';
import { Button, Field, StatusLabel } from './ui';
import { normalizeJoinCode } from './join-code';

export type AuthState = { status: 'loading' | 'signed-out' | 'signed-in' | 'offline' | 'revoked'; user: CloudUser | null; message?: string };
const PASSWORD_MIN = 8;

/** The signed-in person in the cloud backend. Without a backend nobody is ever signed in. */
export function useAuthSession() {
  const cloud = useCloud();
  const [state, setState] = useState<AuthState>({ status: cloud ? 'loading' : 'signed-out', user: null });
  useEffect(() => cloud?.auth.onUserChanged(
    (user) => setState({ status: user ? 'signed-in' : 'signed-out', user }),
    (error) => setState({ ...cloud.auth.describeError(error), user: null }),
  ), [cloud]);
  function requireCloud() { if (!cloud) throw new Error('This build has no cloud backend.'); return cloud; }
  return {
    state,
    async signIn(email: string, password: string) {
      const backend = requireCloud();
      setState((current) => ({ ...current, status: 'loading', message: undefined }));
      try {
        setState({ status: 'signed-in', user: await backend.auth.signIn(email, password) });
      } catch (error) {
        setState({ ...backend.auth.describeError(error), user: null });
        throw error;
      }
    },
    /**
     * Creates the person's own account in the cloud backend (the same account
     * pool as the account portal). No workspace is created here; joining
     * happens with a company code.
     */
    async signUp(input: { email: string; password: string; displayName: string }) {
      // No global loading state: the form stays open to show a failure, and a
      // success switches the app through the user listener.
      const user = await requireCloud().auth.signUp(input);
      setState({ status: 'signed-in', user });
      return user;
    },
    /** Neutral: resolves for known and unknown accounts alike. */
    async sendPasswordReset(email: string) { await requireCloud().auth.sendPasswordReset(email); },
    async signOut() {
      await requireCloud().auth.signOut();
      setState({ status: 'signed-out', user: null, message: 'Signed out. Local workspace selections were cleared.' });
    },
    async checkAccess() {
      if (!cloud?.auth.currentUser()) return;
      try {
        setState({ status: 'signed-in', user: await cloud.auth.refreshSession(), message: 'Session is active.' });
      } catch (error) {
        const next = cloud.auth.describeError(error);
        if (next.status === 'revoked') await cloud.auth.signOut();
        setState({ ...next, user: next.status === 'offline' ? cloud.auth.currentUser() : null });
      }
    },
  };
}

type Mode = 'sign-in' | 'create' | 'reset';

export function AccountPanel({ authSession, pro = false, entry = false, onJoinCode, joinAction, onOpen, current = false }: {
  authSession: ReturnType<typeof useAuthSession>; pro?: boolean; entry?: boolean;
  /** Sidebar mode: a signed-in person sees only their name, which opens the Account page. */
  onOpen?: () => void;
  /** Whether the Account page is the open section. */
  current?: boolean;
  /** Called with a normalized company code entered while creating an account. */
  onJoinCode?: (code: string) => void;
  /** Signed-in extra action, for example "Join workspace". */
  joinAction?: ReactNode;
}) {
  const { state } = authSession;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('sign-in');
  // Two entry buttons open one dialog; focus returns to whichever opened it.
  const opener = useRef<HTMLButtonElement | null>(null);
  function openIn(next: Mode, button: HTMLButtonElement) { opener.current = button; setMode(next); setOpen(true); }
  if (state.user && onOpen) return <div className="account-panel" data-pro={pro ? 'true' : undefined}>
    <button type="button" className="account-summary" data-testid="open-account" aria-current={current ? 'page' : undefined} onClick={onOpen}><strong>{state.user.displayName ?? 'SaySpec user'}</strong><span>{state.user.email}</span></button>
    {state.status === 'offline' && <StatusLabel status="warning">Sign-in unavailable</StatusLabel>}
  </div>;
  return <div className={`account-panel${entry ? " account-panel--entry" : ""}`} data-pro={pro ? 'true' : undefined}>
    {state.user ? <>
      <strong>{state.user.displayName ?? 'SaySpec user'}</strong><span>{state.user.email}</span>
      <div className="account-actions"><Button variant="quiet" onClick={() => void authSession.checkAccess()}>Check access</Button>{joinAction}<Button variant="quiet" onClick={() => void authSession.signOut()}>Sign out</Button></div>
    </> : <>
      {entry ? <>
        <button className="entry-choice entry-choice--primary" onClick={(event) => openIn('sign-in', event.currentTarget)}><span className="entry-choice-title">Sign in</span><span className="entry-choice-subtitle">Share tests with your team through SaySpec Cloud</span><span className="entry-choice-arrow" aria-hidden="true">→</span></button>
        <button className="entry-choice" data-testid="create-account" onClick={(event) => openIn('create', event.currentTarget)}><span className="entry-choice-title">Create account</span><span className="entry-choice-subtitle">Join your team with a company code</span><span className="entry-choice-arrow" aria-hidden="true">→</span></button>
      </> : <Button variant="quiet" onClick={(event) => openIn('sign-in', event.currentTarget)}>Sign in</Button>}
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal><DialogPrimitive.Overlay className="dialog-overlay" /><DialogPrimitive.Content className="dialog-content" aria-describedby="account-dialog-description" onCloseAutoFocus={(event) => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); } }}>
          {mode === 'sign-in' && <SignInForm authSession={authSession} onDone={() => setOpen(false)} onMode={setMode} />}
          {mode === 'create' && <CreateAccountForm authSession={authSession} onDone={(code) => { setOpen(false); if (code) onJoinCode?.(code); }} onMode={setMode} />}
          {mode === 'reset' && <ResetPasswordForm authSession={authSession} onMode={setMode} />}
        </DialogPrimitive.Content></DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>}
    {state.status === 'loading' && <StatusLabel status="running">Checking session</StatusLabel>}
    {state.status === 'offline' && <StatusLabel status="warning">Sign-in unavailable</StatusLabel>}
    {state.status === 'revoked' && <StatusLabel status="failed">Access revoked</StatusLabel>}
    {state.message && <p className="account-message" role="status">{state.message}</p>}
  </div>;
}

/** The Account section: who is signed in, plus session and workspace actions. */
export function AccountPage({ authSession, joinAction }: { authSession: ReturnType<typeof useAuthSession>; joinAction?: ReactNode }) {
  return <div className="settings-stack">
    <section className="settings-card account-page" aria-labelledby="account-heading"><h2 id="account-heading">Signed in as</h2><AccountPanel authSession={authSession} joinAction={joinAction} /></section>
  </div>;
}

function SignInForm({ authSession, onDone, onMode }: { authSession: ReturnType<typeof useAuthSession>; onDone: () => void; onMode: (mode: Mode) => void }) {
  // Development backends are seeded with this test account (firebase/scripts/seed-auth.mjs).
  const development = useRequiredCloud().development;
  const [email, setEmail] = useState(development ? 'tester@sayspec.local' : '');
  const [password, setPassword] = useState(development ? 'local-only-password' : '');
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setSubmitting(true);
    try { await authSession.signIn(email, password); onDone(); } catch { /* durable state message is rendered */ }
    finally { setSubmitting(false); setPassword(''); }
  }
  return <>
    <DialogPrimitive.Title>Sign in</DialogPrimitive.Title>
    <DialogPrimitive.Description id="account-dialog-description">Share tests with your team through SaySpec Cloud</DialogPrimitive.Description>
    <form onSubmit={submit} className="auth-form">
      <Field label="Email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} autoFocus required />
      <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      {authSession.state.status === 'signed-out' && authSession.state.message && <p className="inline-error" role="alert">{authSession.state.message}</p>}
      <div className="auth-switch"><Button type="button" variant="quiet" onClick={() => onMode('reset')}>Forgot password?</Button><Button type="button" variant="quiet" onClick={() => onMode('create')}>Create an account</Button></div>
      <div className="dialog-actions"><DialogPrimitive.Close asChild><Button type="button">Cancel</Button></DialogPrimitive.Close><Button type="submit" variant="primary" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in'}</Button></div>
    </form>
  </>;
}

function CreateAccountForm({ authSession, onDone, onMode }: { authSession: ReturnType<typeof useAuthSession>; onDone: (code: string | null) => void; onMode: (mode: Mode) => void }) {
  const cloud = useRequiredCloud();
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false); const [error, setError] = useState('');
  const codeError = code.trim() && !normalizeJoinCode(code) ? 'Enter the 8-letter company code, for example ABCD-EFGH.' : undefined;
  const passwordError = password && password.length < PASSWORD_MIN ? `Use at least ${PASSWORD_MIN} characters.` : undefined;
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (codeError || passwordError) return;
    setSubmitting(true);
    try {
      await authSession.signUp({ email, password, displayName: name });
      onDone(code.trim() ? normalizeJoinCode(code) : null);
    } catch (reason) { setError(cloud.auth.describeError(reason).message); }
    finally { setSubmitting(false); setPassword(''); }
  }
  return <>
    <DialogPrimitive.Title>Create your SaySpec account</DialogPrimitive.Title>
    <DialogPrimitive.Description id="account-dialog-description">Use the same email and password on the SaySpec website. Your own projects in guest mode stay on this Mac.</DialogPrimitive.Description>
    <form onSubmit={submit} className="auth-form" data-testid="create-account-form">
      <Field label="Your name" value={name} autoComplete="name" onChange={(event) => setName(event.target.value)} autoFocus maxLength={80} />
      <Field label="Email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
      <Field label="Password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} error={passwordError} required />
      <Field label="Company code (optional)" value={code} autoComplete="off" spellCheck={false} onChange={(event) => setCode(event.target.value)} error={codeError} hint="From your workspace owner. You can also enter it after creating the account." />
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="auth-switch"><Button type="button" variant="quiet" onClick={() => onMode('sign-in')}>Use an existing account</Button></div>
      <div className="dialog-actions"><DialogPrimitive.Close asChild><Button type="button">Cancel</Button></DialogPrimitive.Close><Button type="submit" variant="primary" disabled={submitting || !email.trim() || !password || Boolean(codeError) || Boolean(passwordError)}>{submitting ? 'Creating account…' : 'Create account'}</Button></div>
    </form>
  </>;
}

function ResetPasswordForm({ authSession, onMode }: { authSession: ReturnType<typeof useAuthSession>; onMode: (mode: Mode) => void }) {
  const [email, setEmail] = useState(''); const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  async function submit(event: FormEvent) {
    event.preventDefault(); setStatus('sending');
    try { await authSession.sendPasswordReset(email); setStatus('sent'); } catch { setStatus('error'); }
  }
  return <>
    <DialogPrimitive.Title>Reset your password</DialogPrimitive.Title>
    <DialogPrimitive.Description id="account-dialog-description">We email a reset link for your SaySpec account.</DialogPrimitive.Description>
    <form onSubmit={submit} className="auth-form">
      <Field label="Email" type="email" autoComplete="username" value={email} onChange={(event) => { setEmail(event.target.value); setStatus('idle'); }} autoFocus required />
      {status === 'sent' && <p role="status">If an account exists for that email, a reset link is on its way. Check your inbox, then sign in with the new password.</p>}
      {status === 'error' && <p className="inline-error" role="alert">The reset request could not be sent. Check your connection and try again.</p>}
      <div className="auth-switch"><Button type="button" variant="quiet" onClick={() => onMode('sign-in')}>Back to sign-in</Button></div>
      <div className="dialog-actions"><DialogPrimitive.Close asChild><Button type="button">Close</Button></DialogPrimitive.Close><Button type="submit" variant="primary" disabled={status === 'sending' || !email.trim()}>{status === 'sending' ? 'Sending…' : 'Send reset link'}</Button></div>
    </form>
  </>;
}
