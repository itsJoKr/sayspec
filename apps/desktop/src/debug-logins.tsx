import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useState, type ReactNode } from 'react';
import type { useAuthSession } from './auth';
import { Button } from './ui';

/**
 * Debug builds only (SAYSPEC_DEBUG_BUILD=1, for example `npm run dev:live`):
 * test accounts for manual testing come from `SAYSPEC_DEBUG_LOGINS` in the
 * git-ignored env file and are absent from every other build, so their
 * passwords are never committed or shipped.
 */
const DEBUG_LOGINS = parseDebugLogins(__SAYSPEC_DEBUG_LOGINS__);
export const debugLoginsEnabled = DEBUG_LOGINS.length > 0;

function parseDebugLogins(value: string): Array<{ label: string; email: string; password: string }> {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item?.label === 'string' && typeof item?.email === 'string' && typeof item?.password === 'string') : [];
  } catch { return []; }
}

/** Double-clicking the brand opens a sheet of debug accounts; choosing one signs in. */
export function DebugLoginsBrand({ authSession, children }: { authSession: ReturnType<typeof useAuthSession>; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function signIn(email: string, password: string) {
    setPending(email); setError(null);
    try { await authSession.signIn(email, password); setOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Sign in failed.'); }
    finally { setPending(null); }
  }
  return <>
    <div className="entry-brand" data-testid="debug-logins-brand" onDoubleClick={() => setOpen(true)}>{children}</div>
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal><DialogPrimitive.Overlay className="dialog-overlay" /><DialogPrimitive.Content className="dialog-content" aria-describedby="debug-logins-description">
        <DialogPrimitive.Title>Debug logins</DialogPrimitive.Title>
        <DialogPrimitive.Description id="debug-logins-description">Debug build only. Signs in to a live test account.</DialogPrimitive.Description>
        <div className="entry-choices">
          {DEBUG_LOGINS.map((login) => <button key={login.email} className="entry-choice" disabled={pending !== null} onClick={() => void signIn(login.email, login.password)}>
            <span className="entry-choice-title">{login.label}</span><span className="entry-choice-subtitle">{pending === login.email ? 'Signing in…' : login.email}</span><span className="entry-choice-arrow" aria-hidden="true">→</span>
          </button>)}
        </div>
        {error && <p className="account-message" role="alert">{error}</p>}
        <div className="dialog-actions"><DialogPrimitive.Close asChild><Button type="button">Close</Button></DialogPrimitive.Close></div>
      </DialogPrimitive.Content></DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  </>;
}
