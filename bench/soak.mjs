#!/usr/bin/env node
/**
 * `npm run soak`: the soak test (bench/specs/soak.soak.ts) on the built app, hidden.
 *
 *   SOAK_MINUTES=30 npm run soak            default 30 minutes
 *   SOAK_MINUTES=1440 npm run soak          24 hours
 *   node bench/soak.mjs --no-build          reuse apps/desktop/out
 *
 * Writes bench/results/soak-<date>-<N>min.json and .md.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (cmd, argv) => spawnSync(cmd, argv, { stdio: 'inherit', cwd: root, env: { ...process.env, HOPLINE_HIDDEN: '1' } }).status ?? 1
if (!process.argv.includes('--no-build') && run(npm, ['run', 'build']) !== 0) process.exit(1)
process.exit(run(npx, ['playwright', 'test', '-c', 'bench/playwright.config.ts', 'soak']))
