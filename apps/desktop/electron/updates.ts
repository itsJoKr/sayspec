import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
// Set only for official releases (SAYSPEC_AUTO_UPDATES=1 at build time), so a fork's build never updates itself to them.
declare const __SAYSPEC_AUTO_UPDATES__: boolean;

// Official packaged builds poll the GitHub releases of itsJoKr/sayspec (build.publish in package.json). A downloaded
// update is announced with a system notification and installed the next time the app quits.
export function startUpdateChecks(): void {
  if (!__SAYSPEC_AUTO_UPDATES__ || !app.isPackaged || process.env.SAYSPEC_TEST_MODE === '1' || process.env.SAYSPEC_DISABLE_UPDATES === '1') return;
  autoUpdater.on('error', (error) => console.warn('[updates] check failed:', error.message));
  const check = () => { autoUpdater.checkForUpdatesAndNotify().catch((error: Error) => console.warn('[updates] check failed:', error.message)); };
  check();
  setInterval(check, CHECK_INTERVAL_MS).unref();
}
