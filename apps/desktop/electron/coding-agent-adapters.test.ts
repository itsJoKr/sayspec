import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodingAgentAdapters, CodingAgentError } from './coding-agent/adapters.ts';

const schema = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] };

async function executable(root: string, name: string, body: string) {
  const file = path.join(root, name); await writeFile(file, `#!/usr/bin/env node\n${body}\n`); await chmod(file, 0o700); return file;
}

test('typed adapters report version/auth readiness and parse Codex structured output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-agent-adapters-'));
  try {
    const codex = await executable(root, 'codex-fixture', `
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.144.6'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using fixture'); process.exit(0); }
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ ok: true }) } }));`);
    const claude = await executable(root, 'claude-fixture', `
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.269 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: false, authMethod: 'none' })); process.exit(0); }
process.exit(1);`);
    const adapters = new CodingAgentAdapters({ candidates: { codex: [codex], 'claude-code': [claude] } });
    const readiness = await adapters.readiness();
    assert.equal(readiness.providers.find((item) => item.id === 'codex')?.state, 'ready');
    assert.equal(readiness.providers.find((item) => item.id === 'codex')?.qualification, 'tested');
    assert.equal(readiness.providers.find((item) => item.id === 'claude-code')?.state, 'unauthenticated');
    const output = await adapters.invoke({ provider: 'codex', workingDirectory: root, prompt: 'Return structured output.', outputSchema: schema });
    assert.deepEqual(output.output, { ok: true }); assert.equal(output.cliVersion, '0.144.6');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an authenticated untested CLI version is ready with an honest qualification label', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-agent-untested-'));
  try {
    const claude = await executable(root, 'claude-fixture', `
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.280 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
console.log(JSON.stringify({ result: JSON.stringify({ ok: true }), is_error: false }));`);
    const adapters = new CodingAgentAdapters({ candidates: { codex: [], 'claude-code': [claude] } });
    const readiness = await adapters.readiness();
    const provider = readiness.providers.find((item) => item.id === 'claude-code');
    assert.equal(provider?.state, 'ready');
    assert.equal(provider?.qualification, 'untested-version');
    assert.equal(provider?.testedVersion, '2.1.269');
    assert.equal(provider?.isolation.verified, false);
    const result = await adapters.invoke({ provider: 'claude-code', workingDirectory: root, prompt: 'Return structured output.', outputSchema: schema });
    assert.deepEqual(result.output, { ok: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('adapter cancellation terminates the detached CLI process group including a grandchild', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-agent-cancel-'));
  try {
    const codex = await executable(root, 'codex-fixture', `
const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.144.6'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using fixture'); process.exit(0); }
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(path.join(process.cwd(), 'grandchild.pid'), String(child.pid));
setInterval(() => {}, 1000);`);
    const adapters = new CodingAgentAdapters({ candidates: { codex: [codex], 'claude-code': [] } });
    const controller = new AbortController();
    const running = adapters.invoke({ provider: 'codex', workingDirectory: root, prompt: 'Wait.', outputSchema: schema, signal: controller.signal });
    let pid = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { pid = Number(await readFile(path.join(root, 'grandchild.pid'), 'utf8')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.ok(Number.isSafeInteger(pid) && pid > 0); controller.abort();
    await assert.rejects(running, (error: unknown) => error instanceof CodingAgentError && error.code === 'canceled');
    await new Promise((resolve) => setTimeout(resolve, 50)); assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed provider output is never accepted as success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-agent-malformed-'));
  try {
    const codex = await executable(root, 'codex-fixture', `
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.144.6'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using fixture'); process.exit(0); }
console.log('this is not JSONL');`);
    const adapters = new CodingAgentAdapters({ candidates: { codex: [codex], 'claude-code': [] } });
    await assert.rejects(adapters.invoke({ provider: 'codex', workingDirectory: root, prompt: 'Return structured output.', outputSchema: schema }), (error: unknown) => error instanceof CodingAgentError && error.code === 'malformed-output');
  } finally { await rm(root, { recursive: true, force: true }); }
});
