import { treeRow, expect, showSessions, test } from './fixtures'

test('connection details, address copy and clearing an empty search', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.getByRole('button', { name: 'Connection details for core-sw1' }).click()
  const pop = page.getByRole('dialog', { name: 'Connection details for core-sw1' })
  await expect(pop).toContainText('Authenticated')
  await expect(pop).toContainText('UTF-8')
  await page.keyboard.press('Escape')
  const copy = page.getByRole('button', { name: /^Copy connection address / })
  const address = await copy.innerText()
  await copy.click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hoplineTest: { clipboard: { get(): string } } }).__hoplineTest.clipboard.get())).toBe(address)
  await showSessions(page)
  await page.getByPlaceholder('Search', { exact: true }).fill('missing-device')
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(treeRow(page, 'core-sw1').first()).toBeVisible()
})
