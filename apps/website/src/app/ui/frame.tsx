import { useState, type ReactNode } from 'react';
import { useAuth, useOptionalServices } from './context.tsx';
import { Badge, Wordmark } from './components.tsx';
import { Link, navigate } from './router.tsx';

export function RuntimeBadge() {
  const services = useOptionalServices();
  if (!services) return null;
  if (services.runtime.kind === 'fixtures') return <Badge tone="warning">Demo data · development fixtures</Badge>;
  if (services.runtime.emulators) return <Badge tone="accent">Local Firebase emulator · {services.runtime.projectId}</Badge>;
  return null;
}

export function SignOutButton({ className = 'button-quiet' }: { className?: string }) {
  const services = useOptionalServices();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!services) return null;
  return (
    <>
      <button type="button" className={className} disabled={busy} onClick={async () => {
        setBusy(true); setFailed(false);
        try { await services.auth.signOut(); navigate('/sign-in?reason=signed-out', { replace: true }); }
        catch { setFailed(true); }
        finally { setBusy(false); }
      }}>{busy ? 'Signing out…' : 'Sign out'}</button>
      {failed && <span role="alert" className="inline-error">Sign-out failed. Try again.</span>}
    </>
  );
}

export function AppFrame({ children, headerExtra, wide = false }: { children: ReactNode; headerExtra?: ReactNode; wide?: boolean }) {
  const auth = useAuth();
  const services = useOptionalServices();
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header app-header">
        <Wordmark />
        <div className="header-actions">
          <RuntimeBadge />
          {headerExtra}
          {services && auth.status === 'signed-out' && <Link className="header-contact" to="/sign-in">Sign in</Link>}
        </div>
      </header>
      <main id="main" className={wide ? 'app-main app-main-wide' : 'app-main'}>{children}</main>
      <footer className="app-footer">
        <p>© 2026 SaySpec</p>
        <nav aria-label="Footer"><a href="/">Home</a><Link to="/get-app">Get SaySpec app</Link><a href="mailto:contact@joe-it-solutions.com">Contact us</a></nav>
      </footer>
    </>
  );
}
