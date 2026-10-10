import type { FirebaseOptions } from 'firebase/app';

export type FirebaseSettings = { config: FirebaseOptions; functionsRegion: string; emulators: boolean };
type Env = Record<string, unknown>;

const REQUIRED = [
  ['VITE_FIREBASE_API_KEY', 'apiKey'],
  ['VITE_FIREBASE_AUTH_DOMAIN', 'authDomain'],
  ['VITE_FIREBASE_PROJECT_ID', 'projectId'],
  ['VITE_FIREBASE_APP_ID', 'appId'],
] as const;
const OPTIONAL = [
  ['VITE_FIREBASE_STORAGE_BUCKET', 'storageBucket'],
  ['VITE_FIREBASE_MESSAGING_SENDER_ID', 'messagingSenderId'],
  ['VITE_FIREBASE_MEASUREMENT_ID', 'measurementId'],
] as const;

/**
 * Resolves the Firebase project from build-time environment only; nothing is
 * built in. Firebase Web configuration is public application identity, not a
 * secret: Auth, Firestore/Storage Rules and Functions enforce authorization.
 * Emulators are an explicit opt-in that only accepts `demo-` projects, so an
 * emulator build can never reach a real project, and a real build never
 * reaches the loopback emulators.
 */
export function resolveFirebaseSettings(env: Env): FirebaseSettings {
  const text = (key: string) => (typeof env[key] === 'string' ? (env[key] as string).trim() : '');
  const missing = REQUIRED.filter(([key]) => !text(key)).map(([key]) => key);
  if (missing.length) throw new Error(`The Firebase cloud backend needs ${missing.join(', ')}. See apps/desktop/.env.example.`);
  const config: FirebaseOptions = Object.fromEntries([...REQUIRED, ...OPTIONAL].filter(([key]) => text(key)).map(([key, field]) => [field, text(key)]));
  const emulators = text('VITE_FIREBASE_USE_EMULATORS') === 'true';
  const demoProject = String(config.projectId).startsWith('demo-');
  if (emulators && !demoProject) throw new Error('Firebase emulator mode is only allowed with a demo- project ID.');
  if (!emulators && demoProject) throw new Error('Demo Firebase project IDs work only with the local emulators (VITE_FIREBASE_USE_EMULATORS=true).');
  const functionsRegion = text('VITE_FIREBASE_FUNCTIONS_REGION') || 'europe-west1';
  if (!/^[a-z]+-[a-z]+\d$/.test(functionsRegion)) throw new Error('VITE_FIREBASE_FUNCTIONS_REGION is invalid.');
  return { config, functionsRegion, emulators };
}
