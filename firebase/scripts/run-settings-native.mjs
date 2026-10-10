import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';

const candidates = [process.env.JAVA_HOME, '/opt/homebrew/opt/openjdk@21', '/usr/local/opt/openjdk@21'].filter(Boolean);
let javaHome;
for (const candidate of candidates) { try { await access(join(candidate, 'bin', 'java')); javaHome = candidate; break; } catch { /* continue */ } }
if (!javaHome) throw new Error('OpenJDK 21 is required for the Firestore emulator.');
const firebaseBin = new URL('../../node_modules/.bin/firebase', import.meta.url).pathname;
const projectRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const fixtureRoot = await mkdtemp(join(tmpdir(), 'sayspec-settings-agent-'));
const codexFixture = join(fixtureRoot, 'codex');
await writeFile(codexFixture, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.144.6"; exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using settings fixture"; exit 0; fi\nexit 1\n');
await chmod(codexFixture, 0o700);
try {
  const command = `node firebase/scripts/seed-auth.mjs && node firebase/scripts/seed-workspaces.mjs && SAYSPEC_AUTH_SMOKE=1 SAYSPEC_SETTINGS_SMOKE=1 SAYSPEC_TEST_SOURCE_DIRECTORY=${JSON.stringify(projectRoot)} SAYSPEC_CODEX_CLI=${JSON.stringify(codexFixture)} npm run test:native -w @sayspec/desktop`;
  const child = spawn(firebaseBin, ['emulators:exec', '--only', 'auth,firestore,functions', '--project', 'demo-sayspec-local', command], {
    stdio: 'inherit', shell: false, env: { ...process.env, JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')}${delimiter}${process.env.PATH ?? ''}` },
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  process.exitCode = typeof code === 'number' ? code : 1;
} finally { await rm(fixtureRoot, { recursive: true, force: true }); }
