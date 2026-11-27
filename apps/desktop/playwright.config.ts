import { defineConfig } from '@playwright/test'

const ci = !!process.env['CI']

export default defineConfig({
  globalSetup: require.resolve('./e2e/build-fixture'),
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // Locally a failure is a failure: no retry hides a flake. CI allows one retry, and every test
  // that needed it is reported as flaky (the list summary; flaky-reporter: a warning annotation,
  // the job summary and test-results/flaky.json). A flaky test is a bug to fix, not a pass.
  retries: ci ? 1 : 0,
  reporter: ci ? [['github'], ['list'], ['html', { open: 'never' }], ['./e2e/support/flaky-reporter.ts']] : 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }
})
