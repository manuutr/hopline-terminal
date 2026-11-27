import { createServer, type Server } from 'node:net'
import { makeEosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import { expect, test } from './fixtures'

/**
 * Round 2: the Port forwarding dialog shows problems under the field (no toast), and a listening
 * local forward offers "Open" (in the browser, through the links IPC). The button is never clicked
 * here: that would open the user's real browser.
 */
let eos: RunningSim
let echo: Server
test.beforeAll(async () => {
  eos = await startSim({ device: makeEosDevice(), port: 0, forwarding: true })
  echo = createServer((s) => s.pipe(s))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
})
test.afterAll(async () => {
  await eos.close()
  echo.close()
})

test('port forwarding: inline field errors instead of toasts; a listening local forward offers Open', async ({ hop }) => {
  const { page } = hop
  await page.evaluate(async (port) => {
    await window.hopline.sessions.save({ folderId: null, name: 'eos-fwd-ui', host: '127.0.0.1', port, protocol: 'ssh', platform: 'eos', username: 'admin', credentialId: null, logToFile: false, notes: '', options: {} } as never)
  }, eos.port)
  await page.reload()
  await page.getByText('eos-fwd-ui', { exact: true }).first().dblclick()
  const pw = page.locator('[role=dialog] input[type=password]')
  await expect(pw).toBeVisible()
  await pw.fill('admin')
  await pw.press('Enter')
  await expect.poll(hop.termText).toMatch(/dist-eos1[#>]\s*$/)
  await page.getByRole('tab').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Port forwarding/ }).click()
  const dlg = page.getByRole('dialog', { name: 'Port forwarding' })

  // Nothing filled in: the destination fields say what is missing, and no toast appears.
  await dlg.getByRole('button', { name: 'Add and start' }).click()
  await expect(dlg.getByLabel(/To host/)).toHaveAttribute('aria-invalid', 'true')
  await expect(dlg.getByText('Enter the host to reach.')).toBeVisible()
  await expect(dlg.locator('#fwd-dport')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
  // Fixing the field clears its error as you type.
  await dlg.getByLabel(/To host/).fill('127.0.0.1')
  await expect(dlg.getByText('Enter the host to reach.')).toHaveCount(0)
  await dlg.locator('#fwd-dport').fill(String((echo.address() as { port: number }).port))
  await dlg.getByRole('button', { name: 'Add and start' }).click()
  const row = dlg.getByRole('list', { name: 'Forwards' }).getByRole('listitem').first()
  await expect(row).toContainText('Listening')
  await expect(row.getByRole('button', { name: /in the browser$/ })).toBeVisible()
})
