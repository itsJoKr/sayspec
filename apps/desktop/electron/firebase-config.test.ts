import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolveFirebaseSettings } from '../src/cloud/firebase/config.ts';

function envFile(path: string) {
  return Object.fromEntries(readFileSync(new URL(path, import.meta.url), 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
}
const live = { VITE_FIREBASE_API_KEY: 'key', VITE_FIREBASE_AUTH_DOMAIN: 'example.firebaseapp.com', VITE_FIREBASE_PROJECT_ID: 'example', VITE_FIREBASE_APP_ID: '1:1:web:1' };

test('the committed emulator configuration targets only the demo emulator project', () => {
  const settings = resolveFirebaseSettings(envFile('../.env.emulator'));
  assert.equal(settings.emulators, true);
  assert.equal(settings.config.projectId, 'demo-sayspec-local');
  assert.equal(settings.config.storageBucket, 'demo-sayspec-local.appspot.com');
  assert.equal(settings.functionsRegion, 'europe-west1');
});

test('a real project comes only from the build environment', () => {
  const settings = resolveFirebaseSettings({ ...live, VITE_FIREBASE_FUNCTIONS_REGION: 'us-central1' });
  assert.equal(settings.emulators, false);
  assert.equal(settings.config.projectId, 'example');
  assert.equal(settings.functionsRegion, 'us-central1');
  assert.equal('storageBucket' in settings.config, false);
});

test('missing or contradictory configuration fails closed', () => {
  assert.throws(() => resolveFirebaseSettings({}), /needs VITE_FIREBASE_API_KEY/);
  assert.throws(() => resolveFirebaseSettings({ ...live, VITE_FIREBASE_USE_EMULATORS: 'true' }), /only allowed with a demo- project/);
  assert.throws(() => resolveFirebaseSettings({ ...live, VITE_FIREBASE_PROJECT_ID: 'demo-x' }), /work only with the local emulators/);
  assert.throws(() => resolveFirebaseSettings({ ...live, VITE_FIREBASE_FUNCTIONS_REGION: 'nowhere' }), /REGION is invalid/);
});

test('the main process reaches the configured Functions, the emulator, or nothing', async () => {
  const { firebaseFunctionsBaseUrl, accountPortalOrigin } = await import('../scripts/build-env.mjs');
  assert.equal(firebaseFunctionsBaseUrl({}), '');
  assert.equal(accountPortalOrigin({ VITE_SAYSPEC_ACCOUNT_PORTAL_ORIGIN: 'https://portal.example' }), '');
  assert.equal(firebaseFunctionsBaseUrl(envFile('../.env.emulator')), 'http://127.0.0.1:5001/demo-sayspec-local/europe-west1');
  assert.equal(firebaseFunctionsBaseUrl({ VITE_SAYSPEC_CLOUD: 'firebase', VITE_FIREBASE_PROJECT_ID: 'example' }), 'https://europe-west1-example.cloudfunctions.net');
  assert.throws(() => firebaseFunctionsBaseUrl({ VITE_SAYSPEC_CLOUD: 'firebase', VITE_FIREBASE_PROJECT_ID: 'x/../y' }), /invalid/);
});
