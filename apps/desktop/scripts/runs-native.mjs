import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import electronBinary from 'electron';

/** Local-only builds open the local workspace directly; builds with a cloud backend first offer "Continue as guest". */
async function enterLocalWorkspace(page) {
  const guest = page.getByTestId('continue-guest');
  await guest.or(page.getByTestId('local-project-gate')).or(page.locator('nav')).first().waitFor();
  if (await guest.isVisible()) await guest.click();
}

const sha = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const cwd = new URL('..', import.meta.url).pathname;
const profile = await mkdtemp(path.join(tmpdir(), 'sayspec-runs-native-'));
let heading = 'Ready';
const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(`<h1>${heading}</h1>`); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
function bundle(title, wanted) {
  const text = `import { test, expect } from '@playwright/test'; test(${JSON.stringify(title)}, async ({ page }) => { await page.goto('/'); await expect(page.getByRole('heading', { name: ${JSON.stringify(wanted)} })).toBeVisible(); });`;
  const steps = [{ id: 'step_one', instruction: 'Open the page', assertion: `${wanted} heading is visible`, intentItemIds: [], transcriptSegmentIds: [], evidenceEventIds: [] }];
  const files = [{ id: 'file_one', relativePath: 'tests/heading.spec.ts', text, sha256: sha(text), byteLength: Buffer.byteLength(text), mimeType: 'text/typescript' }];
  const runtime = { framework: 'playwright', frameworkVersion: '1.63.0', entrypoint: 'tests/heading.spec.ts', dependencies: { '@playwright/test': '1.63.0' }, requirements: ['Node.js >=22.12.0', 'Playwright Chromium installed'] };
  return { schemaVersion: 1, kind: 'sayspec-playwright-bundle', exportedAt: new Date().toISOString(), original: { testId: 'source_test', versionId: 'source_version', contentHash: sha(canonical({ steps, files, runtime })), state: 'execution-validated' }, title, steps, files, runtime, secretPlaceholders: ['BASE_URL'], provenance: { provider: 'codex', cliVersion: '0.144.6', inputRevisionHash: 'a'.repeat(64), generatedAt: new Date().toISOString() } };
}
async function launch() {
  const app = await electron.launch({ executablePath: electronBinary, args: ['.'], cwd, env: { ...process.env, SAYSPEC_TEST_MODE: '1', SAYSPEC_TEST_USER_DATA: profile }, timeout: 30_000 });
  return { app, page: await app.firstWindow() };
}
try {
  let { app, page } = await launch();
  await enterLocalWorkspace(page);
  await page.locator('#field-project-name').fill('Run review');
  await page.locator('#field-base-url').fill(`http://127.0.0.1:${address.port}/`);
  await page.getByTestId('local-project-create').click();
  await page.getByTestId('onboarding-finish').click();
  await page.locator('nav button', { hasText: 'Runs' }).click();
  for (const [title, expected] of [['Green heading', 'Ready'], ['Red heading', 'Not ready']]) {
    await page.locator('.saved-runs input[type=file]').setInputFiles({ name: `${title}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle(title, expected))) });
    await page.getByRole('button', { name: 'Import as new test' }).click();
    await page.getByText('Imported as a new generated test.').waitFor({ state: 'visible' });
  }
  await page.locator('nav button', { hasText: 'Tests' }).click();
  await page.getByRole('button', { name: 'New suite' }).click();
  await page.getByRole('dialog').getByLabel('Suite name').fill('Heading suite');
  await page.getByRole('dialog').getByRole('button', { name: 'Create suite' }).click();
  for (const title of ['Green heading', 'Red heading']) {
    const row = page.locator('tr').filter({ hasText: title });
    await row.getByRole('button', { name: `Options for ${title}` }).click();
    await page.getByRole('menuitem', { name: 'Move to suite…' }).click();
    await page.getByRole('dialog').getByLabel('Suite').selectOption({ label: 'Heading suite' });
    await page.getByRole('dialog').getByRole('button', { name: 'Move test' }).click();
  }
  await page.locator('.suite-section h2').filter({ hasText: 'Heading suite' }).waitFor({ state: 'attached' });
  await page.locator('nav button', { hasText: 'Runs' }).click();
  await page.getByLabel('Run name').fill('Mixed browser review');
  await page.locator('.multi-run-setup select').selectOption({ label: 'Heading suite (2)' });
  await page.getByRole('button', { name: 'Create named run' }).click();
  await page.locator('.multi-run-result').getByText('1 passed · 1 failed', { exact: false }).waitFor({ timeout: 60_000 });
  const before = await page.evaluate(async () => { const ws = await window.sayspec.getLocalWorkspace(); const projectId = ws.projects[0].id; const runs = await window.sayspec.listSavedWebRuns({ organizationId: 'local', projectId }); const run = runs[0]; const attempts = (await Promise.all(run.items.map((item) => window.sayspec.listSavedWebTestAttempts({ organizationId: 'local', projectId, testId: item.testId })))).flat(); return { projectId, run, attempts }; });
  assert.equal(before.run.items.length, 2);
  const failed = before.attempts.find((item) => item.state === 'failed'); assert.ok(failed);
  const trace = failed.artifacts.find((item) => item.relativePath.endsWith('.zip')); assert.ok(trace);
  const artifact = await page.evaluate(async ({ projectId, failed, trace }) => window.sayspec.readSavedWebTestArtifact({ organizationId: 'local', projectId, testId: failed.testId, attemptId: failed.id, relativePath: trace.relativePath }), { projectId: before.projectId, failed, trace });
  assert.equal(artifact.bytes.length, trace.byteLength);
  const suite = (await page.evaluate(() => window.sayspec.getLocalWorkspace())).suites[0];
  await page.evaluate(async ({ projectId, suite }) => window.sayspec.saveLocalSuite({ projectId, suiteId: suite.id, expectedRevision: suite.revision, name: 'Changed later', testIds: [suite.testIds[0]] }), { projectId: before.projectId, suite });
  const frozen = (await page.evaluate(async (projectId) => window.sayspec.listSavedWebRuns({ organizationId: 'local', projectId }), before.projectId))[0];
  assert.deepEqual(frozen.items.map((item) => item.contentHash), before.run.items.map((item) => item.contentHash));
  heading = 'Not ready';
  await page.locator('.multi-run-item').filter({ hasText: 'Red heading' }).getByRole('button', { name: 'Retry' }).click();
  await page.waitForFunction(async ({ projectId, testId }) => {
    const attempts = await window.sayspec.listSavedWebTestAttempts({ organizationId: 'local', projectId, testId });
    return attempts.length === 2 && attempts[1].state === 'passed';
  }, { projectId: before.projectId, testId: failed.testId }, { timeout: 60_000 });
  await page.getByText('Retry passed; the earlier attempts and artifacts remain intact.').waitFor({ timeout: 20_000 });
  await app.close();
  ({ app, page } = await launch());
  await enterLocalWorkspace(page);
  await page.locator('nav button', { hasText: 'Runs' }).click();
  await page.locator('.multi-run-result').getByText('Mixed browser review', { exact: false }).first().waitFor();
  const reopened = await page.evaluate(async (projectId) => { const runs = await window.sayspec.listSavedWebRuns({ organizationId: 'local', projectId }); const item = runs[0].items.find((item) => item.title === 'Red heading'); return { run: runs[0], attempts: await window.sayspec.listSavedWebTestAttempts({ organizationId: 'local', projectId, testId: item.testId }) }; }, before.projectId);
  assert.deepEqual(reopened.attempts.map((item) => item.state), ['failed', 'passed']);
  assert.equal(reopened.run.items.length, 2);
  const choice = await page.evaluate(() => window.sayspec.selectCodingAgentProvider({ provider: 'codex' }));
  assert.equal(choice.saved, true);
  await page.locator('nav button', { hasText: 'Tests' }).click();
  await page.locator('nav button', { hasText: 'Runs' }).click();
  const failedDetail = page.locator('.multi-run-item').filter({ hasText: 'Red heading' }).locator('details').first();
  await failedDetail.locator(':scope > summary').click();
  await failedDetail.getByRole('button', { name: 'Explain failure' }).click();
  await failedDetail.locator('.failure-analysis').first().waitFor({ timeout: 120_000 });
  const analysis = await page.evaluate(async ({ projectId, testId, attemptId }) => (await window.sayspec.listFailureAnalyses({ organizationId: 'local', projectId, testId, attemptId }))[0], { projectId: before.projectId, testId: failed.testId, attemptId: failed.id });
  assert.equal(analysis.attemptId, failed.id); assert.equal(analysis.provider, 'codex');
  assert.ok(analysis.evidenceIds.every((id) => analysis.evidence.some((entry) => entry.id === id)));
  await app.close();
  ({ app, page } = await launch());
  await enterLocalWorkspace(page);
  await page.locator('nav button', { hasText: 'Runs' }).click();
  await page.locator('.multi-run-item').filter({ hasText: 'Red heading' }).locator('details').first().locator(':scope > summary').click();
  await page.locator('.failure-analysis').first().waitFor({ timeout: 20_000 });
  const finalState = await page.evaluate(async ({ projectId, testId, attemptId }) => ({ attempts: await window.sayspec.listSavedWebTestAttempts({ organizationId: 'local', projectId, testId }), analyses: await window.sayspec.listFailureAnalyses({ organizationId: 'local', projectId, testId, attemptId }) }), { projectId: before.projectId, testId: failed.testId, attemptId: failed.id });
  assert.deepEqual(finalState.attempts.map((item) => item.state), ['failed', 'passed']);
  assert.equal(finalState.analyses[0].inputHash, analysis.inputHash);
  console.log(`RUNS_NATIVE_RESULT=${JSON.stringify({ mixed: true, artifactBytes: artifact.bytes.length, frozen: true, retryStates: reopened.attempts.map((item) => item.state), reopened: true, analysisStatus: analysis.status, evidenceIds: analysis.evidenceIds, provider: analysis.provider, explanationReopened: true })}`);
  await app.close();
} finally { server.close(); await rm(profile, { recursive: true, force: true }); }
