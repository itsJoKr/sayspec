import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { parseRoute } from '../routes.ts';

const listeners = new Set<() => void>();
let navigatedInApp = false;
window.addEventListener('popstate', () => { navigatedInApp = true; listeners.forEach((listener) => listener()); });

export function navigate(to: string, options: { replace?: boolean } = {}) {
  navigatedInApp = true;
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  listeners.forEach((listener) => listener());
  if (!options.replace) window.scrollTo(0, 0);
}

/** True after the first client-side navigation; used to move focus to the new page heading. */
export function hasNavigatedInApp() { return navigatedInApp; }

function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
const read = () => `${window.location.pathname}${window.location.search}`;

export function useLocation() {
  const href = useSyncExternalStore(subscribe, read);
  const url = new URL(href, window.location.origin);
  return { pathname: url.pathname, search: url.searchParams, href };
}

/** Client-side link for app routes; the marketing page and external URLs load normally. */
export function Link({ to, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (parseRoute(new URL(to, window.location.origin).pathname) === 'not-found') return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...props} />;
}
