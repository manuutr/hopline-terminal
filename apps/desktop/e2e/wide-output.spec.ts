import { expect, MOD, showSessions, sizeWindow, test } from './fixtures'

test('fixed-width table survives a narrow pane, wrap toggle and return to the wide pane', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.type('show interfaces status\r')
  await expect.poll(hop.termText).toContain('Duplex')
  await showSessions(page)
  await sizeWindow(hop.app, page, 1000, 680)
  await page.keyboard.press(`${MOD}+I`)
  const grid = page.locator('.terminal-grid:visible')
  const wrap = page.getByRole('button', { name: /columns · Wrap/ })
  await expect(wrap).toBeVisible()
  await expect.poll(() => grid.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await expect.poll(hop.termText).toMatch(/Port[^\n]+Duplex[^\n]+Type/)
  await wrap.click()
  await expect(page.getByRole('button', { name: 'Fit columns' })).toBeVisible()
  await expect.poll(() => grid.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await page.getByRole('button', { name: 'Fit columns' }).click()
  await expect.poll(hop.termText).toMatch(/Port[^\n]+Duplex[^\n]+Type/)
  await page.keyboard.press(`${MOD}+I`)
  await sizeWindow(hop.app, page, 1440, 900)
  await expect(wrap).toBeHidden()
})
