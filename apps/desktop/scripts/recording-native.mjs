import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cloudShare = process.env.SAYSPEC_RECORDING_SHARE_SMOKE === '1';
const generationSmoke = process.env.SAYSPEC_GENERATION_SMOKE === '1';
const transcriptionSmoke = process.env.SAYSPEC_TRANSCRIPTION_SMOKE === '1' || generationSmoke;
const visits = new Map();
const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  const key = requestUrl.search;
  const visit = requestUrl.pathname === '/' ? (visits.get(key) ?? 0) + 1 : 0;
  if (requestUrl.pathname === '/') visits.set(key, visit);
  const phase = requestUrl.searchParams.get('phase') ?? 'capture';
  const firstCapture = phase === 'capture' && visit === 1;
  const secondCapture = phase === 'capture' && visit === 2 && !cloudShare;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><body>
    <h1>${secondCapture ? 'Second test after reset' : 'SaySpec recording fixture'}</h1>
    <label>Email <input id="email" aria-label="Email"></label>
    <label>Password <input id="password" name="password" type="password" aria-label="Password"></label>
    <button id="continue">Continue</button><button id="confirm">Confirm</button>
    <script>
      const recorderButton = () => document.querySelector('[data-sayspec-recorder]')?.shadowRoot?.querySelector('button');
      ${firstCapture ? `document.cookie = 'session=must-clear; path=/'; localStorage.setItem('session', 'must-clear');
      setTimeout(() => recorderButton()?.click(), 600);
      setTimeout(() => { const email = document.querySelector('#email'); email.value = 'native@example.test'; email.dispatchEvent(new Event('change', { bubbles: true })); const password = document.querySelector('#password'); password.value = 'native-secret-must-not-persist'; password.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#continue').click(); }, 1800);
      setTimeout(() => document.querySelector('#confirm').click(), 4800);
      setTimeout(() => document.querySelector('#continue').click(), 6400);
      setTimeout(() => recorderButton()?.click(), 7200);` : ''}
      ${secondCapture ? `const stateWasCleared = !document.cookie && localStorage.getItem('session') === null;
      document.querySelector('h1').textContent = stateWasCleared ? 'Second test · state reset' : 'Second test · state leaked';
      setTimeout(() => recorderButton()?.click(), 600);
      setTimeout(() => document.querySelector('#continue').click(), 1400);
      setTimeout(() => document.querySelector('#confirm').click(), 2100);
      setTimeout(() => recorderButton()?.click(), 2800);` : ''}
      ${phase === 'denied' ? `setTimeout(() => recorderButton()?.click(), 600);` : ''}
    </script>
  </body></html>`);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Recording fixture server did not start.');
const userData = await mkdtemp(path.join(tmpdir(), 'sayspec-recording-native-'));
const deniedUserData = await mkdtemp(path.join(tmpdir(), 'sayspec-recording-denied-'));
const cwd = new URL('..', import.meta.url).pathname;
if (transcriptionSmoke) {
  if (!process.env.SAYSPEC_REAL_WHISPER_MODEL || !process.env.SAYSPEC_REAL_WHISPER_ENGLISH) throw new Error('Native transcription smoke needs model and English audio fixture paths.');
  const modelRoot = path.join(userData, 'transcription-models'); await mkdir(modelRoot, { recursive: true });
  await link(process.env.SAYSPEC_REAL_WHISPER_MODEL, path.join(modelRoot, 'ggml-small-q5_1.bin'));
}
let codexFixture = '';
let claudeFixture = '';
if (generationSmoke) {
  codexFixture = path.join(userData, 'codex-fixture');
  await writeFile(codexFixture, `#!/usr/bin/env node
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.144.6'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using native fixture'); process.exit(0); }
console.log(\`TERM_SIZE:\${process.stdout.rows ?? 0} \${process.stdout.columns ?? 0}\`);
const prompt = args.at(-1) ?? '';
const match = prompt.match(/^Read (sessions\\/[^/]+\\/SKILL\\.md) for (sessions\\/[^/]+\\/recordings\\/[^.]+)\\.$/);
if (!match) { process.stdin.resume(); process.stdin.once('data', () => process.exit(0)); }
else {
  const session = path.dirname(match[1]); const bundle = match[2];
  if (!existsSync(match[1]) || !existsSync('tests/index.json') || !existsSync(\`\${bundle}/recording.json\`)) process.exit(12);
  const recording = JSON.parse(readFileSync(\`\${bundle}/recording.json\`, 'utf8'));
  const transcript = JSON.parse(readFileSync(\`\${bundle}/transcript.json\`, 'utf8'));
  const source = "import { test, expect } from '@playwright/test';\\ntest('recorded page is visible', async ({ page }) => {\\n  await page.goto('/');\\n  await expect(page.getByRole('heading')).toBeVisible();\\n});\\n";
  mkdirSync(\`\${session}/candidate/tests\`, { recursive: true });
  writeFileSync(\`\${session}/candidate/tests/reviewed-monthly.spec.ts\`, source);
  const run = spawnSync(\`./\${session}/run-playwright.sh\`, ['candidate/tests/reviewed-monthly.spec.ts'], { stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
  const output = { title: 'Recorded page is visible', steps: [{ id: 'step_recorded_page', instruction: 'Open the recorded page.', assertion: 'The page heading is visible.', intentItemIds: [], transcriptSegmentIds: transcript.segments.map((item) => item.id), evidenceEventIds: recording.events.map((item) => item.id) }], files: [{ relativePath: 'tests/reviewed-monthly.spec.ts', mimeType: 'text/typescript', text: source }], entrypoint: 'tests/reviewed-monthly.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, unresolvedQuestions: [] };
  writeFileSync(\`\${session}/submission.json\`, JSON.stringify(output));
  console.log('submission.json written'); setTimeout(() => process.exit(0), 3_000);
}
  `); await chmod(codexFixture, 0o700);
  await writeFile(path.join(userData, 'coding-agent-preference.json'), `${JSON.stringify({ schemaVersion: 1, provider: 'codex', updatedAt: new Date().toISOString() }, null, 2)}\n`);
  claudeFixture = path.join(userData, 'claude-fixture');
  await writeFile(claudeFixture, await readFile(new URL('./claude-native-fixture.mjs', import.meta.url))); await chmod(claudeFixture, 0o700);
}

async function run(phase, dataPath = userData) {
  const child = spawn(process.execPath, ['scripts/native-smoke.mjs'], {
    cwd, stdio: 'inherit', env: {
      ...process.env,
      ...(cloudShare ? { SAYSPEC_AUTH_SMOKE: '1', SAYSPEC_RECORDING_SHARE_SMOKE: '1' } : { SAYSPEC_GUEST_SMOKE: '1' }),
      SAYSPEC_RECORDING_SMOKE: '1', SAYSPEC_RECORDING_HEADLESS: '1',
      SAYSPEC_RECORDING_PERSIST_PHASE: phase, SAYSPEC_RECORDING_URL: `http://127.0.0.1:${address.port}/?phase=${phase}`,
      SAYSPEC_TEST_USER_DATA: dataPath,
      ...(transcriptionSmoke ? { SAYSPEC_TRANSCRIPTION_SMOKE: '1', SAYSPEC_TEST_AUDIO_FILE: process.env.SAYSPEC_REAL_WHISPER_ENGLISH } : {}),
      ...(generationSmoke ? { SAYSPEC_GENERATION_SMOKE: '1', SAYSPEC_CODEX_CLI: codexFixture, SAYSPEC_CLAUDE_CLI: claudeFixture } : {}),
      ...(phase === 'denied' ? { SAYSPEC_MICROPHONE_DENIED: '1' } : {}),
    },
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(`Native recording ${phase} phase failed with code ${code}.`);
}

try { await run('capture'); if (!cloudShare) { await run('restore'); await run('denied', deniedUserData); } }
finally { await new Promise((resolve) => server.close(resolve)); await Promise.all([rm(userData, { recursive: true, force: true }), rm(deniedUserData, { recursive: true, force: true })]); }
