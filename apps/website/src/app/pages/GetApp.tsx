import { resolveDesktopDownload } from '../download.ts';
import { useAuth } from '../ui/context.tsx';
import { Loading, Notice, PageTitle } from '../ui/components.tsx';
import { AppFrame } from '../ui/frame.tsx';
import { Link } from '../ui/router.tsx';

const desktopDownload = resolveDesktopDownload(import.meta.env.VITE_DESKTOP_DOWNLOAD_URL);

export function GetAppPage({ portal }: { portal: 'loading' | 'ready' | 'unavailable' }) {
  const auth = useAuth();
  return (
    <AppFrame>
      <PageTitle eyebrow="Get SaySpec" title="Get SaySpec app">
        <p>Use the Mac app to record and run tests. Use the portal to manage your account, plan and team.</p>
      </PageTitle>
      <div className="choice-grid">
        <section className="choice-card" aria-labelledby="desktop-title">
          <p className="choice-kicker">Desktop app · Mac</p>
          <h2 id="desktop-title">Get the desktop app</h2>
          <p>Record a walkthrough, turn it into an automated test, and run it again on your Mac. Testers create their account in the app and enter their team’s company code.</p>
          <div className="download-area" id="download">
            {desktopDownload.available ? (
              <a className="button" href={desktopDownload.url} data-download-link>Download for Mac</a>
            ) : (
              <>
                <button type="button" className="button" disabled aria-describedby="download-status">Download coming soon</button>
                <p id="download-status" className="muted">The Mac download is not available yet. No file is offered until a verified release is published.</p>
              </>
            )}
          </div>
        </section>

        <section className="choice-card" aria-labelledby="portal-title">
          <p className="choice-kicker">Account portal · Web</p>
          <h2 id="portal-title">Access SaySpec portal</h2>
          <p>For workspace owners and admins: manage your account, the SaySpec plan, your team and its company code.</p>
          <div className="choice-actions" aria-live="polite">
            {portal === 'unavailable' && <Notice tone="unavailable" title="Portal sign-in is not available on this site build.">Account setup has not been configured here yet.</Notice>}
            {portal === 'loading' && <Loading label="Checking whether you are signed in…" />}
            {portal === 'ready' && auth.status === 'initializing' && <Loading label="Checking whether you are signed in…" />}
            {portal === 'ready' && auth.status === 'signed-in' && (
              <>
                <p className="muted">Signed in as <strong>{auth.user.email ?? auth.user.displayName ?? 'your account'}</strong>.</p>
                <Link className="button" to="/portal/account">Open portal</Link>
              </>
            )}
            {portal === 'ready' && auth.status === 'signed-out' && (
              <>
                <Link className="button" to="/sign-in?next=%2Fportal%2Faccount">Sign in</Link>
                <Link className="button button-outline" to="/sign-up">Create account</Link>
              </>
            )}
          </div>        </section>
      </div>
    </AppFrame>
  );
}
