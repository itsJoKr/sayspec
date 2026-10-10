import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecordingStore } from '../recording-store.ts';
import { CodingAgentAdapters } from './adapters.ts';
import { ClaudeTerminalManager } from './claude-terminal.ts';
import { ProjectAgentWorkspaceManager } from './project-agent-workspace.ts';
import { SavedWebTestStore } from '../execution/saved-web-tests.ts';

test('embedded Claude uses a true PTY with bidirectional input and an isolated recording directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-claude-pty-'));
  try {
    const executable = path.join(root, 'claude-fixture');
    const sandbox = path.join(root, 'sandbox-fixture');
    await writeFile(sandbox, `#!/bin/sh
test "$1" = "-p" || exit 20
shift 2
exec "$@"
`); await chmod(sandbox, 0o700);
    await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "claude 2.1.269"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":true}'; exit 0; fi
test -f sessions/*/recordings/*/recording.json && test -f sessions/*/SKILL.md && test -f tests/index.json || exit 10
case " $* " in *"--permission-mode auto"*"--tools Read,Write,Edit"*"--allowedTools Read "*) ;; *) echo bad-args; exit 11 ;; esac
grep -q 'An interactive draft' sessions/*/SKILL.md || { echo bad-draft-instruction; exit 13; }
grep -q 'may write and edit draft files' sessions/*/SKILL.md || { echo bad-write-instruction; exit 14; }
if grep -q 'Do not write files' sessions/*/SKILL.md; then echo old-read-only-instruction; exit 15; fi
printf 'size:%s\r\n' "$(stty size)"
printf 'pty-ready\\r\\n'
IFS= read -r line
printf 'received:%s\\r\\n' "$line"
`); await chmod(executable, 0o700);
    const store = new RecordingStore(path.join(root, 'recordings'), { minimumFreeBytes: 0 }); await store.initialize();
    const tests = new SavedWebTestStore(path.join(root, 'saved-tests')); await tests.initialize();
    const prepared = await store.create({ projectId: 'project_web', projectName: 'PTY fixture', startUrl: 'https://example.test/', sharingChoice: 'local-only' });
    await store.beginSegment(prepared.recording.id); await store.stop(prepared.recording.id);
    const output: string[] = []; let exited = false;
    const manager = new ClaudeTerminalManager({ workspaces: new ProjectAgentWorkspaceManager(path.join(root, 'agent-workspaces'), tests), store, adapters: new CodingAgentAdapters({ candidates: { 'claude-code': [executable] } }), sandboxExecutable: sandbox, onEvent: (event) => { if (event.kind === 'data') output.push(event.data ?? ''); if (event.kind === 'exit') exited = true; } });
    await manager.start(prepared.recording.id, 'claude-code', 72, 20);
    for (let i = 0; i < 50 && !output.join('').includes('pty-ready'); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(output.join(''), /pty-ready/);
    assert.match(output.join(''), /size:20 72/);
    manager.write(prepared.recording.id, 'hello from xterm\r');
    for (let i = 0; i < 50 && !exited; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(exited, true); assert.match(output.join(''), /received:hello from xterm/);
    await manager.shutdown();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interactive Codex uses the same durable project root with session-scoped work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-codex-pty-'));
  try {
    const executable = path.join(root, 'codex-fixture');
    const sandbox = path.join(root, 'sandbox-fixture');
    await writeFile(sandbox, `#!/bin/sh\nshift 2\nexec "$@"\n`); await chmod(sandbox, 0o700);
    await writeFile(executable, `#!/bin/sh
args=" $* "
case "$args" in *" -C "*) ;; *) echo missing-cwd:$*; exit 11 ;; esac
case "$args" in *" -s workspace-write "*) ;; *) echo missing-sandbox:$*; exit 11 ;; esac
case "$args" in *" -a never "*) ;; *) echo missing-approval:$*; exit 11 ;; esac
test -f tests/index.json && test -f sessions/*/recordings/*/recording.json || exit 12
printf 'cwd:%s\r\n' "$PWD"
printf 'codex-ready\r\n'
IFS= read -r line
printf 'received:%s\r\n' "$line"
`); await chmod(executable, 0o700);
    const recordings = new RecordingStore(path.join(root, 'recordings'), { minimumFreeBytes: 0 }); await recordings.initialize();
    const firstRecording = await recordings.create({ projectId: 'project_web', projectName: 'Codex fixture', startUrl: 'https://example.test/', sharingChoice: 'local-only' });
    await recordings.beginSegment(firstRecording.recording.id); await recordings.stop(firstRecording.recording.id);
    const saved = new SavedWebTestStore(path.join(root, 'saved-tests')); await saved.initialize();
    const output: string[] = []; let exits = 0;
    const manager = new ClaudeTerminalManager({ workspaces: new ProjectAgentWorkspaceManager(path.join(root, 'agent-workspaces'), saved), store: recordings, adapters: new CodingAgentAdapters({ candidates: { codex: [executable] } }), sandboxExecutable: sandbox, onEvent: (event) => { if (event.kind === 'data') output.push(event.data ?? ''); if (event.kind === 'exit') exits += 1; } });
    await manager.start(firstRecording.recording.id, 'codex', 72, 20);
    for (let i = 0; i < 50 && !output.join('').includes('codex-ready'); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(output.join(''), /codex-ready/);
    manager.write(firstRecording.recording.id, 'done\r');
    for (let i = 0; i < 50 && exits < 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const firstCwd = output.join('').match(/cwd:([^\r\n]+)/)?.[1]; assert.ok(firstCwd);
    const secondRecording = await recordings.create({ projectId: 'project_web', projectName: 'Codex fixture', startUrl: 'https://example.test/', sharingChoice: 'local-only' });
    await recordings.beginSegment(secondRecording.recording.id); await recordings.stop(secondRecording.recording.id);
    output.length = 0;
    await manager.start(secondRecording.recording.id, 'codex', 72, 20);
    for (let i = 0; i < 50 && !output.join('').includes('codex-ready'); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(output.join('').match(/cwd:([^\r\n]+)/)?.[1], firstCwd);
    manager.write(secondRecording.recording.id, 'done\r');
    for (let i = 0; i < 50 && exits < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.shutdown();
  } finally { await rm(root, { recursive: true, force: true }); }
});
