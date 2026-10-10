import { pathToFileURL } from 'node:url';

export interface SenderFrameLike {
  url: string;
}

export interface SenderLike {
  mainFrame: SenderFrameLike;
}

export interface InvokeEventLike {
  sender: SenderLike;
  senderFrame: SenderFrameLike | null;
}

export function rendererFileUrl(rendererPath: string): string {
  return pathToFileURL(rendererPath).href;
}

export function isTrustedMainFrame(event: InvokeEventLike, expectedUrl: string): boolean {
  return event.senderFrame !== null
    && event.senderFrame === event.sender.mainFrame
    && event.senderFrame.url === expectedUrl;
}

/**
 * The account portal shares the desktop's cloud accounts. Only the origin
 * fixed at build time can be opened (none in a local-only build); the
 * renderer chooses just the page.
 */
export function accountPortalUrl(input: unknown, configuredOrigin: string) {
  const value = input as { page?: unknown } | null;
  const origin = /^https:\/\/[^/\s]+$|^http:\/\/127\.0\.0\.1:\d+$/.test(configuredOrigin) ? configuredOrigin : null;
  const path = value?.page === 'portal' ? '/portal' : value?.page === 'sign-up' ? '/sign-up' : null;
  if (!origin) throw new Error('This build has no account portal.');
  if (!path) throw new Error('Account portal request is invalid.');
  return `${origin}${path}`;
}
