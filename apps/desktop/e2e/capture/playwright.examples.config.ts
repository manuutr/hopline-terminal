import { defineConfig } from '@playwright/test'

/** npm run docs:examples builds the production app before opening these local SSH sessions. */
export default defineConfig({
  testDir: '.',
  testMatch: /\.example\.ts$/,
  outputDir: './test-results/examples',
  timeout: 150_000,
  expect: { timeout: 15_000 },
  use: { actionTimeout: 12_000 },
  workers: 1,
  retries: 0,
  reporter: 'list'
})
