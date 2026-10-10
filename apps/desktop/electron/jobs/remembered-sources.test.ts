import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RememberedSourceStore } from './remembered-sources.ts';

test('a chosen source folder survives restart and is forgotten once it disappears', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-remembered-sources-')); const file = path.join(root, 'remembered-sources.json');
  const source = path.join(root, 'flutter_app'); await mkdir(source);
  try {
    const first = new RememberedSourceStore(file); await first.initialize();
    assert.equal(await first.get('project_a'), undefined);
    await first.remember('project_a', source);

    const second = new RememberedSourceStore(file); await second.initialize();
    assert.equal(await second.get('project_a'), source);
    assert.equal(await second.get('project_b'), undefined);

    await rm(source, { recursive: true });
    assert.equal(await second.get('project_a'), undefined);
    const third = new RememberedSourceStore(file); await third.initialize();
    assert.equal(await third.get('project_a'), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a corrupt remembered-sources file starts empty instead of failing startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-remembered-sources-')); const file = path.join(root, 'remembered-sources.json');
  try {
    await writeFile(file, '{not json');
    const store = new RememberedSourceStore(file); await store.initialize();
    assert.equal(await store.get('project_a'), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
