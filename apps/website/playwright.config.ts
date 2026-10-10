import { defineConfig, devices } from '@playwright/test';

// Browser tests run against the Firebase Hosting emulator (port 5002 in
// /firebase.json), never the Vite dev server, so Hosting rewrites are tested.
// Start them through `npm run test:e2e -w @sayspec/website` (scripts/run-e2e.mjs).
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: '../../tmp/website-e2e-results',
  // Uses the locally installed Google Chrome so no Playwright browser download is needed.
  use: { baseURL: 'http://127.0.0.1:5002', ...devices['Desktop Chrome'], channel: 'chrome', trace: 'retain-on-failure' },
  projects: [
    { name: 'fixtures', testMatch: /fixtures\.spec\.ts/ },
    { name: 'emulator', testMatch: /emulator\.spec\.ts/ },
  ],
});
