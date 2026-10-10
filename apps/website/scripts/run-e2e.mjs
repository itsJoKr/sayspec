// Runs the website browser suites against the Firebase Hosting emulator.
//   1. fixtures: `vite build --mode fixtures`, Hosting emulator only (no Firebase data).
//   2. emulator: production-mode build pointed at the local demo project, with the
//      Auth, Firestore, Functions and Hosting emulators and the seeded tenants.
// The production build is restored afterwards so dist/ never keeps a test build.
// Usage: node scripts/run-e2e.mjs [fixtures|emulator]
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = new URL('../../../', import.meta.url).pathname;
const website = new URL('../', import.meta.url).pathname;
const only = process.argv[2];

const candidates = [process.env.JAVA_HOME, '/opt/homebrew/opt/openjdk@21', '/usr/local/opt/openjdk@21'].filter(Boolean);
let javaHome;
for (const candidate of candidates) {
  try { await access(join(candidate, 'bin', 'java')); javaHome = candidate; break; } catch { /* try next */ }
}
if (!javaHome) throw new Error('OpenJDK 21 is required for the Firebase emulators. Set JAVA_HOME or install openjdk@21.');

const firebaseBin = join(root, 'node_modules/.bin/firebase');
const viteBin = join(root, 'node_modules/.bin/vite');
const baseEnv = { ...process.env, JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')}${delimiter}${process.env.PATH ?? ''}` };
for (const key of Object.keys(baseEnv)) if (key.startsWith('VITE_') || key === 'SITE_URL') delete baseEnv[key];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

const emulatorEnv = {
  VITE_FIREBASE_API_KEY: 'demo-api-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'demo-sayspec-local.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'demo-sayspec-local',
  VITE_FIREBASE_APP_ID: '1:1234567890:web:demo',
  VITE_FIREBASE_USE_EMULATORS: 'true',
};

let failed = false;
try {
  if (!only || only === 'fixtures') {
    if (await run(viteBin, ['build', '--mode', 'fixtures'], { cwd: website, env: baseEnv })) throw new Error('Fixture build failed.');
    const code = await run(firebaseBin, ['emulators:exec', '--only', 'hosting', '--project', 'demo-sayspec-local',
      `node_modules/.bin/playwright test --config ${join(website, 'playwright.config.ts')} --project fixtures`], { cwd: root, env: baseEnv });
    failed ||= code !== 0;
  }
  if (!only || only === 'emulator') {
    if (await run('npm', ['run', 'build', '-w', '@sayspec/functions'], { cwd: root, env: baseEnv })) throw new Error('Functions build failed.');
    if (await run(viteBin, ['build'], { cwd: website, env: { ...baseEnv, ...emulatorEnv } })) throw new Error('Emulator build failed.');
    const code = await run(firebaseBin, ['emulators:exec', '--only', 'auth,firestore,functions,hosting', '--project', 'demo-sayspec-local',
      `node firebase/scripts/seed-auth.mjs && node firebase/scripts/seed-workspaces.mjs && node_modules/.bin/playwright test --config ${join(website, 'playwright.config.ts')} --project emulator`], { cwd: root, env: baseEnv });
    failed ||= code !== 0;
  }
} finally {
  // Restore an unconfigured production build (no fixtures, no emulator config).
  await run(viteBin, ['build'], { cwd: website, env: baseEnv });
}
process.exitCode = failed ? 1 : 0;
