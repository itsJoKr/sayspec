// Milestone 12 connected Beta acceptance: account portal (production-mode build on
// the Hosting emulator) + built Electron + Auth/Firestore/Functions/Storage
// emulators. Real identities and operations only; nothing is seeded.
// The website dist/ is restored to the unconfigured production build afterwards.
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = new URL('../../', import.meta.url).pathname;
const candidates = [process.env.JAVA_HOME, '/opt/homebrew/opt/openjdk@21', '/usr/local/opt/openjdk@21'].filter(Boolean);
let javaHome;
for (const candidate of candidates) { try { await access(join(candidate, 'bin', 'java')); javaHome = candidate; break; } catch { /* try another */ } }
if (!javaHome) throw new Error('OpenJDK 21 is required for the Firestore emulator.');
const env = { ...process.env, JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')}${delimiter}${process.env.PATH ?? ''}` };
for (const key of Object.keys(env)) if (key.startsWith('VITE_') || key === 'SITE_URL') delete env[key];
const viteBin = join(root, 'node_modules/.bin/vite');
const website = join(root, 'apps/website');
const portalEnv = { VITE_FIREBASE_API_KEY: 'demo-api-key', VITE_FIREBASE_AUTH_DOMAIN: 'demo-sayspec-local.firebaseapp.com', VITE_FIREBASE_PROJECT_ID: 'demo-sayspec-local', VITE_FIREBASE_APP_ID: '1:1234567890:web:demo', VITE_FIREBASE_USE_EMULATORS: 'true' };
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: 'inherit', shell: false, cwd: root, env, ...options }); child.once('error', reject); child.once('close', (code) => resolve(code ?? 1)); });
}
let code = 1;
try {
  if (process.env.SAYSPEC_SKIP_BUILD !== '1') {
    if (await run('npm', ['run', 'build', '-w', '@sayspec/functions'])) throw new Error('Functions build failed.');
    if (await run('npm', ['run', 'build:emulator'])) throw new Error('Desktop build failed.');
  }
  if (await run(viteBin, ['build'], { cwd: website, env: { ...env, ...portalEnv } })) throw new Error('Portal emulator build failed.');
  code = await run(join(root, 'node_modules/.bin/firebase'), ['emulators:exec', '--only', 'auth,firestore,functions,storage,hosting', '--project', 'demo-sayspec-local', 'node --experimental-strip-types apps/desktop/scripts/connected-beta-native.mjs']);
} finally {
  await run(viteBin, ['build'], { cwd: website });
}
process.exitCode = code;
