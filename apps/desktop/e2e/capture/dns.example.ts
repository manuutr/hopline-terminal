import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchHopline, MOD, sizeWindow, stubDialogs } from '../fixtures'
import { picture } from './example-session'

test('identify the DNS response in the downloadable two-frame capture', async () => {
  const { app, page, dir } = await launchHopline({ production: true, waitFor: '' })
  try {
    await page.waitForFunction(() => performance.getEntriesByName('hopline:ready').length > 0)
    await page.evaluate(async () => {
      const api = window.hopline
      await api.settings.update({ updateAutoCheck: false, privacyReviewed: true })
      await api.ux.onboarding.set({ ...await api.ux.onboarding.get(), stepsDone: true, checklistDismissed: true })
    })
    await page.reload()
    await sizeWindow(app, page, 1360, 900)
    await stubDialogs(app, { open: resolve(__dirname, '../../../../docs/examples/dns-failure/name-error.pcap') })
    await page.keyboard.press(MOD + '+K')
    const palette = page.getByRole('combobox', { name: 'Command palette' })
    await palette.fill('Packet capture')
    await palette.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Packet capture' })
    await dialog.getByRole('button', { name: 'Open capture…' }).click()
    const frames = dialog.getByRole('table', { name: 'Captured frames' })
    await expect(frames.getByRole('row')).toHaveCount(3)
    await dialog.getByRole('textbox', { name: 'Wireshark display filter' }).fill('dns.flags.rcode > 0')
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(frames.getByRole('row')).toHaveCount(2)
    await frames.getByRole('button', { name: 'Inspect frame 2' }).click()
    await expect(frames).toContainText('192.0.2.53')
    await expect(dialog.getByRole('region', { name: 'Selected frame' })).toContainText('DNS response code 3')
    await picture(page, 'dns-failure', 'filtered-response', undefined, dialog)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
