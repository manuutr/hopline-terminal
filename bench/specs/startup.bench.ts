/**
 * Cold start: process spawn → first paint, → sessions loaded ("hopline:ready" mark), → command
 * palette open and listing. Measured on the packaged app (release/linux-unpacked, built by
 * `npm run bench`) and on the built `out/` app, each on a fresh profile (first launch) and on the
 * same profile again (returning user). Median of RUNS.
 */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { context, median, record } from '../lib'

const RUNS = Number(process.env['BENCH_STARTUP_RUNS'] ?? 5)
const DESKTOP = join(__dirname, '..', '..', 'apps', 'desktop')
const PACKAGED = join(DESKTOP, 'release', 'linux-unpacked', process.platform === 'win32' ? 'Hopline.exe' : 'hopline')

interface Sample {
  window: number
  paint: number
  ready: number
  palette: number
  main: Record<string, number>
}

async function once(kind: 'packaged' | 'dev', profile: string): Promise<Sample> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOPLINE_HIDDEN: '1',
    ANTHROPIC_API_KEY: '',
    HOPLINE_POLICY: '',
    // Packaged builds ignore HOPLINE_USER_DATA: isolate the profile through the XDG config dir.
    XDG_CONFIG_HOME: profile,
    HOPLINE_USER_DATA: join(profile, 'Hopline')
  }
  delete env['HOPLINE_E2E']
  const t0 = Date.now()
  const app: ElectronApplication =
    kind === 'packaged'
      ? await electron.launch({ executablePath: PACKAGED, args: [], env })
      : await electron.launch({ args: ['.'], cwd: DESKTOP, env: { ...env, HOPLINE_E2E: '1' } })
  try {
    const page = await app.firstWindow()
    const tWindow = Date.now() - t0
    await page.waitForFunction(() => performance.getEntriesByName('hopline:ready').length > 0, null, { timeout: 30_000 })
    const marks = await page.evaluate(() => {
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? performance.getEntriesByName('first-paint')[0]?.startTime ?? NaN
      return { origin: performance.timeOrigin, fcp, ready: performance.getEntriesByName('hopline:ready')[0]!.startTime }
    })
    // A fresh profile shows the first-run privacy screen (0.7.0) and may ask to set up the vault (no
    // keyring): dismiss them the way a user can (Escape), so the palette is what gets timed. The
    // choices are never saved, so no launch ever checks for updates over the network.
    const dialog = page.locator('[role=dialog]')
    for (let i = 0; i < 5 && (await dialog.count()) > 0; i++) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(16)
    }
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('combobox', { name: 'Command palette' }).or(page.locator('[aria-label="Command palette"]')).first()).toBeVisible({ timeout: 10_000 })
    const tPalette = Date.now() - t0
    const main = await app.evaluate(() => {
      const out: Record<string, number> = { origin: performance.timeOrigin }
      for (const m of performance.getEntriesByType('mark')) if (m.name.startsWith('hopline:main:')) out[m.name.slice(13)] = m.startTime
      return out
    })
    const mainOrigin = main['origin']!
    const rel: Record<string, number> = { spawn: mainOrigin - t0 }
    for (const [k, v] of Object.entries(main)) if (k !== 'origin') rel[k] = mainOrigin + v - t0
    return { window: tWindow, paint: marks.origin + marks.fcp - t0, ready: marks.origin + marks.ready - t0, palette: tPalette, main: rel }
  } finally {
    await app.close().catch(() => {})
  }
}

for (const kind of ['packaged', 'dev'] as const) {
  test(`startup (${kind})`, async () => {
    test.skip(kind === 'packaged' && !existsSync(PACKAGED), `no packaged build at ${PACKAGED} (npm run bench builds it)`)
    const first: Sample[] = []
    const again: Sample[] = []
    for (let i = 0; i < RUNS; i++) {
      const profile = mkdtempSync(join(tmpdir(), 'hopline-bench-start-'))
      try {
        first.push(await once(kind, profile))
        again.push(await once(kind, profile))
      } finally {
        rmSync(profile, { recursive: true, force: true })
      }
    }
    const note = `best of ${RUNS} (report.mjs keeps the best run; median in the json)`
    for (const [label, xs] of [['first_launch', first], ['returning', again]] as const) {
      const p = `startup.${kind}.${label}`
      for (const s of xs) {
        record({ id: `${p}.first_paint_ms`, value: s.paint, unit: 'ms', better: 'lower', note })
        record({ id: `${p}.ready_ms`, value: s.ready, unit: 'ms', better: 'lower', note })
        record({ id: `${p}.palette_ms`, value: s.palette, unit: 'ms', better: 'lower', note })
      }
      record({ id: `${p}.palette_median_ms`, value: median(xs.map((s) => s.palette)), unit: 'ms', better: 'lower', note: `median of ${RUNS}`, info: true })
      for (const k of ['spawn', 'whenReady', 'createWindow', 'readyToShow'])
        record({ id: `${p}.main_${k}_ms`, value: median(xs.map((s) => s.main[k] ?? NaN)), unit: 'ms', better: 'lower', note: `median of ${RUNS}`, info: true })
    }
    context(`startup.${kind}.samples`, { first, again })
  })
}
