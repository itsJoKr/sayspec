export type RouteName =
  | 'get-app' | 'sign-in' | 'sign-up' | 'reset-password'
  | 'portal' | 'portal-account' | 'portal-billing' | 'portal-team' | 'not-found';

const ROUTES: Record<string, RouteName> = {
  '/get-app': 'get-app',
  '/sign-in': 'sign-in',
  '/sign-up': 'sign-up',
  '/reset-password': 'reset-password',
  '/portal': 'portal',
  '/portal/account': 'portal-account',
  '/portal/billing': 'portal-billing',
  '/portal/team': 'portal-team',
};

export function parseRoute(pathname: string): RouteName {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return ROUTES[normalized] ?? 'not-found';
}

export function isPortalRoute(route: RouteName) {
  return route === 'portal' || route.startsWith('portal-');
}

/** Pages a sign-in flow may return to. Anything else falls back to the portal. */
const RETURNABLE = new Set(['/get-app', '/portal', '/portal/account', '/portal/billing', '/portal/team']);

/**
 * Accepts only same-origin, known portal paths. Query strings and fragments are
 * dropped so a return link cannot carry state such as fake checkout results.
 */
export function safeReturnPath(raw: string | null | undefined, origin: string): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 512) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw, origin); } catch { return null; }
  if (url.origin !== origin) return null;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  return RETURNABLE.has(path) ? path : null;
}

export function withReturnPath(target: '/sign-in' | '/sign-up', returnPath: string | null) {
  return returnPath ? `${target}?next=${encodeURIComponent(returnPath)}` : target;
}
