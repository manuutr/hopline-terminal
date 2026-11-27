import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  define: { __HOPLINE_DEV_LAB__: true },
  resolve: { alias: { '@shared': resolve(__dirname, 'apps/desktop/src/shared') } },
  test: { include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'bench/*.test.ts'] }
})
