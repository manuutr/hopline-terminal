#!/usr/bin/env node
/**
 * `npm run bench`: build, package (unpacked dir), run every benchmark headless and hidden, write
 * bench/results/<date>.json + .md, and compare against bench/baseline.json.
 *
 *   node bench/run.mjs [--no-build] [--no-package] [--grep <spec>] [--label <name>] [--quick]
 *
 * Nothing pops up: Electron runs with HOPLINE_HIDDEN=1 (an off-screen, unfocusable window), the
 * e2e build keeps its clipboard in memory, and native dialogs are stubbed.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const desktop = join(root, 'apps', 'desktop')
const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f) => (has(f) ? args[args.indexOf(f) + 1] : undefined)
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(cmd, argv, opts = {}) {
  console.log(`\n$ ${cmd} ${argv.join(' ')}`)
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: root, ...opts, env: { ...process.env, ...opts.env } })
  if (r.status !== 0 && !opts.allowFail) process.exit(r.status ?? 1)
  return r.status ?? 1
}

rmSync(join(here, 'results', '.raw'), { recursive: true, force: true })
// The same switch for the bundle: the packaged bench build accepts Playwright's --remote-debugging-port
// (every other packaged build exits on it; apps/desktop/src/main/index.ts).
if (!has('--no-build')) run(npm, ['run', 'build'], { env: has('--no-package') ? {} : { HOPLINE_UNFUSED_BENCH_BUILD: '1' } })
if (!has('--no-package')) {
  const target = process.platform === 'win32' ? '--win' : process.platform === 'darwin' ? '--mac' : '--linux'
  // Unfused (apps/desktop/scripts/fuses.cjs): Playwright drives the packaged app over --inspect, which
  // the release fuses turn off. Local benchmark builds only; never shipped.
  run(npx, ['electron-builder', '--config', 'electron-builder.config.cjs', '--publish', 'never', target, 'dir'], { cwd: desktop, env: { HOPLINE_UNFUSED_BENCH_BUILD: '1' } })
}
const env = {
  HOPLINE_HIDDEN: '1',
  ...(has('--quick') ? { BENCH_STARTUP_RUNS: '2', BENCH_FLOOD_MB: '10', BENCH_ANSI_MB: '5', BENCH_SCROLL_LINES: '20000', BENCH_TABS: '5', BENCH_LATENCY_SAMPLES: '10', BENCH_REPEAT: '1' } : {})
}
const pw = ['playwright', 'test', '-c', 'bench/playwright.config.ts', '--grep-invert', 'soak']
if (val('--grep')) pw.push(val('--grep'))
const status = run(npx, pw, { env, allowFail: true })
run(process.execPath, [join(here, 'report.mjs'), ...(val('--label') ? ['--label', val('--label')] : [])])
if (existsSync(join(here, 'baseline.json'))) run(process.execPath, [join(here, 'compare.mjs')], { allowFail: true })
process.exit(status)
