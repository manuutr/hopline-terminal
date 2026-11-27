import { MOD, expect, sizeWindow, test } from './fixtures'

/**
 * The frameless title bar (0.6): only empty bar space drags the window. A tab or a button inside a
 * drag region would swallow real mouse clicks on Windows and Linux (synthesized test clicks would
 * still pass), so the computed app-region is asserted directly.
 */
test('title bar keeps its drag region and window controls, with all connections in the sidebar', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  const region = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
  expect(await region('[data-titlebar]')).toBe('drag')
  await expect(page.locator('[data-titlebar] [role=tab]')).toHaveCount(0)
  await expect(page.locator('#sidebar').getByRole('tab', { name: 'core-sw1' })).toBeVisible()
  for (const name of ['Toggle session sidebar', 'Split right', 'Go to session', 'Toggle assistant']) {
    expect(await page.getByRole('button', { name }).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
  }
  // Windows/Linux draw their own window controls (macOS keeps the traffic lights).
  if (process.platform !== 'darwin') {
    for (const name of ['Minimize', 'Maximize', 'Close window']) {
      await expect(page.getByRole('button', { name })).toBeVisible()
      expect(await page.getByRole('button', { name }).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
    }
  }
})

test('connecting keeps the sidebar open, with existing connections selectable by pointer and keyboard', async ({ hop }) => {
  const { page } = hop
  const toggle = page.getByRole('button', { name: 'Toggle session sidebar' })
  const list = page.locator('#sidebar').getByRole('tablist', { name: 'Open connections' })
  await hop.connect('core-sw1')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(list).toHaveAttribute('aria-orientation', 'vertical')
  await hop.connect('dist-eos1')
  const core = list.getByRole('tab', { name: 'core-sw1' })
  const dist = list.getByRole('tab', { name: 'dist-eos1' })
  await expect(dist).toHaveAttribute('aria-selected', 'true')
  await core.click()
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
  await core.focus()
  await page.keyboard.press('ArrowDown')
  await expect(dist).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(hop.termText).toMatch(/dist-eos1#\s*$/)
  await expect(list.getByRole('tab')).toHaveCount(2)
  await dist.locator('[data-tab-close]').click()
  await page.getByRole('dialog', { name: 'Close dist-eos1?' }).getByRole('button', { name: 'Close tab' }).click()
  await expect(core).toHaveAttribute('aria-selected', 'true')
  await expect(list.getByRole('tab')).toHaveCount(1)
})

test('closing the last connection and reopening it respect a manually collapsed sidebar', async ({ hop }) => {
  const { page } = hop
  const toggle = page.getByRole('button', { name: 'Toggle session sidebar' })
  await hop.connect('core-sw1')
  await page.keyboard.press(`${MOD}+B`)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => page.locator('#sidebar').evaluate((el) => el.getBoundingClientRect().width)).toBe(0)
  await toggle.focus()
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.closest('[inert]') === null)).toBe(true)
  }
  await page.keyboard.press(`${MOD}+W`)
  await page.getByRole('dialog', { name: 'Close core-sw1?' }).getByRole('button', { name: 'Close tab' }).click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press(`${MOD}+T`)
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press(`${MOD}+B`)
  await expect(page.locator('#sidebar').getByRole('tab', { name: 'core-sw1' })).toBeVisible()
})

test('sidebar geometry: the tag chips take their own row above the tree, even with the tree scrolled', async ({ hop }) => {
  const { page } = hop
  await page.evaluate(async () => {
    const h = (window as unknown as { hopline: { sessions: { save: (s: unknown) => Promise<{ id: string }>; bulkUpdate: (ids: string[], p: unknown) => Promise<unknown> } } }).hopline
    const ids: string[] = []
    for (let i = 0; i < 40; i++) {
      const s = await h.sessions.save({ folderId: null, name: `leaf-${String(i).padStart(2, '0')}`, host: '10.0.0.1', port: 22, protocol: 'ssh', platform: 'iosxe', username: 'admin', credentialId: null, logToFile: false, notes: '', options: {} })
      ids.push(s.id)
    }
    await h.sessions.bulkUpdate(ids, { addTags: ['prod', 'core', 'firewall', 'lab', 'wan'] })
  })
  await page.reload()
  const chips = page.locator('[data-tag-filter]')
  await expect(chips.getByRole('button', { name: 'wan' })).toBeVisible()
  await page.locator('[data-tree-scroller]').evaluate((el) => (el.scrollTop = el.scrollHeight / 2))
  const g = await page.evaluate(() => {
    const c = document.querySelector('[data-tag-filter]') as HTMLElement
    const t = document.querySelector('[data-tree-scroller]') as HTMLElement
    return { chipsBottom: c.getBoundingClientRect().bottom, treeTop: t.getBoundingClientRect().top, clipped: c.scrollHeight - c.clientHeight }
  })
  // The chip row is not squeezed (nothing clipped inside it) and ends before the tree starts.
  expect(g.clipped).toBeLessThanOrEqual(0)
  expect(g.chipsBottom).toBeLessThanOrEqual(g.treeTop + 0.5)
  // A gap and, once scrolled, a hairline separate the chips from the clipped first row.
  expect(g.treeTop - g.chipsBottom).toBeGreaterThanOrEqual(4)
  await expect(page.locator('[data-tree-scroller]')).toHaveAttribute('data-scrolled', '')
  expect(await page.locator('[data-tree-scroller]').evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe('rgba(0, 0, 0, 0)')
})

test('the active connection has a selection marker on the leading edge of its row', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  const row = (await page.getByRole('tab', { selected: true }).boundingBox())!
  const marker = (await page.locator('[data-selection-face=tab]').boundingBox())!
  expect(marker.x).toBeCloseTo(row.x)
  expect(marker.width).toBe(3)
  expect(marker.height).toBeGreaterThan(12)
  expect(marker.y).toBeGreaterThan(row.y)
  expect(marker.y + marker.height).toBeLessThan(row.y + row.height)
})

test('a short window keeps saved sessions reachable while the open list scrolls', async ({ hop }) => {
  const { page } = hop
  await sizeWindow(hop.app, page, 900, 560)
  for (let i = 0; i < 7; i++) await hop.connect(i % 2 ? 'dist-eos1' : 'core-sw1')
  const list = page.getByRole('tablist', { name: 'Open connections' })
  await expect(list.getByRole('tab')).toHaveCount(7)
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await expect(list.getByRole('tab', { selected: true })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('textbox', { name: /Search sessions by name/ })).toBeInViewport()
  await list.getByRole('tab', { selected: true }).press('Home')
  await expect(list.getByRole('tab').first()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(list.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true')
  await expect(list.getByRole('tab').first()).toBeInViewport({ ratio: 1 })
})
