#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('claude 2.1.269'); process.exit(0); }
if (args[0] === 'auth') { console.log('{"loggedIn":true}'); process.exit(0); }
console.log(`TERM_SIZE:${process.stdout.rows ?? 0} ${process.stdout.columns ?? 0}`);
const match = args[0]?.match(/^Read (sessions\/[^/]+\/SKILL\.md) for (sessions\/[^/]+\/recordings\/[^.]+)\.$/);
if (!match) {
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(0));
} else {
  const session = match[1].slice(0, -'/SKILL.md'.length);
  const bundle = match[2];
  if (!existsSync(match[1]) || !existsSync('tests/index.json') || args.includes('--safe-mode') || !args.includes('auto')) process.exit(12);
  if (!readFileSync(match[1], 'utf8').includes('Write the test only under')) process.exit(13);
  if (!existsSync(`${bundle}/capture-manifest.json`) || !existsSync(`${bundle}/events.jsonl`) || !existsSync(`${bundle}/evidence`)) process.exit(14);
  const recording = JSON.parse(readFileSync(`${bundle}/recording.json`, 'utf8'));
  const transcript = JSON.parse(readFileSync(`${bundle}/transcript.json`, 'utf8'));
  const source = "import { test, expect } from '@playwright/test';\ntest('recorded page is visible', async ({ page }) => {\n  await page.goto('/');\n  await expect(page.getByRole('heading')).toBeVisible();\n});\n";
  mkdirSync(`${session}/candidate/tests`, { recursive: true });
  writeFileSync(`${session}/candidate/tests/reviewed-monthly.spec.ts`, source);
  console.log(`$ ./${session}/run-playwright.sh candidate/tests/reviewed-monthly.spec.ts`);
  const run = spawnSync(`./${session}/run-playwright.sh`, ['candidate/tests/reviewed-monthly.spec.ts'], { stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
  const output = {
    title: 'Recorded page is visible',
    steps: [{ id: 'step_recorded_page', instruction: 'Open the recorded page.', assertion: 'The page heading is visible.', intentItemIds: [], transcriptSegmentIds: transcript.segments.map((segment) => segment.id), evidenceEventIds: recording.events.map((event) => event.id) }],
    files: [{ relativePath: 'tests/reviewed-monthly.spec.ts', text: source, mimeType: 'text/typescript' }],
    entrypoint: 'tests/reviewed-monthly.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, unresolvedQuestions: [],
  };
  writeFileSync(`${session}/submission.json`, JSON.stringify(output));
  console.log('submission.json written');
  setTimeout(() => process.exit(0), 3_000);
}
