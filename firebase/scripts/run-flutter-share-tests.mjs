import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';

const firebaseBin = process.platform === 'win32' ? 'firebase.cmd' : 'firebase';
const javaHome = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
const command = 'node firebase/scripts/seed-auth.mjs && node firebase/scripts/seed-workspaces.mjs && node firebase/scripts/flutter-share-emulator.test.mjs';
const child = spawn(firebaseBin, ['emulators:exec', '--only', 'auth,firestore,functions,storage', '--project', 'demo-sayspec-local', command], { stdio: 'inherit', shell: false, env: { ...process.env, JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')}${delimiter}${process.env.PATH ?? ''}` } });
child.once('exit', (code) => process.exit(code ?? 1));
