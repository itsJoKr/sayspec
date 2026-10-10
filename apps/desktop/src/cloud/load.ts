import type { CloudBackend } from './backend';

/**
 * Chooses the cloud backend at build time from `VITE_SAYSPEC_CLOUD` (see
 * apps/desktop/.env.example). Unset means a local-only build: no backend is
 * loaded and its code is left out of the bundle.
 *
 * To add another backend, implement `CloudBackend` in its own folder and add
 * a branch here.
 */
export async function loadCloudBackend(): Promise<CloudBackend | null> {
  const kind = import.meta.env.VITE_SAYSPEC_CLOUD;
  if (kind === 'firebase') return (await import('./firebase/backend')).createFirebaseBackend();
  if (kind) throw new Error(`Unknown cloud backend "${kind}" in VITE_SAYSPEC_CLOUD.`);
  return null;
}
