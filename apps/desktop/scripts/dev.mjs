import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import './build-electron.mjs';

const server = await createServer();
try {
  await server.listen();
} catch (error) {
  console.error(`SaySpec development server failed to start: ${error instanceof Error ? error.message : String(error)}`);
  await server.close();
  process.exit(1);
}
const child = spawn(electron, ['.'], {
  stdio: 'inherit', env: { ...process.env, SAYSPEC_DEV: '1' },
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  child.kill();
  await server.close();
  process.exit(code);
}
child.on('exit', (code) => void stop(code ?? 0));
child.on('error', (error) => { console.error(error); void stop(1); });
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
