import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeIosDevice, startSim } from '../../../packages/simulator/src/index.ts'
import { treeRow, expect, launchHopline, showSessions, termTextOf, test } from './fixtures'

/**
 * Phase 6–8 review: process-level fixes that need a real Electron.
 * - M4: a second instance exits before `ready`, never running the startup on the same profile.
 * - M3: `--smoke` (the release smoke test that replaced ELECTRON_RUN_AS_NODE) loads the native
 *   modules and exits without touching the profile.
 */

const electronBin = require('electron') as unknown as string
const appDir = join(__dirname, '..')

function run(args: string[], env: Record<string, string>, timeoutMs = 30_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(electronBin, args, { cwd: appDir, env: { ...process.env, HOPLINE_E2E: '1', HOPLINE_HIDDEN: '1', HOPLINE_POLICY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += String(d)))
    p.stderr.on('data', (d) => (out += String(d)))
    const t = setTimeout(() => (p.kill('SIGKILL'), reject(new Error(`timed out: ${out}`))), timeoutMs)
    p.on('exit', (code) => (clearTimeout(t), resolve({ code, out })))
  })
}

test('M4: a second instance hands over its link and exits before any startup work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hopline-e2e-'))
  const { app } = await launchHopline({ dir, env: { HOPLINE_E2E_SINGLE_INSTANCE: '1' } })
  try {
    const second = await run(['.', 'hopline://settings/appearance'], { HOPLINE_USER_DATA: dir, HOPLINE_E2E_SINGLE_INSTANCE: '1' })
    expect(second.code).toBe(0)
    // The startup (database, migrations, vault, session host, window) never ran in the second process.
    expect(second.out).not.toContain('[hopline-e2e] startup ran')
    await expect.poll(() => app.evaluate(() => (globalThis as { __hoplineSecondInstance?: number }).__hoplineSecondInstance ?? 0)).toBe(1)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M3: --smoke loads the native modules, exits 0 and leaves the profile untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hopline-e2e-'))
  try {
    const r = await run(['.', '--smoke'], { HOPLINE_USER_DATA: dir })
    expect(r.out).toContain('smoke ok   better-sqlite3')
    expect(r.out).toContain('smoke ok   serialport')
    expect(r.out).toContain('smoke ok   ssh2')
    expect(r.out).toContain('smoke ok   packet decoder')
    expect(r.out).toContain('smoke: ok')
    expect(r.out).not.toContain('[hopline-e2e] startup ran')
    expect(r.code).toBe(0)
    expect(readdirSync(dir)).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('L8: quitting saves the scrollback of a tab that has not hit its 30 s periodic save', async () => {
  const ios = await startSim({ device: makeIosDevice(), port: 0 })
  const dir = mkdtempSync(join(tmpdir(), 'hopline-e2e-'))
  try {
    const { app, page } = await launchHopline({ dir, seedPorts: `${ios.port},1,1` })
    const termText = termTextOf(page)
    await showSessions(page)
    await treeRow(page, 'core-sw1').or(page.getByText('core-sw1', { exact: true })).first().dblclick()
    const pw = page.locator('[role=dialog] input[type=password]')
    await expect.poll(async () => (await pw.isVisible()) || /core-sw1#\s*$/.test(await termText())).toBe(true)
    if (await pw.isVisible()) (await pw.fill('admin'), await pw.press('Enter'))
    await expect.poll(termText).toMatch(/core-sw1#\s*$/)
    await page.locator('.xterm').first().click()
    await page.keyboard.type('show version\r')
    await expect.poll(termText).toMatch(/Cisco IOS[\s\S]*core-sw1#\s*$/)
    const sb = join(dir, 'scrollback')
    expect(existsSync(sb) ? readdirSync(sb).filter((f) => f.endsWith('.hsb')) : []).toEqual([])
    await app.close()
    expect(readdirSync(sb).filter((f) => f.endsWith('.hsb'))).toHaveLength(1)
    // No temp file is left behind (review L11: each save has its own temp name, removed on failure).
    expect(readdirSync(sb).filter((f) => f.endsWith('.tmp'))).toEqual([])
  } finally {
    await ios.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('L8: a window with no terminal answers the flush at once, so closing never waits for the timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hopline-e2e-'))
  const { app } = await launchHopline({ dir })
  try {
    const ms = await app.evaluate(
      ({ BrowserWindow, ipcMain }) =>
        new Promise<number>((resolve) => {
          const wc = BrowserWindow.getAllWindows()[0]!.webContents
          const t0 = Date.now()
          const timer = setTimeout(() => resolve(-1), 1500)
          ipcMain.on('scrollback:flushed', function ack(e, n) {
            if (e.sender !== wc || n !== 'e2e-probe') return
            ipcMain.removeListener('scrollback:flushed', ack)
            clearTimeout(timer)
            resolve(Date.now() - t0)
          })
          wc.send('scrollback:flush', 'e2e-probe')
        })
    )
    expect(ms).toBeGreaterThanOrEqual(0)
    expect(ms).toBeLessThan(1000)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('L2: a deep link that arrives while the page reloads opens Settings once it has loaded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hopline-e2e-'))
  const { app, page } = await launchHopline({ dir })
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents
      wc.once('did-start-loading', () => (globalThis as { __hoplineDeepLink?: (u: string) => void }).__hoplineDeepLink?.('hopline://settings/appearance'))
      wc.reload()
    })
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible({ timeout: 20_000 })
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
