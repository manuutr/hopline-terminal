import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** The live model eval (docs/EVALS.md): `npm run eval`. Separate from the CI suite; off unless HOPLINE_EVAL_LIVE=1. */
export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'apps/desktop/src/shared') } },
  test: { include: ['apps/desktop/test/eval/**/*.eval.ts'], testTimeout: 4 * 60 * 60_000, hookTimeout: 60_000 }
})
