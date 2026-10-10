import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startPatchedWebServer } from './local-web-rerun.ts';

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
test('patched Web server proves served bytes before identifying runtime', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-patched-web-'));
  const fixture = new URL('../../../../fixtures/web_sample_app', import.meta.url).pathname;
  let close: (() => Promise<void>) | undefined;
  try {
    await cp(fixture, root, { recursive: true, filter: (file) => !path.basename(file).startsWith('.') });
    const file = path.join(root, 'app.js');
    const base = await readFile(file, 'utf8');
    const patched = base.replace('correctSubtotal - 500', 'correctSubtotal');
    assert.notEqual(base, patched);
    await writeFile(file, patched);
    const proposal = { fileChanges: [{ relativePath: 'app.js', proposedSha256: sha(patched) }] } as Parameters<typeof startPatchedWebServer>[1];
    const receipt = { id: 'receipt_fixture' } as Parameters<typeof startPatchedWebServer>[2];
    const server = await startPatchedWebServer(root, proposal, receipt); close = server.close;
    assert.match(server.runtimeHash, /^[a-f0-9]{64}$/);
    assert.equal(sha(Buffer.from(await (await fetch(new URL('app.js', server.baseUrl))).arrayBuffer())), sha(patched));
    await writeFile(file, base);
    await assert.rejects(server.verify(), /changed during/);
    await assert.rejects(startPatchedWebServer(root, proposal, receipt), /changed during/);
  } finally { await close?.(); await rm(root, { recursive: true, force: true }); }
});
