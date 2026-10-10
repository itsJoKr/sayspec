import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import type { PlaywrightDraftFile } from '@sayspec/contracts';
import { validatePlaywrightCandidate } from './playwright-validation.ts';

const testSource = `import { test, expect } from '@playwright/test';
test('narrated scroll reaches the target section', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /see how it works/i }).click();
  await expect(page.locator('#how-it-works')).toBeInViewport();
});`;

function sourceFile(text: string): PlaywrightDraftFile {
  const bytes = Buffer.from(text);
  return { id: 'file_1', relativePath: 'tests/generated.spec.ts', text, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'text/typescript' };
}

test('sandboxed Playwright runner distinguishes green, assertion failure and source escape', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<a href="#how-it-works">See how it works</a><section id="how-it-works" style="margin-top:1200px">How it works</section>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server address.');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const passed = await validatePlaywrightCandidate({ files: [sourceFile(testSource)], entrypoint: 'tests/generated.spec.ts', baseUrl });
    assert.equal(passed.status, 'passed', JSON.stringify(passed));
    const failed = await validatePlaywrightCandidate({ files: [sourceFile(testSource.replace("page.locator('#how-it-works')", "page.locator('#does-not-exist')"))], entrypoint: 'tests/generated.spec.ts', baseUrl });
    assert.equal(failed.status, 'failed', JSON.stringify(failed));
    const sourcePath = path.resolve('package.json');
    const outside = `/private/tmp/sayspec-scope-probe-${randomUUID()}`;
    const escape = await validatePlaywrightCandidate({ files: [sourceFile(`import { test, expect } from '@playwright/test'; import { readFileSync, writeFileSync } from 'node:fs'; test('source isolation', async () => { expect(() => readFileSync(${JSON.stringify(sourcePath)})).toThrow(); expect(() => writeFileSync(${JSON.stringify(outside)}, 'escaped')).toThrow(); });`)], entrypoint: 'tests/generated.spec.ts', baseUrl });
    assert.equal(escape.status, 'passed', JSON.stringify(escape));
    await rm(outside, { force: true });
  } finally { server.close(); }
});

test('cancellation stops a running Playwright validation without reporting green', async () => {
  const controller = new AbortController();
  const pending = validatePlaywrightCandidate({
    files: [sourceFile("import { test, expect } from '@playwright/test'; test('wait', async ({ page }) => { await page.waitForTimeout(60000); expect(true).toBe(true); });")],
    entrypoint: 'tests/generated.spec.ts', baseUrl: 'http://127.0.0.1:1/', signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 1_000);
  const result = await pending;
  assert.equal(result.status, 'canceled', JSON.stringify(result));
  assert.equal(result.passed, 0);
});
