import type { DesktopBridge } from '@sayspec/contracts';
declare global {
  interface Window { sayspec?: DesktopBridge }
  /** JSON list of `{ label, email, password }` test accounts; empty outside debug builds (vite.config.ts). */
  const __SAYSPEC_DEBUG_LOGINS__: string;
  interface ImportMetaEnv {
    /** The cloud backend to build in ("firebase"), or unset for a local-only build. See apps/desktop/.env.example. */
    readonly VITE_SAYSPEC_CLOUD?: string;
  }
}
