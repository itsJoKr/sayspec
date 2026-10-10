import type { Services } from './adapters/types.ts';
import { resolveFirebaseRuntime } from './runtime-config.ts';

export type ServicesState =
  | { status: 'ready'; services: Services }
  | { status: 'unconfigured'; detail: string }
  | { status: 'failed'; detail: string };

let pending: Promise<ServicesState> | null = null;

export function loadServices(): Promise<ServicesState> {
  pending ??= (async (): Promise<ServicesState> => {
    // __PORTAL_FIXTURES__ is a compile-time constant; production builds drop
    // this branch and the fixture module entirely. No query parameter or
    // runtime flag can enable fixtures.
    if (__PORTAL_FIXTURES__) {
      const { createFixtureServices } = await import('./fixtures/index.ts');
      return { status: 'ready', services: createFixtureServices() };
    }
    const runtime = resolveFirebaseRuntime(import.meta.env, window.location.hostname);
    if (runtime.kind === 'unconfigured') return { status: 'unconfigured', detail: `Missing ${runtime.missing.join(', ')}.` };
    if (runtime.kind === 'invalid') return { status: 'unconfigured', detail: runtime.reason };
    try {
      const { createFirebaseServices } = await import('./adapters/firebase.ts');
      return { status: 'ready', services: createFirebaseServices(runtime) };
    } catch {
      return { status: 'failed', detail: 'The account service could not start. Reload the page to try again.' };
    }
  })();
  return pending;
}
