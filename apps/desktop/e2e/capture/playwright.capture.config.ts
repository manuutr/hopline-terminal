import { defineConfig } from '@playwright/test'

/**
 * Design-audit screenshot capture (throwaway). Not part of the e2e suite.
 *   cd apps/desktop && npx electron-vite build && npx playwright test -c e2e/capture/playwright.capture.config.ts
 * Writes PNGs to docs/design/screens/. Runs hidden (HOPLINE_HIDDEN via e2e/fixtures.ts).
 */
export default defineConfig({
  globalSetup: require.resolve('../build-fixture'),
  testDir: '.',
  testMatch: /capture\.shots\.ts$/,
  outputDir: './test-results',
  timeout: 600_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list'
})
