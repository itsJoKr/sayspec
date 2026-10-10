import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectoryHandleRegistry } from './jobs/directory-handles.ts';
import { checkMachineReadiness } from './machine-resources.ts';

test('readiness distinguishes URL-only Web from missing Flutter developer setup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-readiness-'));
  try {
    const directories = new DirectoryHandleRegistry();
    assert.equal((await checkMachineReadiness({ targetType: 'web', task: 'configure' }, directories, root)).ready, true);
    const emptySource = path.join(root, 'flutter'); await mkdir(emptySource); const handle = await directories.register(emptySource);
    const flutter = await checkMachineReadiness({ targetType: 'flutter', task: 'record', sourceHandle: handle }, directories, root);
    assert.equal(flutter.ready, false); assert.ok(flutter.items.some((item) => item.id === 'source' && item.state === 'missing'));
    await writeFile(path.join(emptySource, 'pubspec.yaml'), 'name: fixture');
    const withManifest = await checkMachineReadiness({ targetType: 'flutter', task: 'record', sourceHandle: handle }, directories, root);
    assert.ok(withManifest.items.some((item) => item.id === 'source' && item.state === 'ready'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
