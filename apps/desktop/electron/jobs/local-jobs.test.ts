import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectoryHandleRegistry, LocalBoundaryError } from './directory-handles.ts';
import { LocalJobManager, type LocalJobJournal } from './local-job-manager.ts';

const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const roots: string[] = [];
async function temporaryRoot(label: string) { const value = await mkdtemp(path.join(tmpdir(), `sayspec-${label}-`)); roots.push(value); return value; }
test.after(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

test('selected directory handles reject traversal, symlink escape, stale handles, and oversized inputs', async () => {
  const root = await temporaryRoot('handles');
  const outside = await temporaryRoot('outside');
  await writeFile(path.join(root, 'small.txt'), 'safe');
  await writeFile(path.join(root, 'large.txt'), '123456');
  await symlink(outside, path.join(root, 'escape'));
  const registry = new DirectoryHandleRegistry();
  const handle = await registry.register(root);
  assert.equal(await registry.resolve(handle, 'small.txt', { maxBytes: 4 }), await realpath(path.join(root, 'small.txt')));
  await assert.rejects(registry.resolve(handle, '../outside.txt'), (error: unknown) => error instanceof LocalBoundaryError && error.code === 'invalid-path');
  await assert.rejects(registry.resolve(handle, 'escape/file.txt', { mustExist: false }), (error: unknown) => error instanceof LocalBoundaryError && error.code === 'symlink-escape');
  await assert.rejects(registry.resolve(handle, 'large.txt', { maxBytes: 4 }), (error: unknown) => error instanceof LocalBoundaryError && error.code === 'oversized-input');
  registry.revoke(handle);
  await assert.rejects(registry.resolve(handle, 'small.txt'), (error: unknown) => error instanceof LocalBoundaryError && error.code === 'stale-handle');
});

test('jobs are journaled, logs are bounded/redacted, and idempotency reuses the result', async () => {
  const root = await temporaryRoot('success');
  const manager = new LocalJobManager({ rootDirectory: root, maxLogBytes: 96, minimumFreeBytes: 0 });
  await manager.initialize();
  const input = {
    organizationId: 'org_acme', projectId: 'project_store', jobType: 'fixture',
    idempotencyKey: 'fixture-success', inputHash: hash, lockKey: 'workspace-one', inputBytes: 8,
    executable: process.execPath, args: ['-e', `console.log('token=secret-value ${root} ' + 'x'.repeat(300))`],
  };
  const started = await manager.startProcess(input);
  const finished = await manager.wait(started.jobId);
  assert.equal(finished.state, 'succeeded');
  assert.equal(finished.logTruncated, true);
  const log = await readFile(path.join(finished.stagingDirectory, 'job.log'), 'utf8');
  assert.doesNotMatch(log, /secret-value/);
  assert.doesNotMatch(log, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(log, /<redacted>/);
  assert.equal((await manager.startProcess(input)).jobId, finished.jobId);
  await assert.rejects(manager.startProcess({ ...input, inputHash: 'b'.repeat(64) }), /different input/);
});

test('process crashes fail, locks reject overlap, cancellation terminates, and shutdown waits', async () => {
  const root = await temporaryRoot('lifecycle');
  const manager = new LocalJobManager({ rootDirectory: root, minimumFreeBytes: 0 });
  await manager.initialize();
  const failed = await manager.startProcess({
    organizationId: 'org_acme', projectId: 'project_store', jobType: 'fixture', idempotencyKey: 'fixture-crash',
    inputHash: hash, lockKey: 'workspace-crash', inputBytes: 0, executable: process.execPath, args: ['-e', 'process.exit(7)'],
  });
  assert.equal((await manager.wait(failed.jobId)).terminal?.code, 'process-crash');

  const long = await manager.startProcess({
    organizationId: 'org_acme', projectId: 'project_store', jobType: 'fixture', idempotencyKey: 'fixture-long',
    inputHash: hash, lockKey: 'device-android-1', inputBytes: 0, executable: process.execPath,
    args: ['-e', "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('grandchild='+child.pid);setInterval(()=>{},1000)"],
  });
  await manager.reportProgress(long.jobId, { sequence: 1, at: '2026-09-20T10:00:00.000Z', phase: 'fixture', message: 'Waiting for cancellation' });
  await assert.rejects(manager.reportProgress(long.jobId, { sequence: 1, at: '2026-09-20T10:00:01.000Z', phase: 'fixture', message: 'Duplicate sequence' }), /must increase/);
  await assert.rejects(manager.startProcess({
    organizationId: 'org_acme', projectId: 'project_store', jobType: 'fixture', idempotencyKey: 'fixture-overlap',
    inputHash: hash, lockKey: 'device-android-1', inputBytes: 0, executable: process.execPath, args: ['-e', 'process.exit(0)'],
  }), /Resource is busy/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await manager.cancel(long.jobId);
  const canceled = await manager.wait(long.jobId);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.progress[0].message, 'Waiting for cancellation');
  const canceledLog = await readFile(path.join(canceled.stagingDirectory, 'job.log'), 'utf8');
  const grandchildPid = Number(canceledLog.match(/grandchild=(\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(grandchildPid), canceledLog);
  assert.throws(() => process.kill(grandchildPid, 0), /ESRCH/);

  const shutdownJob = await manager.startProcess({
    organizationId: 'org_acme', projectId: 'project_store', jobType: 'fixture', idempotencyKey: 'fixture-shutdown',
    inputHash: hash, lockKey: 'workspace-shutdown', inputBytes: 0, executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
  });
  await manager.shutdown();
  assert.equal((await manager.readJournal(shutdownJob.jobId)).state, 'canceled');
});

test('startup marks abandoned work interrupted and never replays it', async () => {
  const root = await temporaryRoot('recovery');
  await mkdir(path.join(root, 'journals'), { recursive: true });
  const journal: LocalJobJournal = {
    schemaVersion: '1.0.0', jobId: 'job_abandoned', organizationId: 'org_acme', projectId: 'project_store',
    jobType: 'fixture', idempotencyKey: 'fixture-abandoned', inputHash: hash, lockKey: 'workspace-one',
    stagingDirectory: path.join(root, 'jobs', 'job_abandoned'), state: 'running', createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z', pid: 999999, logBytes: 0, logTruncated: false, progress: [],
  };
  await writeFile(path.join(root, 'journals', 'job_abandoned.json'), JSON.stringify(journal));
  const manager = new LocalJobManager({ rootDirectory: root, minimumFreeBytes: 0 });
  await manager.initialize();
  const recovered = await manager.readJournal('job_abandoned');
  assert.equal(recovered.state, 'interrupted');
  assert.equal(recovered.pid, undefined);
  assert.equal(recovered.terminal?.code, 'process-crash');
});

test('disk and input budgets fail before a process starts', async () => {
  const root = await temporaryRoot('budgets');
  const manager = new LocalJobManager({ rootDirectory: root, maxInputBytes: 10, minimumFreeBytes: 100, freeBytes: async () => 50 });
  await manager.initialize();
  const base = { organizationId: 'org_acme', projectId: 'project_store', jobType: 'fixture', idempotencyKey: 'fixture-budget', inputHash: hash, lockKey: 'workspace-one', executable: process.execPath, args: ['-e', 'process.exit(0)'] };
  await assert.rejects(manager.startProcess({ ...base, inputBytes: 11 }), /Input exceeds/);
  await assert.rejects(manager.startProcess({ ...base, inputBytes: 1 }), /Insufficient free disk/);
});
