import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectEntryPointStore } from './entry-points.ts';

test('entry points are validated, ordered, and survive restart per project and technology', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-entry-points-')); const file = path.join(root, 'project-entry-points.json');
  try {
    const first = new ProjectEntryPointStore(file); await first.initialize();
    assert.deepEqual(first.get('project_a', 'flutter').entryPoints, []);
    await assert.rejects(first.save({ projectId: 'project_a', targetType: 'flutter', entryPoints: [{ name: 'Dev', command: 'flutter run && rm -rf /' }], updatedBy: 'agent' }), /Shell syntax/);
    await first.save({ projectId: 'project_a', targetType: 'flutter', entryPoints: [{ name: 'Dev', command: 'fvm flutter run --flavor dev' }, { name: 'Staging', command: 'fvm flutter run --flavor staging' }], updatedBy: 'agent' });

    const second = new ProjectEntryPointStore(file); await second.initialize();
    const stored = second.get('project_a', 'flutter');
    assert.deepEqual(stored.entryPoints.map((item) => item.name), ['Dev', 'Staging']);
    assert.equal(stored.updatedBy, 'agent');
    assert.deepEqual(second.get('project_a', 'web').entryPoints, [], 'a technology change does not reuse commands for the other lane');
    assert.deepEqual(second.get('project_b', 'flutter').entryPoints, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
