import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { makeIosDevice, startSim } from '../../../packages/simulator/src/index.ts'
import { MOD, expect, launchHopline, showSessions, stubDialogs, test, sizeWindow } from './fixtures'

/**
 * Phase 7: the first-run privacy screen, auto-update against a local fake update server (nothing
 * is ever installed), and opt-in crash reports against a local fake Sentry.
 */

const settingsTab = async (page: import('@playwright/test').Page) => {
  await page.keyboard.press(`${MOD}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  await dlg.getByRole('tab', { name: 'Updates & privacy' }).click()
  return dlg
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

test.describe('first-run privacy screen', () => {
  test('the first onboarding step: shown once, saves the choices, never again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopline-e2e-'))
    try {
      let { app, page } = await launchHopline({ dir, env: { HOPLINE_E2E_FIRST_RUN: '1' } })
      // Phase 6: on a first run it leads the onboarding steps (no modal on top). It is "before you
      // start", not a numbered step: the three steps are "of 3" whether or not it was shown (review P2).
      const steps = page.locator('[data-first-run]')
      await expect(steps).toContainText('Before you start')
      const dlg = steps.locator('[data-step="privacy"]')
      await expect(dlg).toContainText('What leaves this machine')
      await expect(page.getByRole('dialog', { name: 'What leaves this machine' })).toHaveCount(0)
      await expect(dlg.getByText('Update checks', { exact: true })).toBeVisible()
      // Review L6: the copy says what GitHub actually sees, not "the app version and OS, nothing else".
      await expect(dlg).toContainText('GitHub sees your IP address and which version you download')
      await expect(dlg).not.toContainText('nothing else')
      await expect(dlg.getByText('AI requests', { exact: true })).toBeVisible()
      await expect(dlg.getByText('Crash reports', { exact: true })).toBeVisible()
      // This build has no crash-report server: the switch is off and cannot be turned on.
      await expect(dlg.getByRole('switch', { name: 'Send crash reports' })).toBeDisabled()
      // What Continue agrees to, in one line (review P2).
      await expect(dlg.getByTestId('privacy-summary')).toHaveText('Update checks: on · Crash reports: off.')
      await dlg.getByRole('switch', { name: 'Check for updates' }).click()
      await expect(dlg.getByTestId('privacy-summary')).toHaveText('Update checks: off · Crash reports: off.')
      await dlg.getByTestId('privacy-continue').click()
      // Answered: the import step is current, the privacy step is ticked.
      await expect(steps).toContainText('Step 1 of 3')
      await expect(dlg.getByTestId('privacy-continue')).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => window.hopline.settings.get())).toMatchObject({ privacyReviewed: true, updateAutoCheck: false, crashReports: false })
      await app.close()
      ;({ app, page } = await launchHopline({ dir, env: { HOPLINE_E2E_FIRST_RUN: '1' } }))
      await expect(page.getByRole('dialog', { name: 'What leaves this machine' })).toHaveCount(0)
      await expect(page.locator('[data-first-run]')).toContainText('Step 1 of 3')
      await app.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('at 1100×700 the consent and its Continue are on screen without scrolling: the step leads the launcher (review P1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopline-e2e-'))
    try {
      const { app, page } = await launchHopline({ dir, env: { HOPLINE_E2E_FIRST_RUN: '1' } })
      await sizeWindow(app, page, 1100, 700)
      const step = page.locator('[data-first-run] [data-step="privacy"]')
      await expect(step).toBeVisible()
      const fold = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="privacy-continue"]')!.getBoundingClientRect()
        const sw = document.querySelector('[data-step="privacy"] [role="switch"][aria-label="Send crash reports"]')!.getBoundingClientRect()
        const steps = document.querySelector('[data-first-run]')!.getBoundingClientRect()
        const list = document.querySelector('[data-launcher] [cmdk-input]')!.getBoundingClientRect()
        return { continueBottom: r.bottom, crashBottom: sw.bottom, h: innerHeight, stepsTop: steps.top, listTop: list.top }
      })
      expect(fold.continueBottom).toBeLessThanOrEqual(fold.h)
      expect(fold.crashBottom).toBeLessThanOrEqual(fold.h)
      expect(fold.stepsTop).toBeLessThan(fold.listTop)
      // After Continue the steps stay where they are (no jump) and count 1 of 3.
      await page.getByTestId('privacy-continue').click()
      await expect(page.locator('[data-first-run]')).toContainText('Step 1 of 3')
      await app.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('skipping setup does not skip it: it comes back as a dialog, and Esc keeps the switches as shown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopline-e2e-'))
    try {
      const { app, page } = await launchHopline({ dir, env: { HOPLINE_E2E_FIRST_RUN: '1' } })
      await page.locator('[data-first-run]').getByRole('button', { name: 'Skip setup' }).click()
      const dlg = page.getByRole('dialog', { name: 'What leaves this machine' })
      await expect(dlg).toBeVisible()
      await dlg.getByRole('switch', { name: 'Check for updates' }).click()
      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => window.hopline.settings.get())).toMatchObject({ privacyReviewed: true, updateAutoCheck: false })
      await app.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------------------------ updates

const work = mkdtempSync(join(tmpdir(), 'hopline-update-'))
// What the app pretends to be running (electron-updater replaces this file on install: it must not change).
const installed = join(work, 'Hopline-current.AppImage')
writeFileSync(installed, 'the installed AppImage')
const payload = Buffer.from('#!/bin/sh\necho fake Hopline Terminal 99\n')
const sha512 = createHash('sha512').update(payload).digest('base64')
let staging = 0
let downloads = 0
const rolloutHeaders: string[] = []
const feed = { url: '', server: null as Server | null }

test.describe('auto-update against a local server', () => {
  test.skip(process.platform !== 'linux' || process.arch !== 'x64', 'the AppImage updater runs on Linux x64 here; NSIS and macOS use the same service')
  test.beforeAll(async () => {
    const s = await listen((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      if (path === '/latest-linux.yml') {
        rolloutHeaders.push(String(req.headers['x-user-staging-id'] ?? ''))
        res.setHeader('content-type', 'text/yaml')
        return res.end(
          `version: 99.0.0\nfiles:\n  - url: Hopline-99.0.0-linux-x86_64.AppImage\n    sha512: ${sha512}\n    size: ${payload.length}\npath: Hopline-99.0.0-linux-x86_64.AppImage\nsha512: ${sha512}\nreleaseDate: '2026-11-25T00:00:00.000Z'\nstagingPercentage: ${staging}\n`
        )
      }
      if (path === '/Hopline-99.0.0-linux-x86_64.AppImage') return (downloads++, res.end(payload))
      res.statusCode = 404
      res.end()
    })
    feed.server = s.server
    feed.url = s.url
  })
  test.afterAll(() => {
    feed.server?.close()
    rmSync(work, { recursive: true, force: true })
  })

  test('an AppImage (nothing checks its signature) is notify-only: it links to the release, never downloads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopline-e2e-'))
    const { app, page } = await launchHopline({ dir, env: { HOPLINE_E2E_UPDATE_URL: feed.url, APPIMAGE: installed, XDG_CACHE_HOME: join(work, 'cache-notify') } })
    try {
      staging = 100
      const before = downloads
      const dlg = await settingsTab(page)
      await dlg.getByRole('button', { name: 'Check now' }).click()
      await expect(dlg.getByTestId('update-status')).toContainText('Hopline Terminal 99.0.0 is available')
      expect(rolloutHeaders.length).toBeGreaterThan(0)
      expect(rolloutHeaders.every((value) => value === '')).toBe(true)
      expect(await page.evaluate(() => window.hopline.updates.status())).toMatchObject({ mode: 'notify', state: { kind: 'available', version: '99.0.0' } })
      await expect(page.getByTestId('update-ready')).toHaveCount(0)
      expect(downloads).toBe(before)
      expect(await page.evaluate(() => window.hopline.updates.restart())).toEqual({ ok: false, reason: 'not-ready' })
    } finally {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    }
    expect(readFileSync(installed, 'utf8')).toBe('the installed AppImage')
  })

  test('staged rollout, background download, "Update ready", never a restart with sessions open', async () => {
    // The feed's port is only known now, so this test starts its own app and simulator.
    const ios = await startSim({ device: makeIosDevice(), port: 0 })
    const dir = mkdtempSync(join(tmpdir(), 'hopline-e2e-'))
    // A build that can verify what it downloads (signed Windows or macOS): stood in for by HOPLINE_E2E_UPDATE_MODE.
    const { app, page } = await launchHopline({ dir, seedPorts: `${ios.port},1,1`, env: { HOPLINE_E2E_UPDATE_URL: feed.url, HOPLINE_E2E_UPDATE_MODE: 'auto', APPIMAGE: installed, XDG_CACHE_HOME: join(work, 'cache') } })
    try {
      let dlg = await settingsTab(page)
      // Outside the rollout (stagingPercentage 0): nothing to do.
      staging = 0
      await dlg.getByRole('button', { name: 'Check now' }).click()
      await expect(dlg.getByTestId('update-status')).toContainText('Up to date')
      await expect(page.getByTestId('update-ready')).toHaveCount(0)
      // Rolled out to everyone: downloads in the background, then a quiet line in the status bar.
      staging = 100
      await dlg.getByRole('button', { name: 'Check now' }).click()
      await expect(page.getByTestId('update-ready')).toHaveText('Update ready — restart when you’re done', { timeout: 20_000 })
      await expect(dlg.getByTestId('update-status')).toContainText('Hopline Terminal 99.0.0 is ready')
      await dlg.getByRole('button', { name: 'Close', exact: true }).last().click()
      await expect(dlg).toHaveCount(0)

      // A session is open: "restart" is refused in main, whatever the window asks.
      await showSessions(page)
      await page.getByRole('treeitem', { name: 'core-sw1', exact: true }).or(page.getByText('core-sw1', { exact: true })).first().dblclick()
      const pw = page.locator('[role=dialog] input[type=password]')
      await expect.poll(async () => (await pw.isVisible()) || /core-sw1[#>]\s*$/.test(await page.evaluate(() => (window as unknown as { __hoplineTest: { text: () => string } }).__hoplineTest.text()))).toBe(true)
      if (await pw.isVisible()) (await pw.fill('admin'), await pw.press('Enter'))
      await expect.poll(() => page.evaluate(() => window.hopline.updates.restart())).toEqual({ ok: false, reason: 'sessions', open: 1 })
      dlg = await settingsTab(page)
      await dlg.getByRole('button', { name: 'Restart and install' }).click()
      await expect(page.getByText('1 session is open')).toBeVisible()
      expect(await app.evaluate(() => (globalThis as { __hoplineInstallRequested?: number }).__hoplineInstallRequested ?? 0)).toBe(0)
    } finally {
      await app.close()
      await ios.close()
      rmSync(dir, { recursive: true, force: true })
    }
    // Quitting never installed anything in a test.
    expect(readFileSync(installed, 'utf8')).toBe('the installed AppImage')
  })
})

test.describe('auto-update: the team policy turns it off', () => {
  const pol = join(mkdtempSync(join(tmpdir(), 'hopline-pol-')), 'policy.json')
  writeFileSync(pol, JSON.stringify({ version: 1, name: 'Air gap', disableUpdates: true, disableCrashReports: true }))
  test.use({ hopEnv: { HOPLINE_POLICY: pol, HOPLINE_E2E_UPDATE_URL: 'http://127.0.0.1:9' } })

  test('no checks, "Check now" disabled, crash reports locked off', async ({ hop }) => {
    const dlg = await settingsTab(hop.page)
    await expect(dlg.getByTestId('update-status')).toContainText('turned off by the team policy')
    await expect(dlg.getByRole('button', { name: 'Check now' })).toBeDisabled()
    await expect(dlg.getByRole('switch', { name: 'Automatic checks' })).toBeDisabled()
    await expect(dlg.getByRole('switch', { name: 'Send crash reports' })).toBeDisabled()
    // A crafted call is refused in main too.
    expect(await hop.page.evaluate(() => window.hopline.updates.check())).toMatchObject({ state: { kind: 'off', reason: 'policy' } })
    await expect(hop.page.evaluate(() => window.hopline.settings.update({ crashReports: true }))).rejects.toThrow(/managed by the team policy/)
  })
})

// ------------------------------------------------------------------ crash reports

test.describe('crash reports against a local fake Sentry', () => {
  test('opt in, send a test crash, a renderer error arrives scrubbed, a dump only after a yes', async ({ hop }) => {
    const { page } = hop
    const got: string[] = []
    const { server, url } = await listen((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks)
        got.push(req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'))
        res.setHeader('content-type', 'application/json')
        res.end('{}')
      })
    })
    try {
      const dsn = `${url.replace('http://', 'http://abcdef0123456789@')}/7`
      const dlg = await settingsTab(page)
      await expect(dlg.getByRole('button', { name: 'Send a test crash' })).toBeDisabled()
      await dlg.getByRole('textbox', { name: 'Crash report DSN' }).fill(dsn)
      await dlg.getByRole('button', { name: 'Save', exact: true }).click()
      await dlg.getByRole('switch', { name: 'Send crash reports' }).click()
      await dlg.getByRole('button', { name: 'Send a test crash' }).click()
      await expect(page.getByText('Test crash report sent')).toBeVisible()
      await expect.poll(() => got.join('\n')).toContain('HoplineTestCrash')
      // A renderer error carrying the user's own values (a seeded session, its host and user).
      await page.evaluate(() => setTimeout(() => { throw new Error('lost core-sw1 at 10.20.30.40 as admin: dist-eos1#show running-config') }, 0))
      await expect.poll(() => got.join('\n')).toContain('lost <redacted>')
      const all = got.join('\n')
      for (const canary of ['core-sw1', 'dist-eos1', '10.20.30.40', 'show running-config', 'Lab (simulator)']) expect(all, canary).not.toContain(canary)
      expect(all).not.toMatch(/"server_name"|"user"|"breadcrumbs"/)

      // A native dump: listed, never sent without a yes (the stub answers Cancel), then sent as a
      // multipart minidump upload once confirmed, and deleted after the server took it.
      const dumps = await hop.app.evaluate(({ app }) => app.getPath('crashDumps'))
      mkdirSync(join(dumps, 'completed'), { recursive: true })
      const dmp = join(dumps, 'completed', 'e2e-dump-0001.dmp')
      writeFileSync(dmp, 'MDMP fake minidump body')
      await dlg.getByRole('tab', { name: 'Workspace' }).click()
      await dlg.getByRole('tab', { name: 'Updates & privacy' }).click()
      const before = got.length
      await dlg.getByRole('button', { name: 'Send…' }).click()
      await page.waitForTimeout(500)
      expect(got.length).toBe(before)
      expect(existsSync(dmp)).toBe(true)
      await stubDialogs(hop.app, {})
      await dlg.getByRole('button', { name: 'Send…' }).click()
      await expect(page.getByText('Crash dump sent')).toBeVisible()
      const upload = got.slice(before).join('\n')
      expect(upload).toContain('name="upload_file_minidump"')
      expect(upload).toContain('MDMP fake minidump body')
      expect(existsSync(dmp)).toBe(false)
      await expect(dlg.getByText('None.')).toBeVisible()

      // Review L5: each report and the dump left a metadata-only row in "What left this machine".
      const rows = await page.evaluate(() => window.hopline.egress.list())
      const crashRows = rows.filter((r) => r.source === 'crash')
      expect(crashRows.map((r) => r.model)).toContain('crash dump')
      expect(crashRows.map((r) => r.model)).toContain('crash report')
      expect(crashRows.every((r) => r.destination === new URL(url).host)).toBe(true)

      // Review M2: turning crash reports off deletes the dumps still on disk.
      const left = join(dumps, 'completed', 'e2e-dump-0002.dmp')
      writeFileSync(left, 'MDMP another body')
      await dlg.getByRole('tab', { name: 'Workspace' }).click()
      await dlg.getByRole('tab', { name: 'Updates & privacy' }).click()
      await expect(dlg.getByTestId('dumps-delete-all')).toBeVisible()
      await dlg.getByRole('switch', { name: 'Send crash reports' }).click()
      await expect.poll(() => existsSync(left)).toBe(false)
    } finally {
      server.close()
    }
  })
})
