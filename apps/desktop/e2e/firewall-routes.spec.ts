import { MOD, expect, sizeWindow, test } from './fixtures'

test('investigate a site VPN across FortiOS and PAN-OS and copy the scoped route evidence', async ({ hop }) => {
  const { page } = hop
  const palette = page.getByRole('combobox', { name: 'Command palette' })
  await page.keyboard.press(`${MOD}+K`)
  await palette.fill('Open the simulator lab')
  await page.getByRole('option', { name: /Open the simulator lab/ }).click()
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)

  await page.keyboard.press(`${MOD}+K`)
  await palette.fill('#vpn-lab')
  await page.getByRole('option', { name: /#vpn-lab/ }).click()
  await page.getByRole('option', { name: /Run a show command on these 2/ }).click()
  const dlg = page.getByRole('dialog', { name: 'Run on many devices' })
  const preview = async (command: string) => {
    await dlg.getByLabel('Show command').fill(command)
    await dlg.getByRole('button', { name: /^Preview/ }).click()
    await expect(dlg.getByTestId('multi-counts')).toContainText('2 read-only')
  }
  const run = async () => {
    await dlg.getByRole('button', { name: 'Run on 2' }).click()
    for (const name of ['fw1', 'fgt-edge1']) {
      await expect(dlg.locator(`[data-target="${name}"][role=option]`)).toHaveAttribute('data-status', 'ok')
    }
  }
  await dlg.getByLabel('Show command').fill('show routing route virtual-router default')
  await dlg.getByRole('button', { name: /^Preview/ }).click()
  await expect(dlg.locator('tr[data-target="fgt-edge1"]')).not.toContainText('get router info routing-table all')
  await dlg.getByRole('button', { name: 'Back' }).click()
  await preview('show vpn flow')
  await expect(dlg.locator('tr[data-target="fgt-edge1"]')).toContainText('get vpn ipsec tunnel summary')
  await run()
  await dlg.getByRole('option', { name: /fgt-edge1/ }).click()
  await expect(dlg.getByTestId('multi-output')).toContainText('selectors(total,up): 1/1')
  await dlg.getByRole('option', { name: /fw1/ }).click()
  await expect(dlg.getByTestId('multi-output')).toContainText(/to-branch\s+active/)

  await dlg.getByRole('button', { name: 'New run' }).click()
  await preview('show routing route')
  await expect(dlg.locator('tr[data-target="fgt-edge1"]')).toContainText('get router info routing-table all')
  await run()
  await sizeWindow(hop.app, page, 900, 640)
  await dlg.getByRole('tab', { name: 'Output' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(dlg.getByRole('tab', { name: 'Compare' })).toBeFocused()
  await page.keyboard.press('End')
  await expect(dlg.getByRole('tabpanel', { name: 'Table' })).toBeVisible()
  const grip = dlg.getByRole('button', { name: 'Resize results viewer' })
  await grip.focus()
  const original = (await dlg.boundingBox())!
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(async () => (await dlg.boundingBox())!.width).toBeLessThan(original.width - 40)
  await page.keyboard.press('Home')
  await expect.poll(async () => Math.abs((await dlg.boundingBox())!.width - original.width)).toBeLessThan(2)
  await dlg.getByRole('radio', { name: 'All 2' }).click()
  const lookup = dlg.getByRole('textbox', { name: 'Destination IPv4' })
  await lookup.fill('10.100.')
  await expect(lookup).toHaveAttribute('aria-invalid', 'true')
  await lookup.fill('10.100.0.10')
  await expect(dlg.getByRole('status')).toContainText('3 matching paths · 1 via default route')
  const paths = dlg.getByRole('table', { name: 'Parsed table, all devices' })
  const branchFallback = paths.getByRole('row').filter({ hasText: 'fgt-edge1' }).filter({ hasText: '0.0.0.0/0' })
  await expect(branchFallback.getByRole('cell', { name: '10', exact: true })).toBeVisible()
  await expect(branchFallback.getByRole('cell', { name: 'port1', exact: true })).toBeVisible()
  await dlg.getByRole('button', { name: 'Clear lookup' }).click()
  await expect(lookup).toHaveValue('')
  await expect(lookup).toBeFocused()
  await dlg.getByRole('textbox', { name: 'Filter rows' }).fill('10.100.0.0/24')
  const table = dlg.getByRole('table', { name: 'Parsed table, all devices' })
  await expect(table.locator('tbody tr')).toHaveCount(2)
  await expect(table.getByRole('row').filter({ hasText: 'fgt-edge1' })).toContainText('vlan100')
  await dlg.getByRole('button', { name: 'CSV' }).click()
  const clipboard = () => page.evaluate(() => (window as unknown as { __hoplineTest: { clipboard: { get(): string } } }).__hoplineTest.clipboard.get())
  await expect.poll(clipboard).toContain('fgt-edge1,FortiOS,20,10.100.0.0/24')
  await expect.poll(clipboard).toContain('fw1,PAN-OS,default,10.100.0.0/24')
  expect(await clipboard()).not.toContain('0.0.0.0/0')

  await dlg.getByRole('button', { name: 'Done' }).click()
  await page.keyboard.press(`${MOD}+K`)
  await palette.fill('Reopen last multi-device results')
  await page.getByRole('option', { name: /Reopen last multi-device results/ }).click()
  await dlg.getByRole('button', { name: 'Copy run report' }).click()
  const report = await clipboard()
  for (const field of ['Device: fgt-edge1', 'Device: fw1', 'Platform: Fortinet FortiOS', 'Platform: Palo Alto PAN-OS', 'get router info routing-table all', 'show routing route', 'vlan100']) {
    expect(report).toContain(field)
  }
  expect(report.match(/Result: ok/g)).toHaveLength(2)

  const attempts = await page.evaluate(() => window.hopline.audit.list(100))
  expect(attempts.filter((r) => r.source === 'multi').map((r) => [r.sessionName, r.command, r.decision]).sort()).toEqual([
    ['fgt-edge1', 'get router info routing-table all', 'executed'],
    ['fgt-edge1', 'get vpn ipsec tunnel summary', 'executed'],
    ['fw1', 'show routing route', 'executed'],
    ['fw1', 'show vpn flow', 'executed']
  ])
  expect(hop.llm.anthropic.requests.filter((r) => r.path.includes('/messages'))).toHaveLength(0)
  expect(hop.llm.ollama.requests.filter((r) => r.path.includes('/api/chat') || r.path.includes('/api/generate'))).toHaveLength(0)
})
