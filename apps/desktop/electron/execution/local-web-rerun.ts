import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApplicationFixProposal, ApplicationFixReceipt } from '@sayspec/contracts';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('A local Web verification port could not be reserved.');
  return port;
}

/** Starts this selected source, then proves the changed public bytes came from that local server. */
export async function startPatchedWebServer(sourcePath: string, proposal: ApplicationFixProposal, receipt: ApplicationFixReceipt) {
  const packageBytes = await readFile(path.join(sourcePath, 'package.json'));
  const packageFile = JSON.parse(packageBytes.toString('utf8')) as { scripts?: Record<string, string> };
  if (typeof packageFile.scripts?.start !== 'string' || !packageFile.scripts.start.trim()) throw new Error('This Web source has no start script. SaySpec cannot prove that a local server runs the patch.');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PORT: String(port), NODE_ENV: 'production' };
  const child = spawn('npm', ['run', 'start'], { cwd: sourcePath, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-8_000); });
  child.stderr.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-8_000); });
  const close = async () => {
    if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited */ } }
    await sleep(500);
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`The local Web server exited before it was ready. ${log.slice(-2_000)}`);
      try { const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) }); if (response.ok) { ready = true; break; } }
      catch { /* server starting */ }
      await sleep(150);
    }
    if (!ready) throw new Error(`The selected Web source did not start on ${baseUrl}. ${log.slice(-2_000)}`);
    const verify = async () => {
      const observed: Record<string, string> = {};
      for (const change of proposal.fileChanges) {
        if (sha(await readFile(path.join(sourcePath, change.relativePath))) !== change.proposedSha256) throw new Error(`${change.relativePath} changed during the patched Web rerun.`);
        const assetUrl = new URL(change.relativePath, baseUrl);
        const response = await fetch(assetUrl, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error(`${change.relativePath} is not served by this local application. The rerun cannot prove the patch is active.`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (sha(bytes) !== change.proposedSha256) throw new Error(`${change.relativePath} served bytes differ from the applied patch. Restart or rebuild the application before rerunning.`);
        observed[change.relativePath] = sha(bytes);
      }
      return observed;
    };
    const observed = await verify();
    const runtimeHash = sha(JSON.stringify({ receiptId: receipt.id, packageHash: sha(packageBytes), observed: Object.entries(observed).sort(([a], [b]) => a.localeCompare(b)) }));
    return { baseUrl, runtimeHash, verify, close };
  } catch (error) { await close(); throw error; }
}
