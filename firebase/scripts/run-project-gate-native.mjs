import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';

const candidates = [process.env.JAVA_HOME, '/opt/homebrew/opt/openjdk@21', '/usr/local/opt/openjdk@21'].filter(Boolean);
let javaHome;
for (const candidate of candidates) { try { await access(join(candidate, 'bin', 'java')); javaHome = candidate; break; } catch { /* continue */ } }
if (!javaHome) throw new Error('OpenJDK 21 is required.');
const firebaseBin = new URL('../../node_modules/.bin/firebase', import.meta.url).pathname;
const flutterFixture = new URL('../../fixtures/flutter_sample_app', import.meta.url).pathname.replace(/\/$/, '');
const command = `node firebase/scripts/seed-auth.mjs && node firebase/scripts/seed-workspaces.mjs && node firebase/scripts/prepare-project-gate.mjs && SAYSPEC_AUTH_SMOKE=1 SAYSPEC_PROJECT_GATE_SMOKE=1 SAYSPEC_TEST_SOURCE_DIRECTORY=${JSON.stringify(flutterFixture)} npm run test:native -w @sayspec/desktop`;
const child = spawn(firebaseBin, ['emulators:exec', '--only', 'auth,firestore,functions', '--project', 'demo-sayspec-local', command], { stdio: 'inherit', shell: false, env: { ...process.env, JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')}${delimiter}${process.env.PATH ?? ''}` } });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
process.exitCode = typeof code === 'number' ? code : 1;
