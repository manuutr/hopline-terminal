import { expect, showSessions, test } from './fixtures'

test('fuzzy search, persistent session order and dragging a live tab to split', async ({ hop }) => {
  const { page } = hop
  await page.locator('#session-search').fill('crsw')
  await expect(page.getByRole('treeitem', { name: 'core-sw1', exact: true }).locator('mark').first()).toBeVisible()
  await page.locator('#session-search').fill('')
  const order = () => page.locator('[data-row-key^="tree:s:"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('aria-label')))
  const before = await order()
  await page.getByRole('treeitem', { name: before[0]!, exact: true }).focus()
  await page.keyboard.press('Alt+Shift+ArrowDown')
  await expect.poll(order).toEqual([before[1], before[0], ...before.slice(2)])
  await page.reload()
  await expect.poll(order).toEqual([before[1], before[0], ...before.slice(2)])
  await hop.connect('core-sw1')
  await hop.connect('dist-eos1')
  const tab = page.getByRole('tab', { name: 'core-sw1', exact: true })
  const pane = page.locator('[data-pane-id][data-focused]')
  const source = (await tab.boundingBox())!
  const target = (await pane.boundingBox())!
  await page.mouse.move(source.x + 20, source.y + 12)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width * .8, target.y + 60, { steps: 10 })
  await page.mouse.up()
  await expect(page.getByRole('tablist', { name: 'Open connections' }).getByRole('tab')).toHaveCount(1)
  await expect(page.locator('[data-pane-id] .xterm:visible')).toHaveCount(2)
  await showSessions(page)
})
