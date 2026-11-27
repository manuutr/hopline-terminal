import { expect, MOD, test } from './fixtures'

test('high contrast and reduced motion persist and reach an open terminal', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.press(`${MOD}+Comma`)
  await page.getByRole('radio', { name: 'High contrast', exact: true }).click()
  await page.getByRole('switch', { name: 'Reduce motion', exact: true }).click()
  await page.getByRole('tab', { name: 'Terminal', exact: true }).click()
  await page.getByRole('switch', { name: 'Font ligatures', exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'contrast')
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', '')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hoplineTest: { options(): { cursorBlink: boolean } } }).__hoplineTest.options().cursorBlink)).toBe(false)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'contrast')
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', '')
})
