/**
 * 0.7 UX surfaces (Phase 6): first run, the getting-started checklist, settings search, per-host
 * overrides, the keymap clash list and Themes and fonts. Each at 1440×900 and 1100×700, dark and light:
 *   HOPLINE_SHOTS_OUT=/path npx playwright test -c e2e/capture/playwright.capture.config.ts ux.capture
 */
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { treeRow, expect, launchHopline, showSessions, test } from '../fixtures'
import { sizeTo, snapNarrow } from './narrow'

const SIZES = [
  { w: 1440, h: 900 },
  { w: 1100, h: 700 }
] as const

async function both(app: ElectronApplication, page: Page, name: string, setup: () => Promise<void>, teardown?: () => Promise<void>): Promise<void> {
  for (const s of SIZES) {
    await sizeTo(app, page, s.w, s.h)
    await setup()
    await snapNarrow(page, name, s.w)
    if (teardown) await teardown()
  }
}

test('0.7 UX surfaces', async ({ hop }) => {
  const { app, page } = hop
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const closeSettings = async () => {
    await page.keyboard.press('Escape')
    if (await settings.isVisible()) await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()
  }

  // First run: step 1 under the launcher, then step 3.
  await both(app, page, '70-first-run-import', async () => {
    await expect(page.locator('[data-first-run]')).toContainText('Step 1 of 3')
  })
  const steps = page.locator('[data-first-run]')
  await steps.getByRole('button', { name: 'Skip', exact: true }).click()
  await steps.getByRole('button', { name: 'Skip', exact: true }).click()
  await both(app, page, '71-first-run-connect', async () => {
    await expect(steps).toContainText('Step 3 of 3')
  })

  // Connect (ends the steps), then the checklist expanded in the sidebar.
  await hop.connect('core-sw1')
  await page.keyboard.press('Control+Shift+K')
  await page.keyboard.press('Escape')
  await both(app, page, '72-checklist', async () => {
    await showSessions(page)
    const head = page.locator('[data-checklist] button[aria-expanded]').first()
    if ((await head.getAttribute('aria-expanded')) === 'false') await head.click()
    await expect(page.locator('[data-checklist] [data-item]').first()).toBeVisible()
  })

  // Settings search.
  await both(
    app,
    page,
    '73-settings-search',
    async () => {
      await page.keyboard.press('Control+Shift+Comma')
      await settings.getByTestId('settings-search').fill('log')
      await expect(settings.getByRole('listbox', { name: 'Matching settings' }).getByRole('option').first()).toBeVisible()
    },
    closeSettings
  )
  // Landed on a row from a "change this" link (the flash).
  await both(
    app,
    page,
    '74-settings-landed',
    async () => {
      await app.evaluate(() => (globalThis as { __hoplineDeepLink?: (u: string) => void }).__hoplineDeepLink!('hopline://settings/notifications/notifyDisconnects'))
      await expect(settings.locator('[data-setting-key="notifyDisconnects"]')).toHaveAttribute('data-flash', /.*/)
    },
    closeSettings
  )

  // Per-host overrides: a folder value set, then the session dialog inheriting it.
  const folder = page.getByRole('treeitem', { name: /Lab \(simulator\)/ }).first()
  const fdlg = page.getByRole('dialog', { name: 'Overrides for Lab (simulator)' })
  await showSessions(page)
  await folder.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Overrides for this folder…' }).click()
  await fdlg.locator('[data-override="termFontSize"]').getByRole('switch').click()
  await fdlg.getByLabel('Font size override').fill('15')
  await fdlg.locator('[data-override="keepAliveSec"]').getByRole('switch').click()
  await fdlg.getByRole('button', { name: 'Save' }).click()
  await both(
    app,
    page,
    '75-overrides-session',
    async () => {
      await showSessions(page)
      await treeRow(page, 'core-sw1').first().click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Overrides…' }).click()
      const d = page.getByRole('dialog', { name: 'Overrides for core-sw1' })
      await d.locator('[data-override="termCursorStyle"]').getByRole('switch').click()
      await expect(d).toBeVisible()
    },
    async () => {
      await page.keyboard.press('Escape')
    }
  )

  // Keymap clash list.
  await page.evaluate(() => window.hopline.keymap.set({ 'pane.splitRight': ['Mod+K'] }))
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await both(
    app,
    page,
    '76-keymap-clash',
    async () => {
      await page.keyboard.press('Control+Shift+Comma')
      await settings.getByRole('tab', { name: 'Keyboard' }).click()
      await expect(settings.getByTestId('key-conflicts')).toBeVisible()
    },
    closeSettings
  )

  // Themes and fonts.
  await both(
    app,
    page,
    '77-themes',
    async () => {
      await page.keyboard.press('Control+Shift+Comma')
      await settings.getByRole('tab', { name: 'Themes and fonts' }).click()
      await expect(settings.locator('[data-setting-key="themeLibrary"]')).toBeVisible()
    },
    closeSettings
  )
  // Settings › Updates & privacy: crash reports on, a user DSN, one native dump listed (a fake file
  // in the dumps folder; nothing is sent). Review: the panel was not in the capture spec.
  const dumps = join(await app.evaluate(({ app: a }) => a.getPath('crashDumps')), 'completed')
  mkdirSync(dumps, { recursive: true, mode: 0o700 })
  writeFileSync(join(dumps, 'capture-0001.dmp'), Buffer.alloc(48 * 1024), { mode: 0o600 })
  await both(
    app,
    page,
    '80-settings-privacy',
    async () => {
      await page.keyboard.press('Control+Shift+Comma')
      await settings.getByRole('tab', { name: 'Updates & privacy' }).click()
      await expect(settings.locator('[data-setting-key="crashReportDsn"]')).toBeVisible()
      // Through the panel itself, so the window's settings follow (a local DSN: nothing is sent).
      const dsn = settings.getByLabel('Crash report DSN')
      if ((await dsn.inputValue()) === '') {
        await dsn.fill('https://0123456789abcdef@sentry.example.com/1')
        await settings.locator('[data-setting-key="crashReportDsn"]').getByRole('button', { name: 'Save' }).click()
      }
      const sw = settings.getByRole('switch', { name: 'Send crash reports' })
      if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click()
      await expect(sw).toHaveAttribute('aria-checked', 'true')
      await settings.locator('[data-settings-section="crash"]').scrollIntoViewIfNeeded()
    },
    closeSettings
  )
  await page.evaluate(() => window.hopline.settings.update({ crashReports: false, crashReportDsn: '' }))

  await both(
    app,
    page,
    '78-font-preview',
    async () => {
      await page.keyboard.press('Control+Shift+Comma')
      await settings.getByRole('tab', { name: 'Themes and fonts' }).click()
      await settings.locator('[data-setting-key="fontPreview"]').scrollIntoViewIfNeeded()
    },
    closeSettings
  )
})

test('0.7 first run with the privacy step, and a failed read', async () => {
  const { app, page, dir } = await launchHopline({ env: { HOPLINE_E2E_FIRST_RUN: '1' } })
  try {
    await both(app, page, '69-first-run-privacy', async () => {
      await expect(page.locator('[data-first-run] [data-step="privacy"]')).toBeVisible()
    })
    await page.getByTestId('privacy-continue').click()
    await expect(page.locator('[data-first-run]')).toContainText('Step 1 of 3')
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('knownHosts:list')
      ipcMain.handle('knownHosts:list', () => {
        throw new Error('database is locked')
      })
    })
    await both(
      app,
      page,
      '79-failed-read',
      async () => {
        await page.keyboard.press('Control+Shift+K')
        const pal = page.getByRole('dialog', { name: 'Command palette' })
        await pal.getByRole('combobox').fill('known hosts')
        await expect(pal.getByRole('option').first()).toContainText(/known hosts/i)
        await page.keyboard.press('Enter')
        await expect(page.getByRole('dialog', { name: 'Known hosts' }).getByRole('alert')).toBeVisible()
      },
      async () => {
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog', { name: 'Known hosts' })).toBeHidden()
      }
    )
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
