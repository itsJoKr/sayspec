import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MachineSetupReport } from '@sayspec/contracts';
import { CodingAgentAdapters } from '../coding-agent/adapters.ts';
import { MachineSetupAgentTerminalManager } from './setup-agent-terminal.ts';

const report: MachineSetupReport = {
  checkedAt: new Date(0).toISOString(), platform: 'darwin', groups: [],
  project: { projectId: 'project_fixture', name: 'Fixture', targetType: 'web' },
  stages: { machineTools: 'ready', projectBuild: 'unknown', device: 'not-required', recordingIntegration: 'not-required' },
};

test('AI setup terminal launches the selected provider in the selected source and streams its PTY', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sayspec-setup-agent-test-'));
  const source = path.join(root, 'source'); const executable = path.join(root, 'fake-codex');
  await mkdir(source);
  await writeFile(executable, '#!/bin/sh\nprintf "FAKE_SETUP_READY:%s\\n" "$PWD"\n/bin/sleep 0.1\n');
  await chmod(executable, 0o700);
  let output = '';
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => { finish = resolve; });
  const manager = new MachineSetupAgentTerminalManager({
    rootDirectory: path.join(root, 'sessions'),
    adapters: new CodingAgentAdapters({ candidates: { codex: [executable] } }),
    onEvent(event) { if (event.kind === 'data') output += event.data ?? ''; if (event.kind === 'exit') finish(); },
  });
  try {
    await manager.start({ projectId: 'project_fixture', targetType: 'web', sourcePath: source, provider: 'codex', report, cols: 80, rows: 24 });
    await Promise.race([exited, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('fake setup terminal did not exit')), 5_000); timer.unref(); })]);
    assert.match(output, /FAKE_SETUP_READY:/);
    assert.match(output, /source/);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('entry points the agent writes are validated, saved, and answered while the terminal runs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sayspec-setup-agent-entry-'));
  const source = path.join(root, 'source'); const executable = path.join(root, 'fake-codex');
  await mkdir(source);
  // The fake agent reads the seeded file, writes an invalid list, reads the rejection, then writes a valid one.
  await writeFile(executable, [
    '#!/bin/sh',
    'cat "$TMPDIR/entry-points.json"',
    'printf \'{"entryPoints":[{"name":"Dev","command":"cd app && flutter run"}]}\' > "$TMPDIR/entry-points.json"',
    'for i in 1 2 3 4 5 6 7 8 9 10; do [ -f "$TMPDIR/entry-points-result.json" ] && break; /bin/sleep 0.2; done',
    'cat "$TMPDIR/entry-points-result.json"',
    'printf \'{"entryPoints":[{"name":"Development","command":"fvm flutter run --flavor dev"},{"name":"Staging","command":"fvm flutter run --flavor staging"}]}\' > "$TMPDIR/entry-points.json"',
    '/bin/sleep 0.1',
  ].join('\n'));
  await chmod(executable, 0o700);
  const saved: unknown[] = []; let output = '';
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => { finish = resolve; });
  const manager = new MachineSetupAgentTerminalManager({
    rootDirectory: path.join(root, 'sessions'),
    adapters: new CodingAgentAdapters({ candidates: { codex: [executable] } }),
    entryPoints: {
      current: (projectId, targetType) => ({ schemaVersion: 1, projectId, targetType, entryPoints: [{ name: 'Existing', command: 'flutter run' }] }),
      async save(projectId, targetType, entryPoints) {
        const { validateEntryPoints } = await import('@sayspec/contracts');
        const value = { schemaVersion: 1 as const, projectId, targetType, entryPoints: validateEntryPoints(targetType, entryPoints) };
        saved.push(value.entryPoints); return value;
      },
    },
    onEvent(event) { if (event.kind === 'data') output += event.data ?? ''; if (event.kind === 'exit') finish(); },
  });
  try {
    await manager.start({ projectId: 'project_fixture', targetType: 'flutter', sourcePath: source, provider: 'codex', report, cols: 120, rows: 24 });
    await Promise.race([exited, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('fake setup terminal did not exit')), 8_000); timer.unref(); })]);
    assert.match(output, /Existing/, 'the agent sees the entry points SaySpec already has');
    assert.match(output, /rejected/);
    assert.match(output, /Shell syntax/);
    assert.deepEqual(saved.at(-1), [{ name: 'Development', command: 'fvm flutter run --flavor dev' }, { name: 'Staging', command: 'fvm flutter run --flavor staging' }]);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('entry-points session starts without a machine report and hands the agent the focused skill', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sayspec-setup-agent-scope-'));
  const source = path.join(root, 'source'); const executable = path.join(root, 'fake-codex');
  await mkdir(source);
  await writeFile(executable, '#!/bin/sh\ncat "$TMPDIR/SKILL.md"\n[ -f "$TMPDIR/machine-check.json" ] && echo HAS_REPORT\n/bin/sleep 0.1\n');
  await chmod(executable, 0o700);
  let output = '';
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => { finish = resolve; });
  const manager = new MachineSetupAgentTerminalManager({
    rootDirectory: path.join(root, 'sessions'),
    adapters: new CodingAgentAdapters({ candidates: { codex: [executable] } }),
    onEvent(event) { if (event.kind === 'data') output += event.data ?? ''; if (event.kind === 'exit') finish(); },
  });
  try {
    await manager.start({ projectId: 'project_fixture', targetType: 'flutter', sourcePath: source, provider: 'codex', scope: 'entry-points', cols: 120, rows: 24 });
    await Promise.race([exited, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('fake entry-points terminal did not exit')), 5_000); timer.unref(); })]);
    assert.match(output, /# SaySpec entry points/);
    assert.doesNotMatch(output, /HAS_REPORT/);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});
