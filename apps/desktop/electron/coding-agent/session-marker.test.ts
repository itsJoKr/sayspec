import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readSessionMarker, writeSessionMarker } from './session-marker.ts';

test('session markers never follow links planted by a coding-agent session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-marker-'));
  try {
    const session = path.join(root, 'session'); const checkout = path.join(root, 'checkout');
    await mkdir(session); await mkdir(checkout);
    await writeFile(path.join(checkout, 'main.dart'), 'void main() {}\n');
    await symlink(path.join(checkout, 'main.dart'), path.join(session, 'proposal-result.json'));
    await writeSessionMarker(session, 'proposal-result.json', '{"status":"rejected"}');
    assert.equal(await readFile(path.join(checkout, 'main.dart'), 'utf8'), 'void main() {}\n');
    assert.ok((await lstat(path.join(session, 'proposal-result.json'))).isFile());
    assert.equal(await readFile(path.join(session, 'proposal-result.json'), 'utf8'), '{"status":"rejected"}');
    await symlink(path.join(checkout, 'main.dart'), path.join(session, 'proposal.json'));
    await assert.rejects(readSessionMarker(session, 'proposal.json', 1024), /regular file/);
    assert.equal(await readSessionMarker(session, 'absent.json', 1024), undefined);
    await writeFile(path.join(session, 'submission.json'), 'x'.repeat(2048));
    await assert.rejects(readSessionMarker(session, 'submission.json', 1024), /exceeds/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
