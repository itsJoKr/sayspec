import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/** Origins the renderer may connect to besides itself: only the configured cloud backend, if any. */
function cloudConnectSources(env: Record<string, string>) {
  if (env.VITE_SAYSPEC_CLOUD !== 'firebase') return [];
  if (env.VITE_FIREBASE_USE_EMULATORS === 'true') return ['http://127.0.0.1:9099', 'http://127.0.0.1:8080', 'ws://127.0.0.1:8080', 'http://127.0.0.1:9199', 'ws://127.0.0.1:9199', 'http://127.0.0.1:5001'];
  return ['https://*.googleapis.com', 'https://*.firebaseapp.com', 'https://*.firebasestorage.app', 'https://*.cloudfunctions.net', 'https://*.firebaseio.com', 'wss://*.firebaseio.com'];
}

// SAYSPEC_ENV selects the env file (.env.<SAYSPEC_ENV>; see .env.example), for the
// renderer here and for main/preload in scripts/build-electron.mjs. Unset builds
// a local-only app with no cloud backend.
export default defineConfig(({ mode: cliMode, command }) => {
  const mode = process.env.SAYSPEC_ENV || cliMode;
  const env = loadEnv(mode, process.cwd(), '');
  const connect = [...cloudConnectSources(env), ...(command === 'serve' ? ['ws://127.0.0.1:5173'] : [])];
  return {
    mode,
    plugins: [react(), {
      name: 'sayspec-csp',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          const withConnect = html.replace('%SAYSPEC_CONNECT_SRC%', connect.join(' '));
          // React Refresh uses an inline preamble only in the local dev server.
          return command === 'serve' ? withConnect.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : withConnect;
        },
      },
    }],
    define: {
      // Debug builds only (SAYSPEC_DEBUG_BUILD=1): test accounts from the git-ignored env file, never in releases.
      __SAYSPEC_DEBUG_LOGINS__: JSON.stringify(process.env.SAYSPEC_DEBUG_BUILD === '1' ? env.SAYSPEC_DEBUG_LOGINS ?? '' : ''),
    },
    base: './',
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
  };
});
