import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CodingAgentReadinessReport } from '@sayspec/contracts';
import { CODING_AGENT_INSTALL_URLS, CodingAgentPreferenceManager, CodingAgentPreferenceStore } from './coding-agent/preferences.ts';

const readiness: CodingAgentReadinessReport = {
  checkedAt: new Date(0).toISOString(), disclosure: 'fixture',
  providers: [
    { id: 'claude-code', displayName: 'Claude Code', state: 'missing', detail: 'missing', isolation: { writeAccess: 'none', enforcement: 'claude-restricted-read-tools', verified: true } },
    { id: 'codex', displayName: 'Codex', state: 'unauthenticated', version: '0.144.6', detail: 'sign in', isolation: { writeAccess: 'none', enforcement: 'codex-os-read-only-sandbox', verified: true } },
  ],
};

test('AI choice is saved only when the terminal CLI is installed and survives restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-ai-choice-')); const file = path.join(root, 'preference.json');
  try {
    const opened: string[] = []; const first = new CodingAgentPreferenceStore(file); await first.initialize();
    const manager = new CodingAgentPreferenceManager({ store: first, agents: { async readiness() { return readiness; } }, openExternal: async (url) => { opened.push(url); } });
    const missing = await manager.select('claude-code');
    assert.equal(missing.saved, false); assert.equal(missing.installPageOpened, true);
    assert.equal(missing.installUrl, CODING_AGENT_INSTALL_URLS['claude-code']); assert.deepEqual(opened, [CODING_AGENT_INSTALL_URLS['claude-code']]);
    assert.equal(manager.snapshot().provider, undefined);
    const selected = await manager.select('codex');
    assert.equal(selected.saved, true); assert.equal(selected.preference.provider, 'codex'); assert.equal(selected.readiness.state, 'unauthenticated');
    const restored = new CodingAgentPreferenceStore(file); await restored.initialize();
    assert.equal(restored.snapshot().provider, 'codex');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('corrupt preference is preserved for diagnosis and reset safely', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sayspec-ai-choice-corrupt-')); const file = path.join(root, 'preference.json');
  try {
    await writeFile(file, '{not json'); const store = new CodingAgentPreferenceStore(file); await store.initialize();
    assert.equal(store.snapshot().provider, undefined); assert.match(await readFile(file, 'utf8'), /"schemaVersion": 1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
