import { defineConfig } from '@playwright/test'

/** The benchmark suite (docs/PERFORMANCE.md). One worker: benchmarks must not compete with each other. */
export default defineConfig({
  globalSetup: require.resolve('../apps/desktop/e2e/build-fixture'),
  testDir: './specs',
  outputDir: './results/.pw',
  testMatch: /.*\.(bench|soak)\.ts$/,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { trace: 'off', screenshot: 'off' }
})
