import { build } from 'esbuild';
import { loadEnv } from 'vite';
import { accountPortalOrigin, firebaseFunctionsBaseUrl } from './build-env.mjs';

/**
 * Builds main and preload with the same environment as the renderer:
 * SAYSPEC_ENV picks the env file (`.env.<SAYSPEC_ENV>`, see .env.example);
 * unset is a local-only build with no cloud backend and no auto-updates.
 */
export async function buildElectron() {
  const mode = process.env.SAYSPEC_ENV || 'production';
  const env = { ...loadEnv(mode, new URL('..', import.meta.url).pathname, ''), ...process.env };
  await build({
    entryPoints: ['electron/main.ts', 'electron/preload.ts'],
    outdir: 'dist-electron', outExtension: { '.js': '.cjs' },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    define: {
      __SAYSPEC_CLOUD_FUNCTIONS_URL__: JSON.stringify(firebaseFunctionsBaseUrl(env)),
      __SAYSPEC_ACCOUNT_PORTAL_ORIGIN__: JSON.stringify(accountPortalOrigin(env)),
      // Only official releases poll the publisher's update feed (package.json build.publish); forks never do.
      __SAYSPEC_AUTO_UPDATES__: JSON.stringify(env.SAYSPEC_AUTO_UPDATES === '1'),
    },
    external: ['electron', 'playwright-core', 'node-pty', '@playwright/test'], sourcemap: true,
  });
}
await buildElectron();
