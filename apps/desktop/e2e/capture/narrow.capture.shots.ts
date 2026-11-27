/**
 * Permanent narrow-window captures (polish round 2). Run with the capture config:
 *   cd apps/desktop && npx electron-vite build && npx playwright test -c e2e/capture/playwright.capture.config.ts
 *
 * Every surface is opened with the AI panel open and a split, at 1100×700 and 900×640, shot in both
 * themes as docs/design/screens/n-<surface>-<width>-<theme>.png, and must pass `assertFits` (no
 * horizontal overflow, no collapsed text, no overlapping toolbar items, inside the window). Unlike
 * capture.shots.ts, a failing assertion fails the run.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { makeEosDevice, startSim } from '../../../../packages/simulator/src/index.ts'
import { expect, showSessions, stubDialogs, test, type Hopline } from '../fixtures'
import { assertFits, NARROW, sizeTo, snapNarrow } from './narrow'

const openAi = async (page: Page) => {
  const composer = page.getByRole('region', { name: /assistant/i }).or(page.locator('[data-ai-panel]'))
  if (!(await composer.first().isVisible().catch(() => false))) await page.keyboard.press('Control+Shift+I')
  await page.waitForTimeout(300)
}

/** Focus a terminal by clicking its bottom-left corner (the centre may hold a block toolbar). */
const focusTerm = async (page: Page, which: 'first' | 'last') => {
  const t = page.locator('.xterm:visible')[which]()
  const box = (await t.boundingBox())!
  await t.click({ position: { x: 12, y: box.height - 8 } })
}

/** Split the focused pane and connect `name` in the new pane (answers a password prompt if one shows). */
const split = async (hop: Hopline, name: string) => {
  const { page } = hop
  await focusTerm(page, 'first')
  await page.keyboard.press('Control+Shift+D')
  await expect(page.locator('[data-launcher] input')).toBeFocused()
  await page.locator('[data-launcher] input').fill(name)
  await page.keyboard.press('Enter')
  const pw = page.locator('[role=dialog] input[type=password]')
  await expect.poll(async () => (await pw.isVisible()) || (await page.locator('.xterm:visible').count()) >= 2).toBe(true)
  if (await pw.isVisible()) {
    await pw.fill('admin')
    await pw.press('Enter')
  }
  await page.waitForTimeout(1200)
}

test('narrow: files panel with the AI panel and a split', async ({ hop }) => {
  const { app, page } = hop
  const eos = await startSim({ device: makeEosDevice(), port: 0, files: { sftp: true } })
  const local = mkdtempSync(join(tmpdir(), 'hopline-narrow-files-'))
  const img = join(local, 'EOS-4.32.2F-very-long-image-name.swi')
  writeFileSync(img, Buffer.alloc(400_000, 9))
  try {
    await page.evaluate(async (port) => {
      await window.hopline.sessions.save({ folderId: null, name: 'leaf-files', host: '127.0.0.1', port, protocol: 'ssh', platform: 'eos', username: 'admin', credentialId: null, logToFile: false, notes: '', options: {} } as never)
    }, eos.port)
    await page.reload()
    await page.waitForSelector('text=Lab (simulator)')
    // Uploads need read-only mode off since 0.5.1.
    await page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))
    await sizeTo(app, page, 1100, 700)
    await showSessions(page)
    await page.getByText('leaf-files', { exact: true }).first().dblclick()
    const pw = page.locator('[role=dialog] input[type=password]')
    await expect.poll(async () => (await pw.isVisible()) || /dist-eos1[#>]\s*$/.test(await hop.termText())).toBe(true)
    if (await pw.isVisible()) {
      await pw.fill('admin')
      await pw.press('Enter')
    }
    await expect.poll(hop.termText).toMatch(/dist-eos1[#>]\s*$/)
    await split(hop, 'core-sw1')
    await openAi(page)
    // Back to the files tab's first pane, then open Files from the tab menu.
    await focusTerm(page, 'first')
    await page.getByRole('tab', { selected: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Files/ }).click()
    const panel = page.getByRole('region', { name: 'Files' })
    await expect(panel.getByRole('option', { name: /startup-config/ })).toBeVisible()
    // Opening the panel puts the keyboard on the list (round 2).
    await expect(panel.getByRole('listbox')).toBeFocused()
    await stubDialogs(app, { open: img, dir: local })
    await panel.getByRole('button', { name: 'Upload…' }).click()
    // Below 760 px of panel width the queue sits behind the Transfers toggle (hidden, still in the DOM).
    await expect(panel.locator('li[aria-label^="Upload EOS"][aria-label$=": Done"]')).toBeAttached({ timeout: 20_000 })
    for (const { w, h } of NARROW) {
      await sizeTo(app, page, w, h)
      await panel.getByRole('option', { name: /startup-config/ }).click()
      await assertFits(panel)
      await snapNarrow(page, 'n-files', w)
      const toggle = panel.getByRole('button', { name: /^Transfers/ })
      if (await toggle.isVisible()) {
        await toggle.click()
        await expect(panel.getByRole('region', { name: 'Transfers' })).toBeVisible()
        await assertFits(panel)
        await snapNarrow(page, 'n-files-transfers', w)
        await page.keyboard.press('Escape')
        await expect(panel.getByRole('region', { name: 'Transfers' })).toBeHidden()
      }
    }
  } finally {
    await eos.close()
    rmSync(local, { recursive: true, force: true })
  }
})

test('narrow: block table in a split pane with the AI panel', async ({ hop }) => {
  const { app, page } = hop
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control+Shift'
  await sizeTo(app, page, 1100, 700)
  await hop.connect('core-sw1')
  await split(hop, 'core-sw1')
  await openAi(page)
  await focusTerm(page, 'last')
  await page.keyboard.type('show ip interface brief\r')
  await expect.poll(hop.termText).toMatch(/Loopback0/)
  await page.waitForTimeout(600)
  for (const { w, h } of NARROW) {
    await sizeTo(app, page, w, h)
    await focusTerm(page, 'last')
    await page.keyboard.press(`${mod}+ArrowUp`)
    const bar = page.getByTestId('block-toolbar')
    await expect(bar).toBeVisible()
    await assertFits(bar)
    await bar.getByRole('button', { name: 'Show as table' }).click()
    const table = page.getByTestId('block-table')
    await expect(table).toBeVisible()
    await page.waitForTimeout(200)
    await assertFits(table)
    // The filter has focus and the pane did not scroll sideways to reach it.
    await expect(table.getByRole('searchbox').or(table.getByPlaceholder(/Filter/)).first()).toBeFocused()
    await snapNarrow(page, 'n-block-table', w)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  }
})

test('narrow: config backups dialog with the AI panel and a split', async ({ hop }) => {
  const { app, page } = hop
  await sizeTo(app, page, 1100, 700)
  await hop.connect('core-sw1')
  await showSessions(page)
  const row = page.locator('[role=treeitem][data-row-key^="tree:"][aria-label="core-sw1"]')
  const backUp = async () => {
    await showSessions(page)
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Back up config/ }).click()
    await expect(page.getByText(/Backing up the running config/)).toHaveCount(0, { timeout: 30_000 })
    await page.waitForTimeout(300)
  }
  await backUp()
  await focusTerm(page, 'first')
  await page.keyboard.type('\r')
  await page.waitForTimeout(300)
  for (const l of ['configure terminal', 'interface GigabitEthernet1/0/2', 'description uplink to dist-eos1', 'end']) {
    await page.keyboard.type(`${l}\r`)
    await page.waitForTimeout(120)
  }
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
  await backUp()
  await split(hop, 'dist-eos1')
  await openAi(page)
  await page.evaluate(async () => {
    const h = window.hopline
    const { folders } = await h.sessions.list()
    const lab = folders.find((f) => f.name === 'Lab (simulator)')!
    await h.backups.saveSchedule({ kind: 'folder', target: lab.id, cadence: 'weekly', weekday: 1, time: '02:30', enabled: true })
  })
  for (const { w, h } of NARROW) {
    await sizeTo(app, page, w, h)
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Config history/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Config backups' })
    await dialog.getByRole('option').first().click()
    await expect(dialog.locator('.monaco-diff-editor')).toBeVisible()
    await page.waitForTimeout(600)
    await assertFits(dialog)
    await snapNarrow(page, 'n-backups', w)
    await dialog.getByRole('tab', { name: /Schedules/ }).click()
    await page.waitForTimeout(300)
    await assertFits(dialog)
    await snapNarrow(page, 'n-backups-schedules', w)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
})

test('narrow: multi-device dialog with the AI panel and a split', async ({ hop }) => {
  const { app, page } = hop
  await sizeTo(app, page, 1100, 700)
  await hop.connect('core-sw1')
  await split(hop, 'dist-eos1')
  await openAi(page)
  const open = async () => {
    await page.keyboard.press('Control+Shift+K')
    await page.getByRole('combobox', { name: 'Command palette' }).fill('>run on many')
    await page.getByRole('option', { name: /Run on many devices/ }).first().click()
    return page.getByRole('dialog', { name: 'Run on many devices' })
  }
  for (const { w, h } of NARROW) {
    await sizeTo(app, page, w, h)
    const dlg = await open()
    await dlg.getByRole('listbox', { name: 'Targets' }).getByRole('option', { name: /Lab \(simulator\)/ }).first().click()
    await dlg.getByLabel('Show command').fill('show version')
    await expect(dlg.getByTestId('multi-count')).toContainText('device')
    await assertFits(dlg)
    await snapNarrow(page, 'n-multi-compose', w)
    await dlg.getByRole('button', { name: /^Preview/ }).click()
    await expect(dlg.getByTestId('multi-counts')).toBeVisible()
    await assertFits(dlg)
    await dlg.getByRole('button', { name: /^Run on/ }).click()
    await expect(dlg.getByTestId('multi-progress')).toHaveText(/^(\d+) of \1 done$/, { timeout: 30_000 })
    await dlg.getByRole('tab', { name: 'Table' }).click()
    await page.waitForTimeout(300)
    await assertFits(dlg)
    await snapNarrow(page, 'n-multi-table', w)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
})
