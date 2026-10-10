import { useEffect, useState } from 'react';
import { isPortalRoute, parseRoute } from './routes.ts';
import { loadServices, type ServicesState } from './services.ts';
import { ServicesProvider } from './ui/context.tsx';
import { Loading, Notice, PageTitle } from './ui/components.tsx';
import { AppFrame } from './ui/frame.tsx';
import { Link, useLocation } from './ui/router.tsx';
import { ResetPasswordPage, SignInPage, SignUpPage } from './pages/Auth.tsx';
import { GetAppPage } from './pages/GetApp.tsx';
import { PortalRoute } from './pages/Portal.tsx';

export function App() {
  const [state, setState] = useState<ServicesState | null>(null);
  const { pathname } = useLocation();
  const route = parseRoute(pathname);
  useEffect(() => { void loadServices().then(setState); }, []);

  if (route === 'not-found') return <NotFound />;
  if (!state) {
    if (route === 'get-app') return <GetAppPage portal="loading" />;
    return <AppFrame><div className="gate"><Loading label="Loading…" /></div></AppFrame>;
  }
  if (state.status !== 'ready') {
    if (route === 'get-app') return <GetAppPage portal="unavailable" />;
    return <SetupUnavailable detail={state.detail} />;
  }
  return (
    <ServicesProvider services={state.services}>
      {route === 'get-app' && <GetAppPage portal="ready" />}
      {route === 'sign-in' && <SignInPage />}
      {route === 'sign-up' && <SignUpPage />}
      {route === 'reset-password' && <ResetPasswordPage />}
      {isPortalRoute(route) && <PortalRoute route={route} />}
    </ServicesProvider>
  );
}

function SetupUnavailable({ detail }: { detail: string }) {
  return (
    <AppFrame>
      <div className="auth-layout"><div className="auth-card">
        <PageTitle title="Account portal unavailable"><p>Sign-in is not set up on this build of the SaySpec site.</p></PageTitle>
        <Notice tone="unavailable" title="Setup unavailable">No account data is loaded and nothing is saved. {import.meta.env.DEV ? detail : ''}</Notice>
        <p><Link to="/get-app">Back to Get SaySpec app</Link></p>
      </div></div>
    </AppFrame>
  );
}

function NotFound() {
  return (
    <AppFrame>
      <div className="auth-layout"><div className="auth-card">
        <PageTitle title="Page not found"><p>This page does not exist.</p></PageTitle>
        <p><Link to="/portal/account">Go to the portal</Link> or <a href="/">return home</a>.</p>
      </div></div>
    </AppFrame>
  );
}
