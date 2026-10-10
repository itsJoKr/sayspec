export interface FirebaseWebConfig { apiKey: string; authDomain: string; projectId: string; appId: string }

export type FirebaseRuntime =
  | { kind: 'firebase'; config: FirebaseWebConfig; functionsRegion: string; emulators: boolean; appCheckSiteKey: string | null }
  | { kind: 'unconfigured'; missing: string[] }
  | { kind: 'invalid'; reason: string };

type Env = Record<string, string | boolean | undefined>;

const REQUIRED = [
  ['VITE_FIREBASE_API_KEY', 'apiKey'],
  ['VITE_FIREBASE_AUTH_DOMAIN', 'authDomain'],
  ['VITE_FIREBASE_PROJECT_ID', 'projectId'],
  ['VITE_FIREBASE_APP_ID', 'appId'],
] as const;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Resolves the portal's Firebase connection from build-time environment only.
 * - Missing values: honest "setup unavailable" state (never a silent fallback).
 * - Emulators: explicit opt-in, `demo-` project IDs only, and only when the page
 *   itself is served from loopback, so a deployed build can never reach them.
 * - A `demo-` project without emulators is refused: it cannot exist in production.
 */
export function resolveFirebaseRuntime(env: Env, hostname: string): FirebaseRuntime {
  const text = (key: string) => (typeof env[key] === 'string' ? (env[key] as string).trim() : '');
  const missing = REQUIRED.filter(([key]) => !text(key)).map(([key]) => key);
  if (missing.length) return { kind: 'unconfigured', missing };
  const config = Object.fromEntries(REQUIRED.map(([key, field]) => [field, text(key)])) as unknown as FirebaseWebConfig;
  const emulators = text('VITE_FIREBASE_USE_EMULATORS') === 'true';
  const demoProject = config.projectId.startsWith('demo-');
  if (emulators && !demoProject) return { kind: 'invalid', reason: 'Emulator mode is only allowed with a demo- project ID.' };
  if (!emulators && demoProject) return { kind: 'invalid', reason: 'Demo project IDs work only with the local Firebase emulators.' };
  if (emulators && !LOOPBACK.has(hostname)) return { kind: 'invalid', reason: 'This build targets local emulators and cannot run on a public host.' };
  const functionsRegion = text('VITE_FIREBASE_FUNCTIONS_REGION') || 'europe-west1';
  if (!/^[a-z]+-[a-z]+\d$/.test(functionsRegion)) return { kind: 'invalid', reason: 'VITE_FIREBASE_FUNCTIONS_REGION is invalid.' };
  // App Check (reCAPTCHA Enterprise) for the portal's team callables. Never
  // used against emulators; production enforcement is a server-side deploy
  // decision (PORTAL_APP_CHECK_ENFORCE) that requires this key to be set.
  const appCheckSiteKey = emulators ? null : text('VITE_FIREBASE_APPCHECK_SITE_KEY') || null;
  return { kind: 'firebase', config, functionsRegion, emulators, appCheckSiteKey };
}
