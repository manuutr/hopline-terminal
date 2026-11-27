import { test, expect } from '@playwright/test'
import { makeFirewallLab } from '../../../../packages/simulator/src/index.ts'
import { MOD } from '../fixtures'
import { picture, withDevices } from './example-session'

test('find the return route in the wrong VRF across two firewalls', async () => {
  const devices = makeFirewallLab()
  await withDevices('Site firewalls', [
    { name: 'Branch FortiGate', platform: 'fortios', device: devices.fortios },
    { name: 'DC Palo Alto', platform: 'panos', device: devices.panos }
  ], async page => {
    await page.keyboard.press(MOD + '+K')
    const palette = page.getByRole('combobox', { name: 'Command palette' })
    await palette.fill('#Site firewalls')
    await page.getByRole('option', { name: /^Site firewalls/ }).click()
    await page.getByRole('option', { name: /Run a show command on these 2/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Run on many devices' })
    const snap = (name: string, height: number) => picture(page, 'vpn-return-path', name, height, dialog)
    const run = async (command: string) => {
      await dialog.getByLabel('Show command').fill(command)
      await dialog.getByRole('button', { name: /^Preview/ }).click()
      await expect(dialog.getByTestId('multi-counts')).toContainText('2 read-only')
      if (command === 'show vpn flow') await snap('01-command-preview', 390)
      await dialog.getByRole('button', { name: 'Run on 2' }).click()
      for (const name of ['Branch FortiGate', 'DC Palo Alto']) {
        await expect(dialog.locator('[data-target="' + name + '"][role=option]')).toHaveAttribute('data-status', 'ok')
      }
    }
    await run('show vpn flow')
    await dialog.getByRole('option', { name: /DC Palo Alto/ }).click()
    await expect(dialog.getByTestId('multi-output')).toContainText(/to-branch\s+active/)
    await snap('02-palo-alto-sa', 370)
    await dialog.getByRole('option', { name: /Branch FortiGate/ }).click()
    await expect(dialog.getByTestId('multi-output')).toContainText('selectors(total,up): 1/1')
    await snap('03-fortigate-selectors', 370)
    await dialog.getByRole('button', { name: 'New run' }).click()
    await run('show routing route')
    await dialog.getByRole('tab', { name: 'Table' }).click()
    await dialog.getByRole('radio', { name: 'All 2' }).click()
    const lookup = dialog.getByRole('textbox', { name: 'Destination IPv4' })
    const rows = dialog.getByRole('table', { name: 'Parsed table, all devices' })
    await lookup.fill('10.20.0.50')
    await expect(rows.getByRole('row').filter({ hasText: 'DC Palo Alto' })).toContainText('tunnel.1')
    await snap('04-forward-lookup', 390)
    await lookup.fill('10.100.0.10')
    await expect(dialog.getByRole('status')).toContainText('3 matching paths')
    const grip = dialog.getByRole('button', { name: 'Resize results viewer' })
    await grip.focus()
    await grip.press('End')
    const branchRows = rows.getByRole('row').filter({ hasText: 'Branch FortiGate' })
    await expect(branchRows.filter({ hasText: '0.0.0.0/0' })).toContainText('port1')
    await expect(branchRows.filter({ hasText: 'vlan100' })).toContainText('20')
    await snap('05-return-lookup', 380)
  })
})
