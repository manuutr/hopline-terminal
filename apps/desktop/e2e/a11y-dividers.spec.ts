import type { Locator, Page } from '@playwright/test'
import { MOD, expect, showSessions, test } from './fixtures'

/**
 * Keyboard-resizable dividers (Phase 6 accessibility pack): every splitter is a focusable
 * separator with a name and aria-valuenow; arrows nudge, Shift+arrows jump, Home/End go to either
 * end (collapsing a collapsible panel), Enter collapses and restores; sizes are remembered.
 */

const width = async (l: Locator) => (await l.boundingBox())?.width ?? 0
const now = async (sep: Locator) => Number(await sep.getAttribute('aria-valuenow'))

async function login(page: Page, name: string, text: () => Promise<string>) {
  const ready = new RegExp(`${name}[#>]\\s*$`)
  const pw = page.locator('[role=dialog] input[type=password]')
  await expect.poll(async () => (await pw.isVisible()) || ready.test(await text())).toBe(true)
  if (await pw.isVisible()) {
    await pw.fill('admin')
    await pw.press('Enter')
  }
  await expect.poll(text).toMatch(ready)
}

test('sidebar and assistant dividers: arrows, Shift+arrows, Home/End, Enter, remembered after a reload', async ({ hop }) => {
  const { page } = hop
  const sep = page.getByRole('separator', { name: 'Resize session sidebar' })
  const sidebar = page.locator('#sidebar')
  await expect(sep).toHaveAttribute('aria-valuenow', /\d/)
  await sep.focus()
  await expect(sep).toBeFocused()
  // The ring is drawn (the global :focus-visible outline, or the accent fill).
  expect(await sep.evaluate((el) => getComputedStyle(el).outlineStyle !== 'none' || getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)')).toBe(true)

  const w0 = await width(sidebar)
  const v0 = await now(sep)
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => width(sidebar)).toBeGreaterThan(w0 + 10)
  const w1 = await width(sidebar)
  expect(w1 - w0).toBeLessThan(24)
  await expect.poll(() => now(sep)).toBeGreaterThan(v0)
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(() => width(sidebar)).toBeGreaterThan(w1 + 60)
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => width(sidebar)).toBeLessThan(w0 + 2)

  // End: as wide as it goes (480 px); Home: collapsed, and the toggle agrees. End brings it back.
  await page.keyboard.press('End')
  await expect.poll(() => width(sidebar)).toBeGreaterThan(470)
  await page.keyboard.press('Home')
  await expect.poll(() => width(sidebar)).toBeLessThan(2)
  await expect(page.getByRole('button', { name: 'Toggle session sidebar' })).toHaveAttribute('aria-pressed', 'false')
  // Collapsed, the divider is still a tab stop (that is how the keyboard gets the panel back).
  await expect(sep).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => width(sidebar)).toBeGreaterThan(170)
  await expect(page.getByRole('button', { name: 'Toggle session sidebar' })).toHaveAttribute('aria-pressed', 'true')
  // Restored to its last open size (or the minimum); then a large step from there.
  const restored = await width(sidebar)
  if (restored > 400) {
    await page.keyboard.press('Shift+ArrowLeft')
    await expect.poll(() => width(sidebar)).toBeLessThan(restored - 60)
  } else {
    await page.keyboard.press('Shift+ArrowRight')
    await expect.poll(() => width(sidebar)).toBeGreaterThan(restored + 60)
  }
  const kept = await width(sidebar)

  // The assistant's divider: Enter opens the collapsed panel; Left widens it (the divider moves left).
  const aiSep = page.getByRole('separator', { name: 'Resize assistant panel' })
  const ai = page.locator('#ai')
  await aiSep.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => width(ai)).toBeGreaterThan(290)
  const a0 = await width(ai)
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => width(ai)).toBeGreaterThan(a0 + 60)
  const aiKept = await width(ai)

  // Remembered: a reload brings back both widths.
  await page.waitForTimeout(300)
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await expect.poll(() => width(sidebar)).toBeGreaterThan(kept - 3)
  expect(await width(sidebar)).toBeLessThan(kept + 3)
  await page.keyboard.press(`${MOD}+I`)
  await expect.poll(() => width(ai)).toBeGreaterThan(aiKept - 3)
  expect(await width(ai)).toBeLessThan(aiKept + 3)
})

test('pane dividers resize from the keyboard and the size survives a zoom (it is kept in the layout)', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.press(`${MOD}+D`)
  const launcher = page.locator('[data-launcher] input')
  await expect(launcher).toBeFocused()
  await launcher.fill('dist-eos1')
  await page.keyboard.press('Enter')
  await login(page, 'dist-eos1', hop.termText)
  const panes = page.locator('[data-terminal-area] [data-pane-id]')
  await expect(panes).toHaveCount(2)
  const sep = page.getByRole('separator', { name: 'Resize panes left and right' })
  await expect(sep).toHaveAttribute('aria-valuenow', /^(49|50|51)/)
  await sep.focus()
  const p0 = await width(panes.first())
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => width(panes.first())).toBeLessThan(p0 - 60)
  await page.keyboard.press('ArrowLeft')
  const p1 = await width(panes.first())
  await expect.poll(() => now(sep)).toBeLessThan(45)
  // Zoom and unzoom remounts the split from the stored sizes: the new width is kept.
  await panes.nth(1).click()
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(panes).toHaveCount(1)
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(panes).toHaveCount(2)
  await expect.poll(() => width(panes.first())).toBeLessThan(p1 + 3)
  expect(await width(panes.first())).toBeGreaterThan(p1 - 3)
  // Home: the left pane at its minimum (PANE_MIN 180 px).
  await sep.focus()
  await page.keyboard.press('Home')
  await expect.poll(() => width(panes.first())).toBeLessThan(200)
  expect(await width(panes.first())).toBeGreaterThanOrEqual(179)
})

test('files panel divider: Up/Down resize, Enter collapses it', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.press(`${MOD}+J`)
  const files = page.getByRole('region', { name: 'Files' })
  await expect(files).toBeVisible()
  const sep = page.getByRole('separator', { name: 'Resize files panel' })
  const panel = page.locator('#files')
  const h = async () => (await panel.boundingBox())?.height ?? 0
  const h0 = await h()
  await sep.focus()
  await page.keyboard.press('Shift+ArrowUp')
  await expect.poll(h).toBeGreaterThan(h0 + 60)
  await page.keyboard.press('Enter')
  await expect(files).toHaveCount(0)
  await showSessions(page)
})
