import { expect, MOD, test } from './fixtures'

test('palette finds a live command block and opens a setting directly', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.type('show interfaces status\r')
  await expect.poll(() => page.evaluate(() => {
    const { blocks } = (window as unknown as { __hoplineTest: { blocks: () => { command: string }[] } }).__hoplineTest
    return blocks().map((block) => block.command)
  })).toContain('show interfaces status')
  await page.keyboard.press(`${MOD}+K`)
  const search = page.getByRole('combobox', { name: 'Command palette' })
  await search.fill('show interfaces status')
  await expect(page.getByRole('option', { name: /show interfaces status.*Insert/ })).toBeVisible()
  await search.fill('reduce motion')
  await page.getByRole('option', { name: /Reduce motion.*Appearance/ }).click()
  await expect(page.getByRole('switch', { name: 'Reduce motion' })).toBeFocused()
})

test('Quick Connect history can be selected with the arrow keys', async ({ hop }) => {
  const { page } = hop
  await page.evaluate(() => localStorage.setItem('hopline.quickEndpoints', JSON.stringify(['ssh://admin@core-sw1:22', 'telnet://lab-switch:23'])))
  await page.keyboard.press(MOD + '+O')
  const input = page.getByRole('textbox', { name: 'Quick connect' })
  await input.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('button', { name: 'telnet://lab-switch:23' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('telnet://lab-switch:23')
})
