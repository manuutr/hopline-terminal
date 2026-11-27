import type { Page } from '@playwright/test'
import { MOD, expect, test } from './fixtures'

type HopWindow = Window & {
  __hoplineTest: { text: (tabId?: string) => string }
  __hoplinePanes: { mounts: () => Record<string, number> }
}

const textOf = (page: Page, tabId: string) => page.evaluate((id) => (window as unknown as HopWindow).__hoplineTest.text(id), tabId)
const mounts = (page: Page) => page.evaluate(() => (window as unknown as HopWindow).__hoplinePanes.mounts())
const panes = (page: Page) => page.locator('[data-terminal-area] [data-pane-id]')
const focusedPane = (page: Page) => page.locator('[data-terminal-area] [data-pane-id][data-focused]')
const tabIdOf = async (page: Page, nth: number) => (await panes(page).nth(nth).getAttribute('data-tab-id'))!

/** Answer the password prompt if the keychain had no seeded credential, then wait for the prompt. */
async function login(page: Page, tabId: string, name: string) {
  const ready = new RegExp(`${name}[#>]\\s*$`)
  const pw = page.locator('[role=dialog] input[type=password]')
  await expect.poll(async () => (await pw.isVisible()) || ready.test(await textOf(page, tabId))).toBe(true)
  if (await pw.isVisible()) {
    await pw.fill('admin')
    await pw.press('Enter')
  }
  await expect.poll(() => textOf(page, tabId)).toMatch(ready)
}

/** Tag the xterm DOM node: if the terminal were ever remounted, the tag would be gone. */
const tagXterm = (page: Page, tabId: string) =>
  page.evaluate((id) => {
    const el = document.querySelector(`[data-terminal-container="${id}"] .xterm`) as (HTMLElement & { __tag?: string }) | null
    if (el) el.__tag = id
  }, tabId)
const xtermTagged = (page: Page, tabId: string) =>
  page.evaluate((id) => (document.querySelector(`[data-terminal-container="${id}"] .xterm`) as (HTMLElement & { __tag?: string }) | null)?.__tag === id, tabId)

test('split panes keep terminals alive, move focus, zoom, close and Ctrl+Tab', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  const core = await tabIdOf(page, 0)
  await page.keyboard.type('show ip interface brief\r')
  const marker = /GigabitEthernet1\/0\/2\s+10\.0\.0\.1/
  await expect.poll(() => textOf(page, core)).toMatch(marker)
  await expect.poll(() => textOf(page, core)).toMatch(/core-sw1#\s*$/)
  await tagXterm(page, core)

  // Split right (Mod+D) opens the "Connect to…" launcher in the new, focused pane.
  await page.keyboard.press(`${MOD}+D`)
  await expect(panes(page)).toHaveCount(2)
  const launcher = page.locator('[data-launcher] input')
  await expect(launcher).toBeFocused()
  await launcher.fill('no-such-lab-host')
  await expect(page.locator('[data-launcher]')).toContainText('No matching sessions.')
  await launcher.press('Escape')
  await expect(launcher).toHaveValue('')
  await expect(panes(page)).toHaveCount(2)
  await launcher.fill(String(hop.sims.eos.port))
  const target = page.locator('[data-launcher]').getByRole('option', { name: /dist-eos1/ })
  await expect(target).toContainText(`127.0.0.1:${hop.sims.eos.port}`)
  await page.locator('[data-launcher]').getByRole('button', { name: 'Clear session search' }).press('Enter')
  await expect(launcher).toBeFocused()
  await expect(launcher).toHaveValue('')
  await launcher.fill('dist-eos1')
  await page.keyboard.press('Enter')
  await expect.poll(() => tabIdOf(page, 1)).not.toBe('')
  const eos = await tabIdOf(page, 1)
  await login(page, eos, 'dist-eos1')

  // Both alive: the first still shows its earlier output and prompt (no reconnect, no remount).
  expect(await textOf(page, core)).toMatch(marker)
  expect(await textOf(page, core)).toMatch(/core-sw1#\s*$/)
  expect(await xtermTagged(page, core)).toBe(true)
  expect(await mounts(page)).toMatchObject({ [core]: 1, [eos]: 1 })
  await expect(page.getByRole('tab')).toHaveCount(1)
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName('dist-eos1')

  // Move focus left with Ctrl+Alt+Arrow; typing now goes to core-sw1, and the tab shows it.
  await expect(focusedPane(page)).toHaveAttribute('data-tab-id', eos)
  await page.keyboard.press('Control+Alt+ArrowLeft')
  await expect(focusedPane(page)).toHaveAttribute('data-tab-id', core)
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName('core-sw1')
  await page.keyboard.type('show ip interface brief\r')
  await expect.poll(async () => (await textOf(page, core)).match(new RegExp(marker, 'g'))?.length).toBe(2)
  expect(await textOf(page, eos)).not.toMatch(marker)

  // Fallback binding (Mod+Alt+Arrow = Ctrl+Shift+Alt+Arrow on Linux) moves back.
  await page.keyboard.press(`${MOD}+Alt+ArrowRight`)
  await expect(focusedPane(page)).toHaveAttribute('data-tab-id', eos)

  // Zoom and unzoom (Mod+Enter): the other pane is hidden, not remounted.
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(panes(page)).toHaveCount(1)
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(panes(page)).toHaveCount(2)

  // Close the focused pane (Mod+W, confirmed with Enter since it is connected): the tree collapses
  // back to core-sw1, still the same terminal, and the keyboard is back in it.
  await page.keyboard.press(`${MOD}+W`)
  await expect(page.getByRole('dialog', { name: 'Close dist-eos1?' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(panes(page)).toHaveCount(1)
  await expect(focusedPane(page)).toHaveAttribute('data-tab-id', core)
  await expect(page.locator(`[data-terminal-container="${core}"] textarea`)).toBeFocused()
  expect(await textOf(page, core)).toMatch(marker)
  expect(await xtermTagged(page, core)).toBe(true)
  expect((await mounts(page))[core]).toBe(1)

  // Ctrl+Tab: a second tab, then a quick tap flips back to the most recent one.
  await hop.connect('dist-eos1')
  await expect(page.getByRole('tab')).toHaveCount(2)
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName('dist-eos1')
  await page.keyboard.down('Control')
  await page.keyboard.press('Tab')
  await page.keyboard.up('Control')
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName('core-sw1')
  await expect(page.locator('[data-tab-cycler]')).toHaveCount(0)

  // Holding Ctrl shows the MRU overlay; releasing commits.
  await page.keyboard.down('Control')
  await page.keyboard.press('Tab')
  await expect(page.locator('[data-tab-cycler]')).toBeVisible()
  await page.keyboard.up('Control')
  await expect(page.locator('[data-tab-cycler]')).toHaveCount(0)
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName('dist-eos1')

  // Ctrl+Shift+Tab goes the other way (with two tabs: back to core-sw1), and core-sw1 survived it all.
  await page.keyboard.down('Control')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.up('Control')
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName('core-sw1')
  expect(await textOf(page, core)).toMatch(marker)
  expect((await mounts(page))[core]).toBe(1)
})

test('tab glyphs show config mode, and Mod+T reopens a closed tab', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.type('configure terminal\r')
  await expect(page.getByRole('tab', { selected: true }).locator('[data-glyph=config]')).toBeVisible()
  await page.keyboard.type('end\r')
  await expect(page.getByRole('tab', { selected: true }).locator('[data-glyph]')).toHaveCount(0)

  await page.keyboard.press(`${MOD}+W`)
  await page.getByRole('dialog', { name: 'Close core-sw1?' }).getByRole('button', { name: 'Close tab' }).click()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.locator('[data-launcher]')).toBeVisible()
  await page.keyboard.press(`${MOD}+T`)
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName('core-sw1')
  const id = await tabIdOf(page, 0)
  await login(page, id, 'core-sw1')
})

test('Mod+P goes to an open session instead of opening a duplicate', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await hop.connect('dist-eos1')
  await page.keyboard.press(`${MOD}+P`)
  await page.keyboard.type('core')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName('core-sw1')
  await expect(page.getByRole('tab')).toHaveCount(2)
})

test('dividers resize panes, clicking focuses a pane, tabs reorder by key and drag', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  const core = await tabIdOf(page, 0)
  await page.keyboard.press(`${MOD}+D`)
  await expect(panes(page)).toHaveCount(2)

  // Drag the divider from 3 px beside its 1 px line (inside the 8 px hit area).
  const sep = page.locator('[data-terminal-area] [role=separator]')
  const box = (await sep.boundingBox())!
  const before = (await panes(page).first().boundingBox())!.width
  await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2)
  await expect(sep).toHaveAttribute('data-separator', 'hover')
  await page.mouse.down()
  await expect(sep).toHaveAttribute('data-separator', 'active')
  await page.mouse.move(box.x + box.width / 2 + 103, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await panes(page).first().boundingBox())!.width).toBeGreaterThan(before + 80)
  const resized = (await panes(page).first().boundingBox())!.width
  expect((await mounts(page))[core]).toBe(1)

  // The new size is stored: splitting the other pane down keeps it.
  await page.keyboard.press(`${MOD}+E`)
  await expect(panes(page)).toHaveCount(3)
  await expect.poll(async () => Math.round((await panes(page).first().boundingBox())!.width)).toBe(Math.round(resized))

  // Clicking a pane focuses it, and the tab follows the focused pane's session.
  await page.locator(`[data-terminal-container="${core}"] .xterm`).click()
  await expect(focusedPane(page)).toHaveAttribute('data-tab-id', core)
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName('core-sw1')
  expect((await mounts(page))[core]).toBe(1)

  // Mod+PageUp/PageDown move the active tab.
  await hop.connect('dist-eos1')
  const names = () => page.getByRole('tab').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  expect(await names()).toEqual(['core-sw1', 'dist-eos1'])
  await page.keyboard.press(`${MOD}+PageUp`)
  await expect.poll(names).toEqual(['dist-eos1', 'core-sw1'])
  await page.keyboard.press(`${MOD}+PageDown`)
  await expect.poll(names).toEqual(['core-sw1', 'dist-eos1'])

  // Drag to reorder: past the 4 px threshold it moves the tab and does not activate it.
  // The key reorders update DOM order immediately. Wait for the tab faces to settle before
  // recording the two screen coordinates used by the raw pointer gesture.
  await page.getByRole('tab').first().hover({ trial: true })
  await page.getByRole('tab').nth(1).hover({ trial: true })
  const first = (await page.getByRole('tab').first().boundingBox())!
  const second = (await page.getByRole('tab').nth(1).boundingBox())!
  await page.mouse.move(first.x + 20, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(second.x + 20, second.y + second.height - 5, { steps: 10 })
  await page.mouse.up()
  await expect.poll(names).toEqual(['dist-eos1', 'core-sw1'])
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName('dist-eos1')
})
