import { join } from 'node:path'
import { expect, MOD, showSessions, sizeWindow, test } from './fixtures'

// Manual phase evidence. The usual e2e suite skips screenshot generation.
test('polish phase capture', async ({ hop }) => {
  const name = process.env['HOPLINE_POLISH_CAPTURE']
  test.skip(!name)
  const { page } = hop
  if (name?.includes('accessibility')) {
    await page.evaluate(() => window.hopline.settings.update({ theme: 'contrast', reduceMotion: true }))
    await page.reload()
  }
  await hop.connect('core-sw1')
  await page.keyboard.type('show interfaces status')
  await page.keyboard.press('Enter')
  await expect.poll(hop.termText).toContain('Duplex')
  await showSessions(page)
  if (name?.includes('terminal')) {
    await sizeWindow(hop.app, page, 1000, 680)
    await page.keyboard.press(`${MOD}+I`)
  }
  if (name?.includes('states')) await page.getByPlaceholder('Search', { exact: true }).fill('floor-24')
  if (name?.includes('palette')) await page.keyboard.press(`${MOD}+K`)
  if (name?.includes('assistant')) await page.keyboard.press(`${MOD}+I`)
  if (name?.includes('foundation')) {
    await page.keyboard.press(`${MOD}+Comma`)
    const row = page.locator('[data-setting-key="theme"]')
    await row.scrollIntoViewIfNeeded()
  }
  if (name?.includes('accessibility')) {
    await page.keyboard.press(MOD + '+I')
    await page.getByRole('region', { name: 'Suggested questions' }).getByRole('button').first().focus()
  }
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(__dirname, '../../../docs/design/polish', name + '.png') })
})
